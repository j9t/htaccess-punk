import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { check, extractTargets, findHtaccessFiles } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'htaccess-punk.js');

function run(args) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000 });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

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

describe('check() programmatic API', () => {
  const tempDir = path.join(__dirname, 'temp_test_check_api');

  before(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.htaccess'), [
      'Redirect 301 /a/ http://127.0.0.1:1/foo',
      'Redirect 301 /b/ http://127.0.0.1:1/foo',
      'Redirect 301 /c/ http://127.0.0.1:1/bar',
    ].join('\n'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('Returns urlToFiles mapping target URLs to their source files', async () => {
    const { urlToFiles, files } = await check(tempDir);
    assert.ok(urlToFiles instanceof Map);
    assert.strictEqual(urlToFiles.size, 2); // /foo deduplicated, /bar
    for (const fileList of urlToFiles.values()) {
      assert.ok(fileList.every(f => files.includes(f)));
    }
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

  test('Reports no .htaccess files found for empty directory', () => {
    const emptyDir = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const { stdout } = run([emptyDir]);
    assert.ok(stdout.includes('No .htaccess files found'));
    fs.rmSync(emptyDir, { recursive: true, force: true });
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

describe('CLI `--errors` filtering', () => {
  const filterDir = path.join(__dirname, 'temp_test_errors');
  let serverProcess;
  let port;

  before(async () => {
    fs.mkdirSync(filterDir, { recursive: true });

    // The server runs in a separate process so `spawnSync` (used by `run()`) does
    // not block its event loop; routes: 200, 301 → 200, 404, /fail (socket reset)
    const serverScript = path.join(filterDir, '_server.js');
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

    fs.writeFileSync(path.join(filterDir, '.htaccess'), [
      `Redirect 301 /a/ http://127.0.0.1:${port}/status-200`,
      `Redirect 301 /b/ http://127.0.0.1:${port}/status-301`,
      `Redirect 301 /c/ http://127.0.0.1:${port}/status-404`,
      `Redirect 301 /d/ http://127.0.0.1:${port}/fail`,
    ].join('\n'));
  });

  after(async () => {
    await new Promise(resolve => {
      serverProcess.once('exit', resolve);
      serverProcess.kill('SIGKILL');
    });
    fs.rmSync(filterDir, { recursive: true, force: true });
  });

  test('Ensures `--errors` shows 404 and connection failure but not 2xx or 3xx results', () => {
    const { stdout, status } = run(['--errors', filterDir]);
    assert.ok(stdout.includes('/status-404'), 'expected 404 result in output');
    assert.ok(stdout.includes('/fail'), 'expected connection failure result in output');
    assert.ok(!stdout.includes('/status-200'), 'unexpected 200 result in output');
    assert.ok(!stdout.includes('/status-301'), 'unexpected 301 result in output');
    assert.strictEqual(status, 1);
  });

  test('Ensures `-e` shows 404 and connection failure but not 2xx or 3xx results', () => {
    const { stdout, status } = run(['-e', filterDir]);
    assert.ok(stdout.includes('/status-404'), 'expected 404 result in output');
    assert.ok(stdout.includes('/fail'), 'expected connection failure result in output');
    assert.ok(!stdout.includes('/status-200'), 'unexpected 200 result in output');
    assert.ok(!stdout.includes('/status-301'), 'unexpected 301 result in output');
    assert.strictEqual(status, 1);
  });
});
