import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { check, extractTargets, findHtaccessFiles } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'htaccess-punk.js');

// Permission bits don’t apply to root, and `chmod` is a no-op on Windows
const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

function createDirTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'htaccess-punk-'));
}

function run(args) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000 });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

describe('Find .htaccess files', () => {
  let dirTemp;

  before(() => {
    dirTemp = createDirTemp();
    fs.mkdirSync(path.join(dirTemp, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(dirTemp, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dirTemp, '.htaccess'), 'Redirect 301 /old/ https://example.com/');
    fs.writeFileSync(path.join(dirTemp, 'sub', '.htaccess'), 'Redirect 301 /old/ https://example.com/sub/');
    fs.writeFileSync(path.join(dirTemp, 'node_modules', '.htaccess'), 'Redirect 301 /old/ https://example.com/nm/');
    fs.writeFileSync(path.join(dirTemp, 'other.txt'), 'not an htaccess file');
  });

  after(() => {
    fs.rmSync(dirTemp, { recursive: true, force: true });
  });

  test('Finds .htaccess files recursively', async () => {
    const files = await findHtaccessFiles(dirTemp);
    assert.strictEqual(files.length, 2);
  });

  test('Returns only .htaccess files', async () => {
    const files = await findHtaccessFiles(dirTemp);
    assert.ok(files.every(f => path.basename(f) === '.htaccess'));
  });

  test('Skips node_modules', async () => {
    const files = await findHtaccessFiles(dirTemp);
    assert.ok(files.every(f => !f.includes('node_modules')));
  });

  test('Rejects for a missing directory', async () => {
    await assert.rejects(
      () => findHtaccessFiles(path.join(dirTemp, 'nonexistent')),
      err => err.code === 'ENOENT'
    );
  });

  test('Rejects for a root that is not a directory', async () => {
    await assert.rejects(
      () => findHtaccessFiles(path.join(dirTemp, '.htaccess')),
      err => err.code === 'ENOTDIR'
    );
  });

  test('Rejects for a root it cannot read', { skip: !canTestPermissions }, async () => {
    const dirLocked = path.join(dirTemp, 'locked_api');
    fs.mkdirSync(dirLocked, { recursive: true });
    fs.chmodSync(dirLocked, 0o000);
    try {
      await assert.rejects(() => findHtaccessFiles(dirLocked), err => err.code === 'EACCES');
    } finally {
      fs.chmodSync(dirLocked, 0o755);
      fs.rmSync(dirLocked, { recursive: true, force: true });
    }
  });

  test('Returns absolute paths for a relative directory', async () => {
    const dirCwd = process.cwd();
    process.chdir(path.dirname(dirTemp));
    try {
      const files = await findHtaccessFiles(path.basename(dirTemp));
      assert.ok(files.length > 0);
      assert.ok(files.every(f => path.isAbsolute(f)));
    } finally {
      process.chdir(dirCwd);
    }
  });

  test('`check()` rejects for a missing directory', async () => {
    await assert.rejects(
      () => check(path.join(dirTemp, 'nonexistent')),
      err => err.code === 'ENOENT'
    );
  });

  test('Keeps scanning when a subdirectory cannot be read', { skip: !canTestPermissions }, async () => {
    const dirLocked = path.join(dirTemp, 'locked_nested');
    fs.mkdirSync(dirLocked, { recursive: true });
    fs.chmodSync(dirLocked, 0o000);
    const skipped = [];
    try {
      const files = await findHtaccessFiles(dirTemp, { onWarn: warning => skipped.push(warning) });
      assert.ok(files.length > 0, 'Readable branches are still collected');
      assert.strictEqual(skipped.length, 1);
      assert.strictEqual(skipped[0].dir, dirLocked);
      assert.strictEqual(skipped[0].err.code, 'EACCES');
    } finally {
      fs.chmodSync(dirLocked, 0o755);
      fs.rmSync(dirLocked, { recursive: true, force: true });
    }
  });

  test('`check()` rejects for an invalid concurrency', async () => {
    for (const concurrency of [0, -1, 1.5, NaN, '2', true, Symbol('2'), Object.create(null)]) {
      await assert.rejects(() => check(dirTemp, { concurrency }), { name: 'RangeError', message: /`concurrency`/ });
    }
  });

  test('`check()` checks every target, one at a time, with a concurrency of 1', async () => {
    // Delayed responses so overlapping requests would be observed
    let active = 0;
    let activeMax = 0;
    const server = createServer((req, res) => {
      activeMax = Math.max(activeMax, ++active);
      setTimeout(() => { active--; res.end(); }, 50);
    });
    const dir = createDirTemp();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const { port } = server.address();
      fs.writeFileSync(path.join(dir, '.htaccess'), [
        `Redirect 301 /a/ http://127.0.0.1:${port}/foo`,
        `Redirect 301 /b/ http://127.0.0.1:${port}/bar`,
      ].join('\n'));
      const { results } = await check(dir, { concurrency: 1 });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(activeMax, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('`check()` reports lines Apache rejects with their file', async () => {
    const dir = createDirTemp();
    const invalid = [];
    try {
      fs.writeFileSync(path.join(dir, '.htaccess'), 'Redirect 404 /a/ https://example.com/a/');
      await check(dir, { onInvalid: entry => invalid.push(entry) });
      assert.deepStrictEqual(invalid, [{
        file: path.join(dir, '.htaccess'),
        line: 1,
        reason: 'Redirect doesn’t take a target for a non-redirect status',
      }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Ensures `check()` returns `urlToFiles` mapping target URLs to their source files', async () => {
    const dir = createDirTemp();
    fs.writeFileSync(path.join(dir, '.htaccess'), [
      'Redirect 301 /a/ http://127.0.0.1:1/foo',
      'Redirect 301 /b/ http://127.0.0.1:1/foo',
      'Redirect 301 /c/ http://127.0.0.1:1/bar',
    ].join('\n'));
    try {
      const { urlToFiles, files } = await check(dir);
      assert.ok(urlToFiles instanceof Map);
      assert.strictEqual(urlToFiles.size, 2); // /foo deduplicated, /bar
      for (const fileList of urlToFiles.values()) {
        assert.ok(fileList.every(f => files.includes(f)));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Extract targets', () => {
  test('Extracts `Redirect` targets', () => {
    const targets = extractTargets('Redirect 301 /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts `RedirectPermanent` targets', () => {
    const targets = extractTargets('RedirectPermanent /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts `RedirectTemp` targets', () => {
    const targets = extractTargets('RedirectTemp /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts `Redirect` without explicit status code', () => {
    const targets = extractTargets('Redirect /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts targets from quoted arguments', () => {
    const content = [
      'Redirect permanent "/a/" "https://example.com/a/"',
      'Redirect "/b c/" https://example.com/b/',
      'RedirectMatch 301 "^/c/(.*)$" "https://example.com/c/"',
      'RewriteRule "^/d e$" "https://example.com/d/" [R=301,L]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
      'https://example.com/c/',
      'https://example.com/d/',
    ]);
  });

  test('Extracts quoted targets containing spaces', () => {
    const content = [
      'Redirect /a/ "https://example.com/a b"',
      'RedirectMatch 301 ^/b/(.*)$ "https://example.com/b c"',
      'RewriteRule ^/c$ "https://example.com/c d" [R=301,L]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a b',
      'https://example.com/b c',
      'https://example.com/c d',
    ]);
  });

  test('Extracts single-quoted targets', () => {
    const content = [
      "Redirect /a/ 'https://example.com/a b'",
      "RedirectMatch ^/b/ 'https://example.com/b c'",
      "RewriteRule ^c$ 'https://example.com/c d' [R=301,L]",
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a b',
      'https://example.com/b c',
      'https://example.com/c d',
    ]);
  });

  test('Extracts the rest of the line as the target of an unclosed quote', () => {
    const content = [
      'Redirect /a/ "https://example.com/a b',
      'RedirectMatch ^/b/ "https://example.com/b c',
      'RewriteRule ^c$ "https://example.com/c d',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a b',
      'https://example.com/b c',
      'https://example.com/c d',
    ]);
  });

  test('Skips `RewriteRule` lines whose pattern quote is not closed', () => {
    const targets = extractTargets('RewriteRule "^a https://example.com/');
    assert.deepStrictEqual([...targets], []);
  });

  test('Unescapes quotes and backslashes in quoted `Redirect` targets', () => {
    const targets = extractTargets('Redirect /a/ "https://example.com/a\\"b\\\\c"');
    assert.deepStrictEqual([...targets], ['https://example.com/a"b\\c']);
  });

  test('Extracts `RewriteRule` targets with escaped spaces', () => {
    const targets = extractTargets('RewriteRule ^a$ https://example.com/a\\ b [R=301,L]');
    assert.deepStrictEqual([...targets], ['https://example.com/a b']);
  });

  test('Extracts targets with escaped or literal dollar signs', () => {
    const content = [
      'RedirectMatch ^/a/ https://example.com/a\\$1',
      'RedirectMatch ^/b/ https://example.com/b$c',
      'RewriteRule ^c$ https://example.com/c\\$1 [R]',
      'RewriteRule ^d$ https://example.com/d$e [R]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a$1',
      'https://example.com/b$c',
      'https://example.com/c$1',
      'https://example.com/d$e',
    ]);
  });

  test('Extracts `RewriteRule` targets with a fragment', () => {
    const targets = extractTargets('RewriteRule ^a$ https://example.com/a#b [NE,R]');
    assert.deepStrictEqual([...targets], ['https://example.com/a#b']);
  });

  test('Extracts `RewriteRule` targets with an unclosed `%{`', () => {
    const targets = extractTargets('RewriteRule ^a$ https://example.com/%{a [R]');
    assert.deepStrictEqual([...targets], ['https://example.com/%{a']);
  });

  test('Skips lines with config variables', () => {
    const content = [
      'Redirect /a/ https://${HOST}/a/',
      'RewriteRule ^b$ https://example.com/${map:b} [R]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Joins lines ending in a backslash', () => {
    const content = [
      'Redirect 301 /a/ \\',
      '  https://example.com/a/',
      'Redirect 301 /b/ https://example.com/\\',
      'b/',
      'Redirect 301 /c/ \\\r',
      'https://example.com/c/\r',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
      'https://example.com/c/',
    ]);
  });

  test('Skips lines continuing a comment', () => {
    const content = [
      '# Old rule \\',
      'Redirect 301 /a/ https://example.com/a/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Does not join lines when whitespace follows the backslash', () => {
    const content = [
      'Redirect 301 /a/ https://example.com/a/\\ ',
      'Redirect 301 /b/ https://example.com/b/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/\\',
      'https://example.com/b/',
    ]);
  });

  test('Extracts targets of any 3xx status', () => {
    const targets = extractTargets('Redirect 308 /a/ https://example.com/a/');
    assert.deepStrictEqual([...targets], ['https://example.com/a/']);
  });

  test('Skips `Redirect` targets with a non-3xx status, which Apache rejects', () => {
    const content = [
      'Redirect 404 /a/ https://example.com/a/',
      'RedirectMatch 410 ^/b/ https://example.com/b/',
      'Redirect gone /c/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Skips `Redirect` lines with too many arguments, which Apache rejects', () => {
    const content = [
      'Redirect 301 /a/ https://example.com/a/ extra',
      'RedirectPermanent /b/ https://example.com/b/ # Comment',
      'RedirectMatch 301 ^/c/ https://example.com/c/ extra',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Extracts `Redirect` expression targets', () => {
    const content = [
      'Redirect https://example.com/a/',
      'Redirect 301 https://example.com/b/',
      'Redirect 301 https://example.com/%{REQUEST_URI}',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
    ]);
  });

  test('Skips `RewriteRule` targets that are not substituted', () => {
    const content = [
      'RewriteRule ^a$ https://example.com/a/ [F]',
      'RewriteRule ^b$ https://example.com/b/ [gone]',
      'RewriteRule ^c$ https://example.com/c/ [R=404,L]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Skips `RewriteRule` lines with bad flag delimiters, which Apache rejects', () => {
    const content = [
      'RewriteRule ^a$ https://example.com/a/ [R=301, L]',
      'RewriteRule ^b$ https://example.com/b/ # Comment',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], []);
  });

  test('Matches directive names case-insensitively', () => {
    const content = [
      'redirect 301 /a/ https://example.com/a/',
      'REWRITERULE ^b$ https://example.com/b/ [R]',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
    ]);
  });

  test('Reports lines Apache rejects through `onInvalid`', () => {
    const invalid = [];
    const content = [
      'Redirect 301 /a/ https://example.com/a/ extra',
      'Redirect foo /b/ https://example.com/b/',
      'Redirect 404 /c/ https://example.com/c/',
      'Redirect 301',
      'Redirect /d/ example.com/d/',
      'RedirectMatch ^/e/',
      'RedirectPermanent /f/',
      'RewriteRule "^g https://example.com/g/',
      'RewriteRule ^h$ https://example.com/h/ [R=301, L]',
      'Redirect 301 /i/ \\',
      '  https://example.com/i/ extra',
    ].join('\n');
    extractTargets(content, { onInvalid: entry => invalid.push(entry) });
    assert.deepStrictEqual(invalid, [
      { line: 1, reason: 'Redirect takes one, two, or three arguments' },
      { line: 2, reason: 'Redirect expects a status as the first of three arguments' },
      { line: 3, reason: 'Redirect doesn’t take a target for a non-redirect status' },
      { line: 4, reason: 'Redirect is missing a target' },
      { line: 5, reason: 'Redirect target isn’t a URL or path' },
      { line: 6, reason: 'RedirectMatch takes two or three arguments' },
      { line: 7, reason: 'RedirectPermanent takes two arguments' },
      { line: 8, reason: 'RewriteRule is missing a substitution (or the pattern’s quote isn’t closed)' },
      { line: 9, reason: 'RewriteRule flags need to be in brackets, without unquoted spaces' },
      { line: 10, reason: 'Redirect takes one, two, or three arguments' },
    ]);
  });

  test('Extracts targets after a byte order mark, and reports it', () => {
    const invalid = [];
    const targets = extractTargets('﻿Redirect 301 /a/ https://example.com/a/', { onInvalid: entry => invalid.push(entry) });
    assert.deepStrictEqual([...targets], ['https://example.com/a/']);
    assert.deepStrictEqual(invalid, [{ line: 1, reason: 'File starts with a byte order mark, which Apache rejects except on Windows' }]);
  });

  test('Does not report lines Apache accepts', () => {
    const invalid = [];
    const content = [
      '# Redirect 301',
      'RewriteEngine On',
      'Redirect gone /a/',
      'Redirect 301 /b/ /b-new/',
      'Redirect /c/ "https://example.com/c',
      'RedirectMatch ^/d/(.*)$ https://example.com/$1',
      'RewriteRule ^e$ https://example.com/e/ [F]',
      'RewriteRule ^f$ - [L]',
      'Redirect /g/ https://${HOST}/g/',
    ].join('\n');
    extractTargets(content, { onInvalid: entry => invalid.push(entry) });
    assert.deepStrictEqual(invalid, []);
  });

  test('Skips quoted `RedirectMatch` targets with backreferences', () => {
    const targets = extractTargets('RedirectMatch "(.*)\\.gif$" "https://example.com$1.jpg"');
    assert.deepStrictEqual([...targets], []);
  });

  test('Extracts `Redirect` targets with a status keyword', () => {
    const content = [
      'Redirect permanent /a/ https://example.com/a/',
      'Redirect temp /b/ https://example.com/b/',
      'Redirect seeother /c/ https://example.com/c/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
      'https://example.com/c/',
    ]);
  });

  test('Extracts `RedirectMatch` targets with a status keyword', () => {
    const content = [
      'RedirectMatch permanent ^/a/(.*)$ https://example.com/a/',
      'RedirectMatch temp ^/b/(.*)$ https://example.com/b/',
      'RedirectMatch seeother ^/c/(.*)$ https://example.com/c/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], [
      'https://example.com/a/',
      'https://example.com/b/',
      'https://example.com/c/',
    ]);
  });

  test('Extracts `RedirectMatch` targets without backreferences', () => {
    const targets = extractTargets('RedirectMatch 301 ^/old/(.*)$ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Skips `RedirectMatch` targets with backreferences', () => {
    const targets = extractTargets('RedirectMatch 301 ^/old/(.*)$ https://example.com/$1');
    assert.deepStrictEqual([...targets], []);
  });

  test('Extracts `RewriteRule` absolute targets', () => {
    const targets = extractTargets('RewriteRule ^(.*)$ https://example.com/ [L]');
    assert.deepStrictEqual([...targets], ['https://example.com/']);
  });

  test('Skips `RewriteRule` targets with backreferences', () => {
    const targets = extractTargets('RewriteRule ^/old/(.*)$ https://example.com/$1 [L]');
    assert.deepStrictEqual([...targets], []);
  });

  test('Skips `RewriteRule` targets with rewrite map references', () => {
    const targets = extractTargets('RewriteRule ^/old/(.*)$ https://example.com/%{HTTP_HOST} [L]');
    assert.deepStrictEqual([...targets], []);
  });

  test('Extracts `RewriteRule` targets with percent-encoding Apache leaves literal', () => {
    const targets = extractTargets('RewriteRule ^old$ https://example.com/caf%C3%A9 [L]');
    assert.deepStrictEqual([...targets], ['https://example.com/caf%C3%A9']);
  });

  test('Skips `RewriteRule` targets with digit-led percent sequences Apache expands', () => {
    const targets = extractTargets('RewriteRule ^old$ https://example.com/a%20b [L]');
    assert.deepStrictEqual([...targets], []);
  });

  test('Extracts `RewriteRule` targets with IPv6 hosts', () => {
    const targets = extractTargets('RewriteRule ^(.*)$ https://[2001:db8::1]/foo [L]');
    assert.deepStrictEqual([...targets], ['https://[2001:db8::1]/foo']);
  });

  test('Skips comment lines', () => {
    const targets = extractTargets('# Redirect 301 /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], []);
  });

  test('Skips empty lines', () => {
    const targets = extractTargets('\n\n\n');
    assert.deepStrictEqual([...targets], []);
  });

  test('Deduplicates identical targets', () => {
    const content = [
      'Redirect 301 /a/ https://example.com/',
      'Redirect 301 /b/ https://example.com/',
    ].join('\n');
    assert.deepStrictEqual([...extractTargets(content)], ['https://example.com/']);
  });

  test('Handles mixed directives in one file', () => {
    const content = [
      'Redirect 301 /a/ https://example.com/a/',
      'RedirectMatch 301 ^/b/(.*)$ https://example.com/b/',
      'RedirectMatch 301 ^/c/(.*)$ https://example.com/$1',
      'RewriteRule ^(.*)$ https://example.com/r/ [L]',
    ].join('\n');
    const targets = [...extractTargets(content)].sort();
    assert.deepStrictEqual(targets, [
      'https://example.com/a/',
      'https://example.com/b/',
      'https://example.com/r/',
    ]);
  });
});

describe('CLI', () => {
  let dirTemp;

  before(() => {
    dirTemp = createDirTemp();
    // Unreachable local target so CLI runs stay offline
    fs.writeFileSync(path.join(dirTemp, '.htaccess'), [
      'Redirect 301 /a/ http://127.0.0.1:1/',
      'RedirectMatch 301 ^/b/(.*)$ https://example.com/$1',
    ].join('\n'));
  });

  after(() => {
    fs.rmSync(dirTemp, { recursive: true, force: true });
  });

  // An unusable target has to fail loudly
  test('Fails on a directory that does not exist', () => {
    const { stderr, status } = run([path.join(dirTemp, 'nonexistent')]);
    assert.match(stderr, /No such directory/);
    assert.strictEqual(status, 1);
  });

  test('Fails on a file given instead of a directory', () => {
    const { stderr, status } = run([path.join(dirTemp, '.htaccess')]);
    assert.match(stderr, /Not a directory/);
    assert.strictEqual(status, 1);
  });

  test('Fails on a directory it cannot read', { skip: !canTestPermissions }, () => {
    const dirLocked = path.join(dirTemp, 'locked_root');
    fs.mkdirSync(dirLocked, { recursive: true });
    fs.chmodSync(dirLocked, 0o000);
    try {
      const { stderr, status } = run([dirLocked]);
      assert.match(stderr, /Cannot read directory/);
      assert.strictEqual(status, 1);
    } finally {
      fs.chmodSync(dirLocked, 0o755);
      fs.rmSync(dirLocked, { recursive: true, force: true });
    }
  });

  test('Warns instead of silently skipping an unreadable subdirectory', { skip: !canTestPermissions }, () => {
    const dirLocked = path.join(dirTemp, 'locked_sub');
    fs.mkdirSync(dirLocked, { recursive: true });
    fs.chmodSync(dirLocked, 0o000);
    try {
      const { stderr } = run([dirTemp]);
      assert.match(stderr, /Skipped .*locked_sub/);
    } finally {
      fs.chmodSync(dirLocked, 0o755);
      fs.rmSync(dirLocked, { recursive: true, force: true });
    }
  });

  test('Warns about lines Apache rejects without failing', () => {
    const dirInvalid = createDirTemp();
    try {
      fs.writeFileSync(path.join(dirInvalid, '.htaccess'), 'Redirect 404 /a/ https://example.com/a/');
      const { stderr, status } = run([dirInvalid]);
      assert.match(stderr, /Invalid directive at .*\.htaccess:1: Redirect doesn’t take a target for a non-redirect status \(Apache rejects the whole file\)/);
      assert.strictEqual(status, 0);
    } finally {
      fs.rmSync(dirInvalid, { recursive: true, force: true });
    }
  });

  test('Fails on a path whose parent is a file', () => {
    const { stderr, status } = run([path.join(dirTemp, '.htaccess', 'nested')]);
    assert.match(stderr, /No such directory/);
    assert.strictEqual(status, 1);
  });

  test('Shows help with `--help`', () => {
    const { stdout, status } = run(['--help']);
    assert.ok(stdout.includes('Usage:'));
    assert.strictEqual(status, 0);
  });

  test('Lists `--errors` flag in help', () => {
    const { stdout } = run(['--help']);
    assert.ok(stdout.includes('--errors'));
    assert.ok(stdout.includes('-e'));
  });

  test('Reports no .htaccess files found for empty directory', () => {
    const dirEmpty = path.join(dirTemp, 'empty');
    fs.mkdirSync(dirEmpty, { recursive: true });
    try {
      const { stdout } = run([dirEmpty]);
      assert.ok(stdout.includes('No .htaccess files found'));
    } finally {
      fs.rmSync(dirEmpty, { recursive: true, force: true });
    }
  });

  test('Finds and scans .htaccess files', () => {
    const { stdout } = run([dirTemp]);
    assert.ok(stdout.includes('.htaccess file'));
  });

  test('Reports only checkable targets (skips backreference URLs)', () => {
    const { stdout } = run([dirTemp]);
    assert.ok(stdout.includes('1 unique target'));
  });

  test('Includes summary line', () => {
    const { stdout } = run([dirTemp]);
    assert.ok(stdout.includes('Summary:'));
    assert.ok(stdout.includes('checked'));
  });

  describe('`--errors` filtering', () => {
    let dirFilter;
    let serverProcess;
    let port;

    before(async () => {
      dirFilter = createDirTemp();

      // The server runs in a separate process so `spawnSync` (used by `run()`) does
      // not block its event loop; routes: 200, 301 → 200, 404, /fail (socket reset);
      // `.mjs` because the temp directory has no `package.json` declaring ESM
      const serverScript = path.join(dirFilter, '_server.mjs');
      fs.writeFileSync(serverScript, [
        "import { createServer } from 'node:http';",
        'const server = createServer((req, res) => {',
        "  if (req.url === '/status-200') { res.writeHead(200); res.end(); }",
        "  else if (req.url === '/status-301') { res.writeHead(301, { Location: 'http://127.0.0.1:' + server.address().port + '/status-200' }); res.end(); }",
        "  else if (req.url === '/status-404') { res.writeHead(404); res.end(); }",
        "  else if (req.url === '/fail') { req.socket.destroy(); }",
        "  else { res.writeHead(404); res.end(); }",
        '});',
        "server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));",
      ].join('\n'));

      await new Promise((resolve, reject) => {
        serverProcess = spawn('node', [serverScript], { stdio: ['ignore', 'pipe', 'inherit'] });

        const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 5000);
        const onExit = code => { clearTimeout(timeout); reject(new Error(`Server exited unexpectedly with code ${code}`)); };
        const onError = err => { clearTimeout(timeout); reject(err); };

        serverProcess.once('exit', onExit);
        serverProcess.once('error', onError);
        serverProcess.stdout.once('data', data => {
          clearTimeout(timeout);
          serverProcess.off('exit', onExit);
          serverProcess.off('error', onError);
          port = parseInt(data.toString().trim(), 10);
          resolve();
        });
      });

      fs.writeFileSync(path.join(dirFilter, '.htaccess'), [
        `Redirect 301 /a/ http://127.0.0.1:${port}/status-200`,
        `Redirect 301 /b/ http://127.0.0.1:${port}/status-301`,
        `Redirect 301 /c/ http://127.0.0.1:${port}/status-404`,
        `Redirect 301 /d/ http://127.0.0.1:${port}/fail`,
      ].join('\n'));
    });

    after(async () => {
      if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
        await new Promise(resolve => {
          serverProcess.once('exit', resolve);
          serverProcess.kill('SIGKILL');
        });
      }
      fs.rmSync(dirFilter, { recursive: true, force: true });
    });

    test('Ensures `--errors` shows 404 and connection failure but not 2xx or 3xx results', () => {
      const { stdout, status } = run(['--errors', dirFilter]);
      assert.ok(stdout.includes('/status-404'), 'expected 404 result in output');
      assert.ok(stdout.includes('/fail'), 'expected connection failure result in output');
      assert.ok(!stdout.includes('/status-200'), 'unexpected 200 result in output');
      assert.ok(!stdout.includes('/status-301'), 'unexpected 301 result in output');
      assert.strictEqual(status, 1);
    });

    test('Ensures `-e` shows 404 and connection failure but not 2xx or 3xx results', () => {
      const { stdout, status } = run(['-e', dirFilter]);
      assert.ok(stdout.includes('/status-404'), 'expected 404 result in output');
      assert.ok(stdout.includes('/fail'), 'expected connection failure result in output');
      assert.ok(!stdout.includes('/status-200'), 'unexpected 200 result in output');
      assert.ok(!stdout.includes('/status-301'), 'unexpected 301 result in output');
      assert.strictEqual(status, 1);
    });
  });
});