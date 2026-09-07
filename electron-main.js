'use strict';
//
// Hexstack Mentat N8NA — main process.
//
// Recovered from the shipped 1.1.0 build (app.asar) and restructured onto the
// current ai-mentat conventions: pure logic in `lib/` with tests, shared
// build/update plumbing in the `sdk/` submodule, no bare `catch {}`.
//
// EDIT THIS FILE, not electron-main.bundle.js — the bundle is esbuild output
// regenerated before every run and every package.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const N8N = require('./lib/n8n');
const MCP = require('./lib/mcp');
const { loadOrCreateKey, KEY_FILE } = require('./lib/encryption-key');
const { quiet, attempt } = require('./sdk/utils/failsafe');
const { shellEnv: sdkShellEnv, run, tryRun } = require('./sdk/utils/env');
const { killProcess, createCleanup } = require('./sdk/utils/proc');
const { createSettingsStore } = require('./sdk/logic/settings');
const { registerOpenExternal, openPathHandler } = require('./sdk/logic/shell');
const { registerPtyIpc, resolveHelperPath } = require('./sdk/logic/pty');
const { registerTunnelIpc } = require('./sdk/logic/tunnel-ipc');
const { detectMcpInstalled, removeAllScopes } = require('./sdk/logic/mcp');
const { createWindow: createWindow_ } = require('./sdk/ui/window');
const { resolveDataDir } = require('./sdk/utils/data-dir');
const { setupAutoUpdate } = require('./sdk/logic/auto-update');

const APP_NAME = 'ai-mentat-n8n';
const N8N_PORT = N8N.N8N_PORT;
const N8N_LOCAL_URL = `http://localhost:${N8N_PORT}`;

// ─── Persistent storage layout ────────────────────────────────────────────
//
//   <dataDir>/
//     .n8n/                    n8n's own home (workflows, credentials, sqlite)
//     n8n-encryption-key       0600, generated once per install
//     mentat-settings.json     this app's settings (publicDomain, install flags)
//
// <dataDir> is the shared family contract from sdk/utils/data-dir:
// `/.hexstack-app/ai-mentat-n8n/data`, falling back to
// `~/.hexstack-app/ai-mentat-n8n/data` when the filesystem root is not
// writable. `npm run setup` prepares the root location.

const dataDir = resolveDataDir(APP_NAME);
const n8nFolder = path.join(dataDir, '.n8n');
const SETTINGS_FILE = path.join(dataDir, 'mentat-settings.json');

fs.mkdirSync(n8nFolder, { recursive: true });
process.env.N8N_USER_FOLDER = n8nFolder;

// n8n encrypts stored credentials with this key. It is generated per install
// and never committed — see lib/encryption-key.js for why that matters.
let encryptionKey = null;
let encryptionKeyError = null;
try {
  const result = loadOrCreateKey(path.join(dataDir, KEY_FILE), {
    exists: (p) => fs.existsSync(p),
    read: (p) => fs.readFileSync(p, 'utf8'),
    write: (p, data) => fs.writeFileSync(p, data, { mode: 0o600 }),
  });
  encryptionKey = result.key;
  if (result.created) console.log(`Generated n8n encryption key at ${path.join(dataDir, KEY_FILE)}`);
} catch (e) {
  // Starting n8n with a fresh key here would orphan existing credentials, so
  // the app reports the problem instead of papering over it.
  encryptionKeyError = e.message;
  console.error(e.message);
}

// ─── Globals ──────────────────────────────────────────────────────────────

let mainWindow;
let n8nProcess;
let ptyProcess;
let mcpProcess;
let tunnelProcess;
let tunnelUrl = null;
// Set across a deliberate restart so n8n's exit handler does not close the
// window while we are the ones who killed it.
let n8nRestarting = false;

// ─── Settings ─────────────────────────────────────────────────────────────

// n8n keeps its own filename: the other apps use settings.json, and renaming
// this one would silently discard every existing user's settings.
const settings = createSettingsStore({ dir: dataDir, file: 'mentat-settings.json' });
const loadSettings = () => settings.load();
const saveSettings = (patch) => settings.save(patch);

// ─── Child-process environment ────────────────────────────────────────────

