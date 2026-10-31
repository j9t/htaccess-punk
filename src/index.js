import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;

// What `apr_isspace()` matches; `\s` would also match Unicode spaces
const SPACES = '\t\n\v\f\r ';
const TRIM_RE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const URL_RE = /^https?:\/\/./i;
// Resolved from the server config or environment, which a `.htaccess` file doesn’t reveal
const CONFIG_VAR_RE = /\$\{[^}]*\}/;
// What an `ap_expr` string expands (variables, backreferences), unescapes, or may end at
const EXPR_SPECIAL_RE = /%\{|\$\d|[\\"']/;
const REDIRECT_KEYWORDS = new Set(['permanent', 'temp', 'seeother']);
// What `ap_is_url()` accepts as a scheme
const URL_SCHEME_RE = /^[a-z0-9+.-]+:/i;
// `RewriteRule` flags that drop the substitution
const NOSUB_FLAGS = new Set(['f', 'forbidden', 'g', 'gone']);
// Argument counts as declared by mod_alias (`TAKE123`, `TAKE23`, `TAKE2`)
const ALIAS_DIRECTIVES = new Map([
  ['redirect', { name: 'Redirect', arity: 'one, two, or three arguments', min: 1, max: 3, isRegex: false }],
  ['redirectmatch', { name: 'RedirectMatch', arity: 'two or three arguments', min: 2, max: 3, isRegex: true }],
  ['redirectpermanent', { name: 'RedirectPermanent', arity: 'two arguments', min: 2, max: 2, isRegex: false }],
  ['redirecttemp', { name: 'RedirectTemp', arity: 'two arguments', min: 2, max: 2, isRegex: false }],
]);

async function collectFrom(dir, entries, onWarn) {
  const files = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath, onWarn));
    } else if (entry.name === '.htaccess') {
      files.push(fullPath);
    }
  }

  return files;
}

// Report and skip an unreadable subdirectory so one locked folder can’t take
// down the scan; a vanished one (`ENOENT`) is a race the caller can’t act on
async function walk(dir, onWarn) {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') onWarn?.({ dir, err });
    return [];
  }

  return collectFrom(dir, entries, onWarn);
}

// The root rejects where a subdirectory only warns; the error keeps its `code`
export async function findHtaccessFiles(dir, { onWarn } = {}) {
  const dirResolved = resolve(dir);
  const entries = await readdir(dirResolved, { withFileTypes: true });
  return collectFrom(dirResolved, entries, onWarn);
}

const isSpace = char => !!char && SPACES.includes(char);
const isDigit = char => char >= '0' && char <= '9';
const isRedirectStatus = status => status >= 300 && status < 400;
// Marks a directive Apache rejects, which makes it fail the whole file
const invalid = reason => ({ reason });

// Mirrors `ap_cfg_getline()`: a backslash right before a line break joins the
// next line (dropping both), and each line is trimmed; `line` is where it starts
function readLines(content) {
  const lines = [];
  const physical = content.split('\n');
  let pending = '';
  let start = null;

  physical.forEach((line, i) => {
    start ??= i + 1;
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (i < physical.length - 1 && body.endsWith('\\')) {
      pending += body.slice(0, -1);
    } else {
      lines.push({ text: (pending + line).replace(TRIM_RE, ''), line: start });
      pending = '';
      start = null;
    }
  });

  return lines;
}

// Mirrors `ap_getword_conf()`; returns the word and the index past it and any
// following whitespace
function readWord(line, start) {
  const quote = line[start];
  let i = start;
  let word = '';

  if (quote === '"' || quote === "'") {
    for (i++; i < line.length && line[i] !== quote; i++) {
      if (line[i] === '\\' && (line[i + 1] === quote || line[i + 1] === '\\')) i++;
      word += line[i];
    }
    // An unclosed quote runs to the end of the line
    if (line[i] === quote) i++;
  } else {
    for (; i < line.length && !isSpace(line[i]); i++) {
      if (line[i] === '\\' && line[i + 1] === '\\') i++;
      word += line[i];
    }
  }

  while (isSpace(line[i])) i++;
  return [word, i];
}

