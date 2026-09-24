'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const N8N = require('../lib/n8n');

// PATH construction moved to sdk/utils/env and is tested there.




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
