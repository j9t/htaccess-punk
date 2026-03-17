#!/usr/bin/env node

import { parseArgs, styleText } from 'node:util';
import { resolve } from 'node:path';
import { check } from '../src/index.js';

const { values, positionals } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    errors: { type: 'boolean', short: 'e', default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  console.log(`Usage: htaccess-punk [options] [directory]

Check redirect targets in .htaccess files.

Arguments:
  directory  Directory to scan (default: current directory)

Options:
  -e, --errors  Show only error results (HTTP 4xx+ and connection failures); summary still reflects all checked URLs
  -h, --help    Show this help`);
  process.exit(0);
}

const dir = positionals[0] || '.';

function formatResult({ url, status, finalUrl, chain, error }) {
  if (error) {
    process.stdout.write(`${styleText('red', 'ERR')}  ${url}\n     ${styleText('dim', error)}\n`);
    return;
  }

  const statusStr = String(status);
  const statusColored =
    status >= 200 && status < 300 ? styleText('green', statusStr) :
    status >= 300 && status < 400 ? styleText('yellow', statusStr) :
    styleText('red', statusStr);

  const redirect = finalUrl ? `\n     ${styleText('dim', `→ ${finalUrl}`)}` : '';
  const hops = chain.length > 1 ? styleText('dim', `${chain.length - 1}×→ `) : '';

  process.stdout.write(`${hops}${statusColored}  ${url}${redirect}\n`);
}

async function main() {
  console.log(`Scanning ${resolve(dir)}…\n`);

  const { files, urls, urlToFiles, results } = await check(dir, {
    onReady({ files: foundFiles, urls: foundUrls }) {
      if (!foundFiles.length || !foundUrls.length) return;
      console.log(`Found ${foundFiles.length} .htaccess file${foundFiles.length !== 1 ? 's' : ''} 📂\n`); // eslint-disable-line no-irregular-whitespace
      console.log(`Checking ${foundUrls.length} unique target${foundUrls.length !== 1 ? 's' : ''}…\n`);
    },
  });

  if (!files.length) {
    console.log('No .htaccess files found.');
    return;
  }

  if (!urls.length) {
    console.log(`Found ${files.length} .htaccess file${files.length !== 1 ? 's' : ''} with no checkable redirect targets.`);
    return;
  }

  const fileToResults = new Map();
  for (const result of [...results].sort((a, b) => (a.url < b.url ? -1 : 1))) {
    for (const file of urlToFiles.get(result.url) ?? []) {
      if (!fileToResults.has(file)) fileToResults.set(file, []);
      fileToResults.get(file).push(result);
    }
  }

  let firstSection = true;

  for (const file of files) {
    const fileResults = fileToResults.get(file) ?? [];
    const toShow = values.errors
      ? fileResults.filter(r => r.error || r.status >= 400)
      : fileResults;
    if (!toShow.length) continue;

    if (!firstSection) console.log('');
    firstSection = false;
    console.log(styleText('bold', file));
    for (const result of toShow) {
      formatResult(result);
    }
  }

  let ok = 0, redirected = 0, errors = 0, failed = 0;
  for (const r of results) {
    if (r.error) failed++;
    else if (r.status >= 400) errors++;
    else if (r.status >= 300) redirected++;
    else ok++;
  }

  const parts = [
    styleText('green', `${ok} OK`),
    styleText('yellow', `${redirected} redirect${redirected !== 1 ? 's' : ''}`),
    styleText('red', `${errors} error${errors !== 1 ? 's' : ''}`),
  ];
  if (failed) parts.push(styleText('red', `${failed} connection failure${failed !== 1 ? 's' : ''}`));

  console.log(`\n${styleText('bold', 'Summary:')} ${urls.length} checked—${parts.join(', ')}`);

  if (errors > 0 || failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