function shellEnv() {
  return sdkShellEnv({ home: os.homedir() });
}

// ─── n8n lifecycle ────────────────────────────────────────────────────────

function findN8nScript() {
  return N8N.findN8nScript({
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync(p),
  });
}

function sendProgress(phase, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('n8n:progress', { phase, detail });
  }
}

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: N8N_PORT, path: '/', method: 'GET', timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(N8N.isServerReady(res.statusCode, body)));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForServer(attempts = 30) {
  console.log('Waiting for n8n server...');
  for (let i = 0; i < attempts; i++) {
    if (await checkServerReady()) {
      console.log('n8n server ready');
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`n8n server failed to start within ${attempts} seconds`);
}

/** Wait for the port to stop answering, so a respawn can bind it. */
async function waitForPortFree(attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    if (!(await checkServerReady())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function freePort() {
  // Best-effort: nothing may be listening, which is the normal case.
  attempt('n8n.freePort', () => {
    const cmd = N8N.killPortCommand(N8N_PORT);
    execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd],
      { stdio: 'ignore' });
  });
}

function installN8nGlobally(label) {
  console.log(`${label} n8n globally via bun...`);
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['bun', 'add', '-g', 'n8n'], { stdio: 'pipe', env: shellEnv() });
    const relay = (d) => sendProgress('installing', d.toString().trim());
    child.stdout.on('data', (d) => { console.log(`bun: ${d}`); relay(d); });
    child.stderr.on('data', (d) => { console.warn(`bun: ${d}`); relay(d); });
    child.on('error', reject);
    const timer = setTimeout(() => {
      attempt('n8n.install.killTimeout', () => child.kill());
      reject(new Error('n8n install timed out after 10 minutes'));
    }, 600000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      // bun exits non-zero on warnings it has already recovered from; the
      // only question that matters is whether n8n is now present.
      if (findN8nScript()) {
        console.warn(`bun exited with code ${code} but n8n is present, continuing`);
        return resolve();
      }
      reject(new Error(`bun add -g n8n exited with code ${code}`));
    });
  });
}

function spawnN8n(n8nScript) {
  const env = N8N.buildN8nEnv({
    baseEnv: shellEnv(),
    userFolder: n8nFolder,
    encryptionKey,
    settings: loadSettings(),
  });
  const child = spawn(process.execPath, [n8nScript, 'start'], { env, stdio: 'pipe', detached: true });
  child.stdout.on('data', (d) => console.log(`n8n: ${d}`));
  child.stderr.on('data', (d) => console.error(`n8n error: ${d}`));
  child.on('exit', (code) => {
    console.log(`n8n exited with code ${code}`);
    // A restart kills n8n on purpose — closing the window there would quit the
    // app every time the user applied a domain.
    if (n8nRestarting) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  return child;
}

async function startN8n() {
  console.log('Starting n8n...');
  if (encryptionKeyError) {
    sendProgress('error', 'n8n encryption key unavailable — see the log for how to recover it.');
    throw new Error(encryptionKeyError);
  }
  freePort();

  if (!findN8nScript()) {
    sendProgress('installing', 'Installing n8n...');
    try {
      await installN8nGlobally('Installing');
    } catch (e) {
      console.error('n8n install failed:', e.message);
      sendProgress('error', 'Failed to install n8n. Check internet connection.');
      throw e;
    }
  }

  const n8nScript = findN8nScript();
  if (!n8nScript) {
    sendProgress('error', 'n8n not found. Try: bun add -g n8n');
    throw new Error('n8n not found');
  }
  console.log('Using n8n script:', n8nScript);
  sendProgress('starting', 'Starting n8n server...');

  n8nProcess = spawnN8n(n8nScript);
  return new Promise((resolve, reject) => {
    n8nProcess.on('error', reject);
    if (n8nProcess.pid) resolve();
    else n8nProcess.once('spawn', resolve);
  });
}

/**
 * Restart n8n so a changed environment takes effect.
 *
 * n8n reads WEBHOOK_URL / N8N_EDITOR_BASE_URL only at boot, so applying a
 * tunnel domain without this leaves the running server handing out localhost
 * webhook URLs to external services.
 */
async function restartN8n() {
  const script = findN8nScript();
  if (!script) return { success: false, error: 'n8n is not installed yet' };

  n8nRestarting = true;
  try {
    if (n8nProcess && !n8nProcess.killed) {
      killProcess(n8nProcess, 'n8n');
      // Give it a grace period to exit on its own before forcing the port.
      const freed = await waitForPortFree(10);
      if (!freed) freePort();
    }
    n8nProcess = spawnN8n(script);
    await waitForServer();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('n8n:restarted', { url: N8N_LOCAL_URL });
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    n8nRestarting = false;
  }
}

// ─── Window ───────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = createWindow_({
    BrowserWindow,
    width: 1200,
    height: 800,
    title: 'N8N Mentat',
    icon: path.join(__dirname, 'icon.png'),
    preload: path.join(__dirname, 'preload.js'),
    load: { file: path.join(__dirname, 'app.html') },
    // n8n serves X-Frame-Options and a frame-ancestors CSP that would refuse
    // to render in the window, and its session cookies need SameSite=None to
    // survive the cross-document embed. Scoped to n8n's own origin.
    headerRewrite: {
      urls: [`http://localhost:${N8N_PORT}/*`, `http://127.0.0.1:${N8N_PORT}/*`],
      stripFrameHeaders: true,
      sameSiteNone: true,
    },
    onReady: (win) => setupAutoUpdate(win),
  });

  mainWindow.on('closed', () => {
    console.log('Window closed');
    cleanup();
  });
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => console.error('Load failed:', desc));
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

