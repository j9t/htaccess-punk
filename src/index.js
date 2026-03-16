import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const CONCURRENCY = 5;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 10;

export async function findHtaccessFiles(dir) {
  const files = [];
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findHtaccessFiles(fullPath));
    } else if (entry.name === '.htaccess') {
      files.push(fullPath);
    }
  }

  return files;
}

export function extractTargets(content) {
  const targets = new Set();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Redirect [status] <source> <target>
    // RedirectPermanent <source> <target>
    // RedirectTemp <source> <target>
    const redirect = trimmed.match(
      /^Redirect(?:Permanent|Temp)?\s+(?:\d{3}\s+)?\S+\s+(https?:\/\/\S+)/i
    );
    if (redirect) {
      targets.add(redirect[1]);
      continue;
    }

    // RedirectMatch [status] <pattern> <target>
    const redirectMatch = trimmed.match(
      /^RedirectMatch\s+(?:\d{3}\s+)?\S+\s+(https?:\/\/\S+)/i
    );
    if (redirectMatch && !redirectMatch[1].includes('$')) {
      targets.add(redirectMatch[1]);
      continue;
    }

    // RewriteRule <pattern> <target> [flags]
    const rewrite = trimmed.match(
      /^RewriteRule\s+\S+\s+(https?:\/\/[^\s[]+)/i
    );
    if (rewrite && !rewrite[1].includes('$') && !rewrite[1].includes('%')) {
      targets.add(rewrite[1]);
    }
  }

  return targets;
}

export async function checkUrl(url) {
  const chain = [];
  let current = url;

  try {
    while (chain.length < MAX_REDIRECTS) {
      const res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'htaccess-punk/1.0' },
      });

      const status = res.status;
      const location = res.headers.get('location');
      chain.push({ url: current, status });

      if (status >= 300 && status < 400 && location) {
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
    finalUrl: last.url !== url ? last.url : null,
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

export async function check(dir = '.', { concurrency = CONCURRENCY, onResult, onReady } = {}) {
  const resolvedDir = resolve(dir);
  const files = await findHtaccessFiles(resolvedDir);

  const allTargets = new Set();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const target of extractTargets(content)) {
      allTargets.add(target);
    }
  }

  const urls = [...allTargets].sort();
  onReady?.({ files, urls });

  const results = [];
  const tasks = urls.map(url => async () => {
    const result = await checkUrl(url);
    results.push(result);
    onResult?.(result);
  });

  await runPool(tasks, concurrency);

  return { dir: resolvedDir, files, urls, results };
}
