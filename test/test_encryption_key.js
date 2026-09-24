'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const KEY = require('../lib/encryption-key');

/** In-memory io double, so nothing here touches a disk. */
function fakeIo(initial = {}) {
  const files = { ...initial };
  return {
    files,
    exists: (p) => p in files,
    read: (p) => files[p],
    write: (p, data) => { files[p] = data; },
  };
}

test('a fresh install generates a key and persists it', () => {
  const io = fakeIo();
  const { key, created } = KEY.loadOrCreateKey('/d/n8n-encryption-key', io);
  assert.strictEqual(created, true);
  assert.strictEqual(io.files['/d/n8n-encryption-key'], key);
  assert.strictEqual(key.length, KEY.KEY_BYTES * 2, '32 random bytes, hex encoded');
});

test('two installs do not share a key', () => {
  // The shipped build read one literal from a committed config.js, so every
  // install encrypted its credentials with a value published on GitHub.
  const a = KEY.loadOrCreateKey('/a/k', fakeIo()).key;
  const b = KEY.loadOrCreateKey('/b/k', fakeIo()).key;
  assert.notStrictEqual(a, b);
});

test('an existing key is reused, never regenerated', () => {
  // Regenerating would make every credential n8n already stored undecryptable.
  const existing = 'f'.repeat(64);
  const io = fakeIo({ '/d/k': existing });
  const { key, created } = KEY.loadOrCreateKey('/d/k', io);
  assert.strictEqual(key, existing);
  assert.strictEqual(created, false);
});

test('surrounding whitespace in the stored key is tolerated', () => {
  const io = fakeIo({ '/d/k': `${'a'.repeat(64)}\n` });
  assert.strictEqual(KEY.loadOrCreateKey('/d/k', io).key, 'a'.repeat(64));
});

test('an unreadable existing key is a hard error, not a silent replacement', () => {
  for (const bad of ['', '   \n', 'short', 'has space in it padded out to length xxxxxxxxxx']) {
    const io = fakeIo({ '/d/k': bad });
    assert.throws(() => KEY.loadOrCreateKey('/d/k', io), /unreadable or empty/,
      `must refuse to overwrite: ${JSON.stringify(bad)}`);
    assert.strictEqual(io.files['/d/k'], bad, 'the existing file must be left untouched');
  }
});

test('isUsableKey enforces a minimum length and no whitespace', () => {
  assert.strictEqual(KEY.isUsableKey('a'.repeat(32)), true);
  assert.strictEqual(KEY.isUsableKey('a'.repeat(31)), false, 'too short to be worth using');
  assert.strictEqual(KEY.isUsableKey('key with spaces padded out past the length limit'), false);
  assert.strictEqual(KEY.isUsableKey(undefined), false);
  assert.strictEqual(KEY.isUsableKey(''), false);
});

test('generateKey draws from the injected CSPRNG', () => {
  const key = KEY.generateKey(() => Buffer.alloc(KEY.KEY_BYTES, 0xab));
  assert.strictEqual(key, 'ab'.repeat(KEY.KEY_BYTES));
});