const cleanup = createCleanup(() => {
  console.log('Cleaning up...');
  killProcess(n8nProcess, 'n8n');
  killProcess(mcpProcess, 'mcp');
  killProcess(tunnelProcess, 'tunnel');
  if (ptyProcess) {
    attempt('kill.pty', () => ptyProcess.kill());
    ptyProcess = null;
  }
  setTimeout(() => app.quit(), 1000);
});

// ─── MCP (Claude Code) ────────────────────────────────────────────────────

/** Delete npx cache entries holding a half-written n8n-mcp install. */
function cleanNpxMcpCache() {
  attempt('mcp.npxCacheCleanup', () => {
    const npxDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(npxDir)) return;
    for (const entry of fs.readdirSync(npxDir)) {
      const entryDir = path.join(npxDir, entry);
      const pkgDir = path.join(entryDir, 'node_modules', MCP.N8N_MCP_SERVER);
      const pkgJson = path.join(pkgDir, 'package.json');
      const corrupt = MCP.isCorruptNpxEntry({
        hasPackageDir: fs.existsSync(pkgDir),
        packageJsonText: quiet('mcp.readNpxPkg', () => fs.readFileSync(pkgJson, 'utf8'), null),
      });
      if (corrupt) {
        console.log(`Cleaning corrupted npx cache: ${entryDir}`);
        fs.rmSync(entryDir, { recursive: true, force: true });
      }
    }
  });
}

