'use strict';
//
// Pure n8n supervision logic — no electron, no side effects.
//
// WHY THIS EXISTS
// ---------------
// `electron-main.js` cannot be loaded outside Electron (`require('electron')`
// throws under plain node) and it exports nothing, so PATH construction,
// n8n resolution and the domain→env mapping had zero test coverage in the
// shipped 1.1.0 build. Everything here takes injected probes instead of
// touching the filesystem, so macOS-only paths stay verifiable on Linux.
//
// Rule for this repo: new platform-conditional or parsing logic goes in
// `lib/` with a test.

const path = require('path');

/** n8n's fixed local port. The tunnel config and the readiness probe agree on it. */
const N8N_PORT = 5678;

/**
 * PATH for every child process the app spawns.
 *
 * A GUI app launched from Finder inherits a launchd PATH *without*
 * `/opt/homebrew/bin`, `~/.local/bin` or `~/.bun/bin` — so `claude`, `bun`
 * and `cloudflared` all read as "not installed" for anyone who did not start
 * the app from a terminal. These entries are PREPENDED so the app's own
 * install locations win over whatever else is on the machine.
 */
function buildPath(home, platform = process.platform, envPath = process.env.PATH) {
  const isWin = platform === 'win32';
  const sep = isWin ? ';' : ':';
  const extra = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
  if (isWin) {
    extra.push(
      path.join(home, 'AppData', 'Roaming', 'npm'),
      path.join(home, 'AppData', 'Local', 'Programs', 'claude-code'),
    );
  } else {
    extra.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  // Guard the empty case: joining onto '' would leave a trailing separator,
  // which some shells read as "current directory".
  const base = envPath || (isWin ? '' : '/usr/bin:/bin');
  return base ? extra.join(sep) + sep + base : extra.join(sep);
}

/**
 * Where an n8n install could live, in resolution order.
 *
 * The app installs n8n itself with `bun add -g n8n`, so its own location is
 * checked first: behaviour must not change based on what the user happens to
 * have installed globally. The npm locations are a fallback for a machine that
 * already had n8n before the app was ever run.
 */
function n8nScriptCandidates(home, platform = process.platform) {
  const bunGlobal = path.join(home, '.bun', 'install', 'global', 'node_modules', 'n8n');
  const candidates = [
    path.join(bunGlobal, 'bin', 'n8n'),
    path.join(bunGlobal, 'dist', 'index.js'),
  ];
  if (platform === 'win32') {
    candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'n8n', 'bin', 'n8n'));
  } else {
    candidates.push(
      '/opt/homebrew/lib/node_modules/n8n/bin/n8n',
      '/usr/local/lib/node_modules/n8n/bin/n8n',
    );
  }
  return candidates;
}

/**
 * Resolve the n8n entry script, or null when none is installed.
 *
 * `exists` and `realpath` are injected so this is testable without a real
 * n8n install. The `~/.bun/bin/n8n` shim is resolved through realpath because
 * it is a symlink into the global store — and a DANGLING symlink must not be
 * returned as a usable script, which is why the target is re-checked.
 */
function findN8nScript({ home, platform = process.platform, exists, realpath }) {
  for (const candidate of n8nScriptCandidates(home, platform)) {
    if (exists(candidate)) return candidate;
  }
  const shim = path.join(home, '.bun', 'bin', 'n8n');
  if (exists(shim)) {
    let resolved = null;
    try {
      resolved = realpath(shim);
    } catch {
      return null;
    }
    if (resolved && exists(resolved)) return resolved;
  }
  return null;
}

/**
 * Environment for the n8n child process.
 *
 * The domain half is the fix for the bug the 1.1.0 build shipped with: the
 * tunnel-domain field in the GUI only ever wrote `~/.cloudflared/config.yml`,
 * so n8n itself never learned its public URL. Webhook nodes then handed out
 * `http://localhost:5678/webhook/...` to external services, which is
 * unreachable — the tunnel worked and webhooks still did not.
 *
 * `N8N_HOST` stays `0.0.0.0` regardless: cloudflared connects to the port from
 * outside the process, so binding to the domain name would break the tunnel.
 */
function buildN8nEnv({ baseEnv = {}, userFolder, encryptionKey, settings = {}, port = N8N_PORT }) {
  const env = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    N8N_USER_FOLDER: userFolder,
    N8N_ENCRYPTION_KEY: encryptionKey,
    N8N_HOST: '0.0.0.0',
    N8N_PORT: String(port),
  };
  const domain = typeof settings.publicDomain === 'string' ? settings.publicDomain.trim() : '';
  if (domain) {
    const base = `https://${domain}`;
    env.N8N_PROTOCOL = 'https';
    env.N8N_EDITOR_BASE_URL = base;
    env.WEBHOOK_URL = base;
  }
  return env;
}

/**
 * True when the two settings would produce a different n8n environment, i.e.
 * a restart is actually needed. Comparing the *rendered env* rather than the
 * raw field means a whitespace-only edit does not bounce a running server.
 */
function needsRestartForDomain(previous, next) {
  const render = (s) => buildN8nEnv({ userFolder: '', encryptionKey: '', settings: s || {} });
  const a = render(previous);
  const b = render(next);
  return a.N8N_EDITOR_BASE_URL !== b.N8N_EDITOR_BASE_URL
    || a.WEBHOOK_URL !== b.WEBHOOK_URL
    || a.N8N_PROTOCOL !== b.N8N_PROTOCOL;
}

/** Command that frees the n8n port before a (re)start. Platform-conditional. */
function killPortCommand(port = N8N_PORT, platform = process.platform) {
  if (platform === 'win32') {
    return `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do taskkill /F /PID %a`;
  }
  return `lsof -ti:${port} | xargs kill -9`;
}

/**
 * Is an HTTP probe of the local port actually n8n?
 *
 * A 200 alone is not enough — anything at all could be squatting on 5678, and
 * loading the window against a stranger's server is worse than waiting. The
 * body check is what distinguishes "n8n is up" from "the port is taken".
 */
function isServerReady(statusCode, body) {
  return statusCode === 200 && typeof body === 'string' && body.includes('n8n');
}

module.exports = {
  N8N_PORT,
  buildPath,
  n8nScriptCandidates,
  findN8nScript,
  buildN8nEnv,
  needsRestartForDomain,
  killPortCommand,
  isServerReady,
};
