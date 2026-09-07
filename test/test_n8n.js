'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const N8N = require('../lib/n8n');

// ─── PATH construction ────────────────────────────────────────────────────
// A GUI app launched from Finder gets a launchd PATH without Homebrew or the
// user's own bin dirs, which is how "cloudflared is not installed" was
// reported on machines where it plainly was.

test('buildPath prepends the app install locations so they win', () => {
  const p = N8N.buildPath('/Users/x', 'darwin', '/usr/bin:/bin');
  const parts = p.split(':');
  assert.ok(parts.indexOf('/Users/x/.bun/bin') < parts.indexOf('/usr/bin'),
    'app locations must come before the inherited PATH');
  assert.ok(p.includes('/opt/homebrew/bin'), 'Homebrew must be reachable');
  assert.ok(p.endsWith('/usr/bin:/bin'), 'the inherited PATH must survive');
});

test('buildPath falls back to a usable PATH when the environment has none', () => {
  // Pass '' rather than undefined: undefined triggers the `process.env.PATH`
  // default parameter, which would make this assert against the test
  // machine's own PATH instead of the fallback.
  const p = N8N.buildPath('/Users/x', 'darwin', '');
  assert.ok(p.includes('/usr/bin:/bin'), 'a child process with no PATH must still find /bin');
  assert.ok(!p.includes('::'), 'no empty PATH entry — an empty entry means cwd');
  assert.ok(!p.endsWith(':'));
});

test('buildPath uses Windows separators and locations on win32', () => {
  const p = N8N.buildPath('C:\\Users\\x', 'win32', 'C:\\Windows');
  assert.ok(p.includes(';'), 'win32 separates PATH with ;');
  assert.ok(!p.includes('/opt/homebrew/bin'), 'no POSIX paths on Windows');
  assert.ok(p.includes(path.join('C:\\Users\\x', 'AppData', 'Local', 'Programs', 'claude-code')));
});

// ─── n8n resolution ───────────────────────────────────────────────────────

test('findN8nScript prefers the app own bun install over anything else', () => {
  const home = '/home/u';
  const bunBin = path.join(home, '.bun', 'install', 'global', 'node_modules', 'n8n', 'bin', 'n8n');
  const found = N8N.findN8nScript({
    home,
    platform: 'linux',
    exists: () => true, // everything present: order alone decides
    realpath: (p) => p,
  });
  assert.strictEqual(found, bunBin);
});

test('findN8nScript resolves the bun shim through its symlink target', () => {
  const home = '/home/u';
  const shim = path.join(home, '.bun', 'bin', 'n8n');
  const target = '/real/store/n8n/bin/n8n';
  const found = N8N.findN8nScript({
    home,
    platform: 'linux',
    exists: (p) => p === shim || p === target,
    realpath: (p) => (p === shim ? target : p),
  });
  assert.strictEqual(found, target);
});

test('findN8nScript rejects a dangling shim rather than returning it', () => {
  const home = '/home/u';
  const shim = path.join(home, '.bun', 'bin', 'n8n');
  const found = N8N.findN8nScript({
    home,
    platform: 'linux',
    exists: (p) => p === shim, // the link exists, its target does not
    realpath: () => '/gone/n8n',
  });
  assert.strictEqual(found, null, 'a broken symlink is not a runnable script');
});

test('findN8nScript returns null when n8n is absent', () => {
  assert.strictEqual(N8N.findN8nScript({
    home: '/home/u', platform: 'linux', exists: () => false, realpath: (p) => p,
  }), null);
});

// ─── The domain → environment mapping ─────────────────────────────────────
// This is the bug the 1.1.0 build shipped with: the tunnel worked and webhooks
// still handed out localhost URLs, because n8n was never told its public name.

test('buildN8nEnv publishes the public URL to n8n when a domain is set', () => {
  const env = N8N.buildN8nEnv({
    userFolder: '/data/.n8n',
    encryptionKey: 'k',
    settings: { publicDomain: 'n8n.example.com' },
  });
  assert.strictEqual(env.WEBHOOK_URL, 'https://n8n.example.com');
  assert.strictEqual(env.N8N_EDITOR_BASE_URL, 'https://n8n.example.com');
  assert.strictEqual(env.N8N_PROTOCOL, 'https');
  assert.strictEqual(env.N8N_HOST, '0.0.0.0',
    'N8N_HOST must stay 0.0.0.0 or cloudflared cannot reach the port');
});

test('buildN8nEnv omits the public URL vars entirely when no domain is set', () => {
  const env = N8N.buildN8nEnv({ userFolder: '/data/.n8n', encryptionKey: 'k', settings: {} });
  assert.ok(!('WEBHOOK_URL' in env), 'an unset WEBHOOK_URL must not be defined as empty');
  assert.ok(!('N8N_EDITOR_BASE_URL' in env));
  assert.strictEqual(env.N8N_USER_FOLDER, '/data/.n8n');
  assert.strictEqual(env.ELECTRON_RUN_AS_NODE, '1');
});

test('buildN8nEnv treats a whitespace-only domain as unset', () => {
  const env = N8N.buildN8nEnv({ userFolder: '/d', encryptionKey: 'k', settings: { publicDomain: '   ' } });
  assert.ok(!('WEBHOOK_URL' in env));
});

test('needsRestartForDomain only fires on a change that reaches n8n', () => {
  assert.strictEqual(N8N.needsRestartForDomain({}, { publicDomain: 'a.example.com' }), true);
  assert.strictEqual(N8N.needsRestartForDomain({ publicDomain: 'a.example.com' }, { publicDomain: 'b.example.com' }), true);
  assert.strictEqual(N8N.needsRestartForDomain({ publicDomain: 'a.example.com' }, { publicDomain: 'a.example.com' }), false);
  assert.strictEqual(N8N.needsRestartForDomain({ publicDomain: 'a.example.com' }, { publicDomain: ' a.example.com ' }), false,
    'a whitespace edit must not bounce a running server');
});

// ─── Readiness probe ──────────────────────────────────────────────────────

test('isServerReady demands it actually be n8n, not just a live port', () => {
  assert.strictEqual(N8N.isServerReady(200, '<title>n8n</title>'), true);
  assert.strictEqual(N8N.isServerReady(200, 'grafana'), false,
    'something else squatting on 5678 must not read as ready');
  assert.strictEqual(N8N.isServerReady(502, 'n8n'), false);
  assert.strictEqual(N8N.isServerReady(200, undefined), false);
});

// ─── Port cleanup ─────────────────────────────────────────────────────────

test('killPortCommand targets the right port per platform', () => {
  assert.match(N8N.killPortCommand(5678, 'darwin'), /lsof -ti:5678/);
  assert.match(N8N.killPortCommand(5678, 'win32'), /findstr :5678/);
  assert.match(N8N.killPortCommand(5678, 'win32'), /taskkill/);
});
