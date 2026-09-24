'use strict';
//
// Per-install n8n encryption key.
//
// WHY THIS REPLACES config.js
// ---------------------------
// The shipped 1.1.0 build read N8N_ENCRYPTION_KEY from a committed `config.js`
// holding the literal string:
//
//     'your-super-long-random-encryption-key-here-replace-this'
//
// n8n uses that key to encrypt every stored credential — API tokens, database
// passwords, OAuth secrets. A constant baked into a public repo means every
// install shares one key, so anyone who copies a `.n8n` directory (a backup, a
// synced folder, a support bundle) can decrypt the credentials in it with a
// value published on GitHub.
//
// The key is now generated once per install, kept out of git, and stored
// 0600 next to the data it protects. Changing the key makes existing
// credentials undecryptable, so an existing key is NEVER regenerated — a
// present-but-unreadable key file is a hard error, not a cue to overwrite.

const crypto = require('crypto');

const KEY_FILE = 'n8n-encryption-key';
/** 32 bytes of CSPRNG output, hex-encoded. n8n takes an arbitrary-length string. */
const KEY_BYTES = 32;

function generateKey(randomBytes = crypto.randomBytes) {
  return randomBytes(KEY_BYTES).toString('hex');
}

/** A key we are willing to use: non-empty, no whitespace, plausibly random. */
function isUsableKey(value) {
  return typeof value === 'string' && value.trim().length >= 32 && !/\s/.test(value.trim());
}

/**
 * Load the install's key, creating it on first run.
 *
 * All io is injected so this is testable without touching a disk:
 * @param {object} io
 * @param {(p:string)=>boolean} io.exists
 * @param {(p:string)=>string} io.read
 * @param {(p:string,d:string)=>void} io.write   must apply 0600
 * @returns {{key: string, created: boolean}}
 * @throws when a key file exists but holds nothing usable — overwriting it
 *         would silently orphan every credential n8n has already stored.
 */
function loadOrCreateKey(keyPath, io, randomBytes = crypto.randomBytes) {
  if (io.exists(keyPath)) {
    const existing = io.read(keyPath);
    if (isUsableKey(existing)) return { key: existing.trim(), created: false };
    throw new Error(
      `n8n encryption key at ${keyPath} is unreadable or empty.\n`
      + '  Refusing to replace it: a new key would make every credential n8n has\n'
      + '  already stored permanently undecryptable.\n'
      + '  Restore the file from a backup, or delete it AND the credentials in\n'
      + '  the .n8n directory to start over.',
    );
  }
  const key = generateKey(randomBytes);
  io.write(keyPath, key);
  return { key, created: true };
}

module.exports = { KEY_FILE, KEY_BYTES, generateKey, isUsableKey, loadOrCreateKey };