function readWords(line, start) {
  const words = [];
  for (let i = start; i < line.length;) {
    const [word, next] = readWord(line, i);
    words.push(word);
    i = next;
  }
  return words;
}

// Mirrors `add_redirect_internal()` in mod_alias, in the per-directory context
// of a `.htaccess` file
function aliasTarget(args, { name, arity, min, max, isRegex }) {
  if (args.length < min || args.length > max || args.slice(0, min).includes('')) return invalid(`${name} takes ${arity}`);

  const [arg1, arg2, arg3] = args;
  const keyword = arg1.toLowerCase();
  // 1 for a redirect status, -1 for another status, 0 for none
  let statusKind = 0;
  if (REDIRECT_KEYWORDS.has(keyword)) statusKind = 1;
  else if (keyword === 'gone') statusKind = -1;
  else if (isDigit(arg1[0])) statusKind = isRedirectStatus(parseInt(arg1, 10)) ? 1 : -1;

  if (arg3 !== undefined && !statusKind) return invalid(`${name} expects a status as the first of three arguments`);

  // A lone target, with or without a redirect status, is an `ap_expr` string
  if ((statusKind > 0 && arg2 !== undefined && arg3 === undefined) || (!statusKind && arg2 === undefined)) {
    const expr = statusKind ? arg2 : arg1;
    return EXPR_SPECIAL_RE.test(expr) ? undefined : expr;
  }

  if (statusKind < 0) {
    return arg3 === undefined ? undefined : invalid(`${name} doesn’t take a target for a non-redirect status`);
  }

  const target = statusKind ? arg3 : arg2;
  if (target === undefined) return invalid(`${name} is missing a target`);
  if (isRegex) return substituteRegex(target);
  if (!URL_SCHEME_RE.test(target) && target[0] !== '/') return invalid(`${name} target isn’t a URL or path`);
  return target;
}

// Mirrors `ap_pregsub()`: `$0`–`$9` are backreferences, and a backslash
// escapes the next character
function substituteRegex(target) {
  let result = '';
  for (let i = 0; i < target.length; i++) {
    if (target[i] === '$' && isDigit(target[i + 1])) return;
    if (target[i] === '\\' && i + 1 < target.length) i++;
    result += target[i];
  }
  return result;
}

// Mirrors mod_rewrite’s `parseargline()`, which, unlike `ap_getword_conf()`,
// lets a backslash escape whitespace and keeps the backslash
function parseRewriteArgs(args) {
  let i = 0;
  const skipSpaces = () => {
    while (isSpace(args[i])) i++;
  };
  const readArg = () => {
    const quote = args[i] === '"' || args[i] === "'" ? args[i++] : '';
    const start = i;
    while (i < args.length && (quote ? args[i] !== quote : !isSpace(args[i]))) {
      i += args[i] === '\\' && isSpace(args[i + 1]) ? 2 : 1;
    }
    return args.slice(start, i);
  };

  skipSpaces();
  readArg();
  if (i >= args.length) return;
  i++;
  skipSpaces();
  const substitution = readArg();
  if (i >= args.length) return { substitution };
  i++;
  skipSpaces();
  if (i >= args.length) return { substitution };
  return { substitution, flags: readArg() };
}

// Mirrors `cmd_parseflagfield()` for bracketed flags; flag names aren’t
// validated, as the set varies across Apache versions
function keepsSubstitution(flags) {
  for (const flag of flags.slice(1, -1).split(',')) {
    const [key, value = ''] = flag.replace(TRIM_RE, '').split(/=(.*)/s);
    const name = key.toLowerCase();
    if (NOSUB_FLAGS.has(name)) return false;
    if ((name === 'r' || name === 'redirect') && isDigit(value[0]) && !isRedirectStatus(parseInt(value, 10))) return false;
  }

  return true;
}

// Mirrors `find_closing_curly()`, which allows nesting
function hasClosingCurly(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '}' && --depth === 0) return true;
    if (text[i] === '{') depth++;
  }
  return false;
}

