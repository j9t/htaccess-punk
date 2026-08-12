/**
 * TypeScript type definition tests
 *
 * This file is compiled by TypeScript during testing to verify that the
 * declaration file is valid and types are correctly exported and usable.
 *
 * This file is not executed—it only needs to type-check successfully.
 */

import { check, checkUrl, extractTargets, findHtaccessFiles } from './index.js';
import type { CheckResult, CheckUrlResult } from './index.js';

// `findHtaccessFiles` accepts a directory and resolves to file paths
const files: string[] = await findHtaccessFiles('.');

// `findHtaccessFiles` also takes an options object
await findHtaccessFiles('.', {
  onWarn({ dir: dirSkipped, err }) {
    void dirSkipped.length;
    void err.code;
  },
});

// `extractTargets` accepts file contents and returns a set of target URLs
const targets: Set<string> = extractTargets('Redirect 301 /old https://example.com/new');

// `checkUrl` accepts a URL and resolves to either a status or an error result
const urlResult: CheckUrlResult = await checkUrl('https://example.com/');
const chain = urlResult.chain;
const status: number | undefined = urlResult.error === undefined ? urlResult.status : undefined;

// `check` takes an optional directory and options object, and resolves to the full result
const result: CheckResult = await check('.', {
  concurrency: 2,
  onReady({ files: filesFound, urls: urlsFound }) {
    void filesFound.length;
    void urlsFound.length;
  },
  onResult(each) {
    void each.url;
  },
  onWarn({ dir: dirSkipped, err }) {
    void dirSkipped.length;
    void err.message;
  },
});
const { dir, urls, urlToFiles, results } = result;

// `check` also works without arguments
await check();

// `findHtaccessFiles`/`extractTargets` reject non-string input
// @ts-expect-error
findHtaccessFiles(null);
// @ts-expect-error
extractTargets(42);

// `check` rejects unknown options
// @ts-expect-error
check('.', { concurrent: 2 });

export { files, targets, chain, status, dir, urls, urlToFiles, results };