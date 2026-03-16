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
  -e, --errors  Only show errors (HTTP 4xx+ and connection failures)
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

  const { files, urls, results } = await check(dir, {
    onReady({ files, urls }) {
      if (!files.length) return;
      console.log(`Found ${files.length} .htaccess file${files.length !== 1 ? 's' : ''}\n`);
      if (urls.length) {
        console.log(`Checking ${urls.length} unique target${urls.length !== 1 ? 's' : ''}…\n`);
      }
    },
    onResult: values.errors
      ? (result) => { if (result.error || result.status >= 400) formatResult(result); }
      : formatResult,
  });

  if (!files.length) {
    console.log('No .htaccess files found.');
    return;
  }

  if (!urls.length) {
    console.log(`Found ${files.length} .htaccess file${files.length !== 1 ? 's' : ''} with no checkable redirect targets.`);
    return;
  }

  const ok = results.filter(r => !r.error && r.status >= 200 && r.status < 300).length;
  const redirected = results.filter(r => !r.error && r.status >= 300 && r.status < 400).length;
  const errors = results.filter(r => !r.error && r.status >= 400).length;
  const failed = results.filter(r => r.error).length;

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