// Mirrors mod_rewrite’s `do_expand()`; returns nothing for a substitution that
// depends on the request (backreferences, variables, map lookups)
function expandRewrite(substitution) {
  let result = '';
  for (let i = 0; i < substitution.length; i++) {
    const char = substitution[i];
    const next = substitution[i + 1];
    if (char === '\\' && next !== undefined) {
      result += next;
      i++;
      continue;
    }
    if ((char === '$' || char === '%') && (isDigit(next) || (next === '{' && hasClosingCurly(substitution, i + 2)))) return;
    result += char;
  }
  return result;
}

function rewriteTarget(args) {
  const parsed = parseRewriteArgs(args);
  if (!parsed) return invalid('RewriteRule is missing a substitution (or the pattern’s quote isn’t closed)');

  const { substitution, flags } = parsed;
  if (flags !== undefined) {
    if (!flags.startsWith('[') || !flags.endsWith(']')) return invalid('RewriteRule flags need to be in brackets, without unquoted spaces');
    if (!keepsSubstitution(flags)) return;
  }

  return expandRewrite(substitution);
}

export function extractTargets(content, { onInvalid } = {}) {
  const targets = new Set();

  // Only Apache on Windows skips a BOM; elsewhere, it breaks the first directive
  const hasBom = content.startsWith('\uFEFF');
  if (hasBom) onInvalid?.({ line: 1, reason: 'File starts with a byte order mark, which Apache rejects except on Windows' });

  for (const { text, line } of readLines(hasBom ? content.slice(1) : content)) {
    if (!text || text.startsWith('#') || CONFIG_VAR_RE.test(text)) continue;

    // `RewriteRule` takes its arguments raw; the others are split into words
    const [name, argsStart] = readWord(text, 0);
    const directive = name.toLowerCase();
    let target;
    if (directive === 'rewriterule') {
      target = rewriteTarget(text.slice(argsStart));
    } else if (ALIAS_DIRECTIVES.has(directive)) {
      target = aliasTarget(readWords(text, argsStart), ALIAS_DIRECTIVES.get(directive));
    }

    if (typeof target === 'object') onInvalid?.({ line, reason: target.reason });
    else if (target && URL_RE.test(target)) targets.add(target);
  }

  return targets;
}

export async function checkUrl(url) {
  const chain = [];
  let current = url;

  try {
    while (chain.length < MAX_REDIRECTS) {
      let res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'htaccess-punk' },
      });

      // Some servers (e.g., Medium) block HEAD requests—fall back to GET
      if (res.status === 403 || res.status === 405) {
        res = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'User-Agent': 'htaccess-punk' },
        });
      }

      // Only headers are needed; an unread body keeps its connection busy
      await res.body?.cancel();

      const status = res.status;
      const location = res.headers.get('location');
      chain.push({ url: current, status });

      if (isRedirectStatus(status) && location) {
        try {
          current = new URL(location, current).href;
        } catch {
          break;
        }
      } else {
        break;
      }
    }
  } catch (err) {
    return { url, error: err.message, chain };
  }

  const last = chain[chain.length - 1];
  return {
    url,
    status: last.status,
    urlFinal: last.url !== url ? last.url : null,
    chain,
  };
}

async function runPool(tasks, concurrency) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (queue.length) {
      await queue.shift()();
    }
  });
  await Promise.all(workers);
}

export async function check(dir = '.', { concurrency = CONCURRENCY, onResult, onReady, onWarn, onInvalid } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`\`concurrency\` must be a positive integer, got ${typeof concurrency === 'number' ? concurrency : typeof concurrency}`);
  }

  const dirResolved = resolve(dir);
  const files = await findHtaccessFiles(dirResolved, { onWarn });

  const urlToFiles = new Map();
  await Promise.all(files.map(async file => {
    const content = await readFile(file, 'utf8');
    for (const target of extractTargets(content, { onInvalid: entry => onInvalid?.({ file, ...entry }) })) {
      if (!urlToFiles.has(target)) urlToFiles.set(target, []);
      urlToFiles.get(target).push(file);
    }
  }));

  const urls = [...urlToFiles.keys()].sort();
  onReady?.({ files, urls });

  const results = [];
  const tasks = urls.map(url => async () => {
    const result = await checkUrl(url);
    results.push(result);
    onResult?.(result);
  });

  await runPool(tasks, concurrency);

  return { dir: dirResolved, files, urls, urlToFiles, results };
}