function writeMentatCommand() {
  return attempt('mcp.writeCommand', () => {
    const commandsDir = path.join(os.homedir(), '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'mentat-n8na.md'), MCP.mentatCommandDoc({ apiUrl: N8N_LOCAL_URL }));
  });
}

function removeMcpFromAllScopes() {
  removeAllScopes(MCP.N8N_MCP_SERVER, { run, cwd: os.homedir() });
}

ipcMain.handle('mcp:status', async () => {
  const settings = loadSettings();
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const fromConfig = detectMcpInstalled(
    quiet('mcp.readClaudeJson', () => fs.readFileSync(claudeJson, 'utf8'), null),
    MCP.N8N_MCP_SERVER,
  );
  const skillsDir = path.join(os.homedir(), '.claude', 'skills', 'n8n-skills');
  return {
    mcpInstalled: !!settings.mcpInstalled || fromConfig,
    skillsInstalled: !!settings.skillsInstalled || fs.existsSync(skillsDir),
    mcpRunning: !!(mcpProcess && !mcpProcess.killed),
  };
});

ipcMain.handle('mcp:install', async (_, apiKey) => {
  if (apiKey != null && typeof apiKey !== 'string') return { success: false, error: 'Invalid API key' };
  try {
    cleanNpxMcpCache();
    removeMcpFromAllScopes();
    run('claude', MCP.mcpAddArgs({ apiKey, apiUrl: N8N_LOCAL_URL }), { timeout: 30000, cwd: os.homedir() });
    // Warm the npx cache so the first Claude Code call is not a cold download.
    tryRun('mcp.warmCache', 'npx', ['--yes', MCP.N8N_MCP_SERVER, '--help'], { timeout: 60000, stdio: 'ignore' });
    writeMentatCommand();
    saveSettings({ mcpInstalled: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('mcp:uninstall', async () => {
  removeMcpFromAllScopes();
  saveSettings({ mcpInstalled: false });
  return { success: true };
});

ipcMain.handle('mcp:install-skills', async () => {
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const skillsDir = path.join(claudeDir, 'skills', 'n8n-skills');
    if (fs.existsSync(skillsDir)) {
      run('git', ['pull'], { timeout: 30000, cwd: skillsDir });
    } else {
      fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
      run('git', ['clone', 'https://github.com/czlonkowski/n8n-skills.git', skillsDir], { timeout: 60000 });
    }
    writeMentatCommand();
    saveSettings({ skillsInstalled: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('mcp:run', async () => {
  if (mcpProcess && !mcpProcess.killed) return { success: true };
  try {
    mcpProcess = spawn('npx', [MCP.N8N_MCP_SERVER], {
      env: {
        ...shellEnv(),
        MCP_MODE: 'stdio',
        LOG_LEVEL: 'error',
        DISABLE_CONSOLE_OUTPUT: 'true',
        N8N_API_URL: N8N_LOCAL_URL,
      },
      stdio: 'pipe',
      detached: true,
    });
    mcpProcess.on('exit', () => { mcpProcess = null; });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('mcp:stop', async () => {
  if (mcpProcess && !mcpProcess.killed) {
    mcpProcess.kill('SIGTERM');
    mcpProcess = null;
  }
  return { success: true };
});

// ─── Embedded terminal ────────────────────────────────────────────────────

const localClaude = path.join(os.homedir(), '.local', 'bin', 'claude');
registerPtyIpc(ipcMain, {
  getWindow: () => mainWindow,
  command: fs.existsSync(localClaude) ? localClaude : 'claude',
  args: ['/mentat-n8na'],
  cwd: os.homedir(),
  env: { ...shellEnv(), TERM: 'xterm-256color' },
  helperPath: resolveHelperPath(path.join(__dirname, 'sdk', 'utils'), { isPackaged: app.isPackaged }),
  deps: { spawn },
});

// ─── Shell / app surface ──────────────────────────────────────────────────

registerOpenExternal(ipcMain, shell);
ipcMain.handle('shell:open-n8n-data', openPathHandler(shell, n8nFolder));

ipcMain.handle('n8n:restart', async () => restartN8n());

ipcMain.handle('n8n:status', async () => ({
  running: !!(n8nProcess && !n8nProcess.killed),
  url: N8N_LOCAL_URL,
  publicDomain: loadSettings().publicDomain || null,
  dataDir,
  keyError: encryptionKeyError,
}));

// ─── Cloudflare tunnel ────────────────────────────────────────────────────

registerTunnelIpc(ipcMain, {
  getWindow: () => mainWindow,
  tunnelName: 'mentat',
  services: [{ name: 'web', scheme: 'http', port: N8N_PORT }],
  settings,
  configPath: path.join(os.homedir(), '.cloudflared', 'config.yml'),
  credentialsDir: path.join(os.homedir(), '.cloudflared'),
  deps: { run, tryRun, spawn, fs },
});

// ─── App lifecycle ────────────────────────────────────────────────────────

async function launchN8n() {
  if (n8nProcess && !n8nProcess.killed) return;
  createWindow();
  try {
    await startN8n();
    await waitForServer();
  } catch (error) {
    console.error('Failed to start n8n:', error.message);
  }
}

app.setName('N8N Mentat');

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'icon.png'));
  cleanNpxMcpCache();
  await launchN8n();
});

app.on('window-all-closed', () => cleanup());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) launchN8n();
});
app.on('before-quit', () => cleanup());
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (e) => {
  console.error('Uncaught:', e);
  cleanup();
});
