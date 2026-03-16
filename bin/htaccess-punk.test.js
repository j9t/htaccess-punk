import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { extractTargets, findHtaccessFiles } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'htaccess-punk.js');

function run(args) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8' });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

describe('Extract targets', () => {
  test('Extracts Redirect targets', () => {
    const targets = extractTargets('Redirect 301 /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts RedirectPermanent targets', () => {
    const targets = extractTargets('RedirectPermanent /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts RedirectTemp targets', () => {
    const targets = extractTargets('RedirectTemp /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts Redirect without explicit status code', () => {
    const targets = extractTargets('Redirect /old/ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Extracts RedirectMatch targets without backreferences', () => {
    const targets = extractTargets('RedirectMatch 301 ^/old/(.*)$ https://example.com/new/');
    assert.deepStrictEqual([...targets], ['https://example.com/new/']);
  });

  test('Skips RedirectMatch targets with backreferences', () => {
    const targets = extractTargets('RedirectMatch 301 ^/old/(.*)$ https://example.com/$1');
    assert.deepStrictEqual([...targets], []);
  });

  test('Extracts RewriteRule absolute targets', () => {
    const targets = extractTargets('RewriteRule ^(.*)$ https://example.com/ [L]');
    assert.deepStrictEqual([...targets], ['https://example.com/']);
  });

  test('Skips RewriteRule targets with backreferences', () => {
    const targets = extractTargets('RewriteRule ^/old/(.*)$ https://example.com/$1 [L]');
    assert.deepStrictEqual([...targets], []);
  });

  test('Skips RewriteRule targets with rewrite map references', () => {
    const targets = extractTargets('RewriteRule ^/old/(.*)$ https://example.com/%{HTTP_HOST} [L]');
    assert.deepStrictEqual([...targets], []);
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

describe('Find .htaccess files', () => {
  const tempDir = path.join(__dirname, 'temp_test_find');

  before(() => {
    fs.mkdirSync(path.join(tempDir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.htaccess'), 'Redirect 301 /old/ https://example.com/');
    fs.writeFileSync(path.join(tempDir, 'sub', '.htaccess'), 'Redirect 301 /old/ https://example.com/sub/');
    fs.writeFileSync(path.join(tempDir, 'node_modules', '.htaccess'), 'Redirect 301 /old/ https://example.com/nm/');
    fs.writeFileSync(path.join(tempDir, 'other.txt'), 'not an htaccess file');
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('Finds .htaccess files recursively', async () => {
    const files = await findHtaccessFiles(tempDir);
    assert.strictEqual(files.length, 2);
  });

  test('Returns only .htaccess files', async () => {
    const files = await findHtaccessFiles(tempDir);
    assert.ok(files.every(f => path.basename(f) === '.htaccess'));
  });

  test('Skips node_modules', async () => {
    const files = await findHtaccessFiles(tempDir);
    assert.ok(files.every(f => !f.includes('node_modules')));
  });

  test('Returns empty array for missing directory', async () => {
    const files = await findHtaccessFiles(path.join(tempDir, 'nonexistent'));
    assert.deepStrictEqual(files, []);
  });
});

describe('CLI', () => {
  const tempDir = path.join(__dirname, 'temp_test_cli');

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.htaccess'), [
      'Redirect 301 /a/ https://example.com/',
      'RedirectMatch 301 ^/b/(.*)$ https://example.com/$1',
    ].join('\n'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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

  test('Ensures `--errors` is accepted and produces summary', () => {
    const noTargetsDir = path.join(tempDir, 'no_targets');
    fs.mkdirSync(noTargetsDir, { recursive: true });
    fs.writeFileSync(path.join(noTargetsDir, '.htaccess'), 'RedirectMatch 301 ^/old/(.*)$ https://example.com/$1\n');
    const { stdout, status } = run(['--errors', noTargetsDir]);
    assert.ok(stdout.includes('no checkable redirect targets'));
    assert.strictEqual(status, 0);
    fs.rmSync(noTargetsDir, { recursive: true, force: true });
  });

  test('Ensures `-e` is accepted as short form of `--errors`', () => {
    const noTargetsDir = path.join(tempDir, 'no_targets_e');
    fs.mkdirSync(noTargetsDir, { recursive: true });
    fs.writeFileSync(path.join(noTargetsDir, '.htaccess'), 'RedirectMatch 301 ^/old/(.*)$ https://example.com/$1\n');
    const { stdout, status } = run(['-e', noTargetsDir]);
    assert.ok(stdout.includes('no checkable redirect targets'));
    assert.strictEqual(status, 0);
    fs.rmSync(noTargetsDir, { recursive: true, force: true });
  });

  test('Reports no .htaccess files found for empty directory', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const { stdout } = run([emptyDir]);
    assert.ok(stdout.includes('No .htaccess files found'));
    fs.rmdirSync(emptyDir);
  });

  test('Finds and scans .htaccess files', () => {
    const { stdout } = run([tempDir]);
    assert.ok(stdout.includes('.htaccess file'));
  });

  test('Reports only checkable targets (skips backreference URLs)', () => {
    const { stdout } = run([tempDir]);
    assert.ok(stdout.includes('1 unique target'));
  });

  test('Includes summary line', () => {
    const { stdout } = run([tempDir]);
    assert.ok(stdout.includes('Summary:'));
    assert.ok(stdout.includes('checked'));
  });
});
