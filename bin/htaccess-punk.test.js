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

// Permission bits don’t apply to root, and `chmod` is a no-op on Windows
const canTestPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

function run(args) {
  const result = spawnSync('node', [scriptPath, ...args], { encoding: 'utf-8', timeout: 30_000 });
  return {
    stdout: stripVTControlCharacters(result.stdout),
    stderr: stripVTControlCharacters(result.stderr),
    status: result.status,
  };
}

describe('Find .htaccess files', () => {
  const dirTemp = path.join(__dirname, 'temp_test_find');

  before(() => {
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
    try {
      const files = await findHtaccessFiles(dirTemp);
      assert.ok(files.length > 0, 'Readable branches are still collected');
    } finally {
      fs.chmodSync(dirLocked, 0o755);
      fs.rmSync(dirLocked, { recursive: true, force: true });
    }
  });

  test('Ensures `check()` returns `urlToFiles` mapping target URLs to their source files', async () => {
    const dir = path.join(__dirname, 'temp_test_check_api');
    fs.mkdirSync(dir, { recursive: true });
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

  test('Extracts RewriteRule targets with IPv6 hosts', () => {
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
  const dirTemp = path.join(__dirname, 'temp_test_cli');

  before(() => {
    fs.mkdirSync(dirTemp, { recursive: true });
    fs.writeFileSync(path.join(dirTemp, '.htaccess'), [
      'Redirect 301 /a/ https://example.com/',
      'RedirectMatch 301 ^/b/(.*)$ https://example.com/$1',
    ].join('\n'));
  });

  after(() => {
    fs.rmSync(dirTemp, { recursive: true, force: true });
  });

  // Without these, an unusable target walks to nothing and prints the same
  // “No .htaccess files found.” a genuinely empty directory does, exiting “0”
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
    const { stdout } = run([dirEmpty]);
    assert.ok(stdout.includes('No .htaccess files found'));
    fs.rmSync(dirEmpty, { recursive: true, force: true });
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
    const dirFilter = path.join(__dirname, 'temp_test_errors');
    let serverProcess;
    let port;

    before(async () => {
      fs.mkdirSync(dirFilter, { recursive: true });

      // The server runs in a separate process so `spawnSync` (used by `run()`) does
      // not block its event loop; routes: 200, 301 → 200, 404, /fail (socket reset)
      const serverScript = path.join(dirFilter, '_server.js');
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
