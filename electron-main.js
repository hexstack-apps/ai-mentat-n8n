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
const CF = require('./lib/cloudflared');
const MCP = require('./lib/mcp');
const { loadOrCreateKey, KEY_FILE } = require('./lib/encryption-key');
const { quiet, quietAsync, attempt } = require('./lib/failsafe');
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
let cleanupDone = false;
// Set across a deliberate restart so n8n's exit handler does not close the
// window while we are the ones who killed it.
let n8nRestarting = false;

// ─── Settings ─────────────────────────────────────────────────────────────

function loadSettings() {
  return quiet('settings.read', () => JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')), {});
}

function saveSettings(data) {
  const merged = { ...loadSettings(), ...data };
  // Losing this write silently means the next launch forgets a domain the user
  // really did apply, so the failure is recorded rather than swallowed.
  attempt('settings.write', () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2)));
  return merged;
}

// ─── Child-process environment ────────────────────────────────────────────

function shellEnv() {
  return { ...process.env, PATH: N8N.buildPath(os.homedir()) };
}

/**
 * Run a binary with an argument ARRAY — never a composed command string.
 * User input (an n8n API key, a domain) reaches several of these calls, and
 * the shipped build interpolated it into `execSync`, so a value containing a
 * shell metacharacter was executed instead of passed.
 */
function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    ...opts,
    env: { ...shellEnv(), ...opts.env },
  });
}

/** `run` for calls whose failure is expected and non-fatal. */
function tryRun(op, bin, args, opts = {}) {
  return quiet(op, () => run(bin, args, opts), null);
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
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'N8N Mentat',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // The shipped build set webSecurity:false to get n8n into the iframe.
      // It is not needed for that — framing is governed by the response
      // headers stripped below — and turning it off disables the same-origin
      // policy for the whole renderer. Escape hatch for a local diagnosis
      // only; never ship with it set.
      webSecurity: process.env.MENTAT_ALLOW_INSECURE !== '1',
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'default',
    show: false,
  });

  mainWindow.on('closed', () => {
    console.log('Window closed');
    cleanup();
  });
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => console.error('Load failed:', desc));

  // n8n serves X-Frame-Options and a frame-ancestors CSP that would refuse to
  // render inside the app window, and its session cookies need SameSite=None
  // to survive the cross-document embed. Scoped to n8n's own origin: the
  // shipped build applied this to <all_urls>, which stripped the CSP of every
  // page the app could ever load.
  const n8nOrigins = [`http://localhost:${N8N_PORT}/*`, `http://127.0.0.1:${N8N_PORT}/*`];
  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: n8nOrigins }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options' || lower === 'content-security-policy') delete headers[key];
      if (lower === 'set-cookie') {
        headers[key] = headers[key].map((cookie) => (
          /samesite/i.test(cookie)
            ? cookie.replace(/samesite=\w+/i, 'SameSite=None')
            : `${cookie}; SameSite=None; Secure`
        ));
      }
    }
    callback({ responseHeaders: headers });
  });

  mainWindow.loadFile(path.join(__dirname, 'app.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) mainWindow.webContents.openDevTools();
    setupAutoUpdate(mainWindow);
    console.log('N8N Mentat window opened');
  });
}

// ─── Shutdown ─────────────────────────────────────────────────────────────

function killProcess(proc, name) {
  if (!proc || proc.killed) return;
  console.log(`Terminating ${name} (pid ${proc.pid})...`);
  attempt(`kill.${name}.term`, () => {
    if (process.platform === 'win32') run('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGTERM');
  });
  setTimeout(() => {
    // Killing an already-dead process is the expected case here, so this one
    // stays quiet by design.
    try {
      if (!proc.killed) {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
        proc.kill('SIGKILL');
      }
    } catch { /* already gone */ }
  }, 3000);
}

function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  console.log('Cleaning up...');
  killProcess(n8nProcess, 'n8n');
  killProcess(mcpProcess, 'mcp');
  killProcess(tunnelProcess, 'tunnel');
  if (ptyProcess) {
    attempt('kill.pty', () => ptyProcess.kill());
    ptyProcess = null;
  }
  setTimeout(() => app.quit(), 1000);
}

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
  const home = os.homedir();
  for (const scope of MCP.MCP_SCOPES) {
    tryRun(`mcp.remove.${scope}`, 'claude',
      ['mcp', 'remove', MCP.N8N_MCP_SERVER, '-s', scope],
      { timeout: 15000, stdio: 'pipe', cwd: home });
  }
}

ipcMain.handle('mcp:status', async () => {
  const settings = loadSettings();
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const fromConfig = MCP.detectMcpInstalled(
    quiet('mcp.readClaudeJson', () => fs.readFileSync(claudeJson, 'utf8'), null),
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

ipcMain.handle('pty:spawn', async (_, cols, rows, skipPerms) => {
  try {
    if (ptyProcess) {
      attempt('pty.killPrevious', () => ptyProcess.kill());
      ptyProcess = null;
    }
    const home = os.homedir();
    const env = {
      ...shellEnv(),
      TERM: 'xterm-256color',
      COLUMNS: String(cols || 80),
      LINES: String(rows || 24),
    };
    const claudeArgsTail = skipPerms
      ? ['--dangerously-skip-permissions', '/mentat-n8na']
      : ['/mentat-n8na'];

    if (process.platform === 'win32') {
      ptyProcess = spawn('claude', claudeArgsTail, { stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env });
    } else {
      const localClaude = path.join(home, '.local', 'bin', 'claude');
      const bin = fs.existsSync(localClaude) ? localClaude : 'claude';
      // pty-helper.py is asarUnpack'd: a python script inside the archive is
      // not a real path python3 can execute.
      let helperPath = path.join(__dirname, 'pty-helper.py');
      if (app.isPackaged || __dirname.includes('app.asar')) {
        helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
      }
      ptyProcess = spawn('python3', [helperPath, bin, ...claudeArgsTail], {
        stdio: ['pipe', 'pipe', 'pipe'], cwd: home, env,
      });
      ptyProcess.on('error', (e) => console.error('PTY spawn error:', e.message));
    }

    const relay = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', data.toString());
    };
    ptyProcess.stdout.on('data', relay);
    ptyProcess.stderr.on('data', relay);
    ptyProcess.on('exit', (code) => {
      console.log('PTY exited with code:', code);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:exit');
      ptyProcess = null;
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.on('pty:write', (_, data) => {
  if (ptyProcess && !ptyProcess.killed && typeof data === 'string') ptyProcess.stdin.write(data);
});

ipcMain.on('pty:resize', () => {
  // The helper re-reads the window size on SIGWINCH.
  if (ptyProcess && ptyProcess.pid && process.platform !== 'win32') {
    attempt('pty.resize', () => process.kill(ptyProcess.pid, 'SIGWINCH'));
  }
});

ipcMain.on('pty:kill', () => {
  if (!ptyProcess) return;
  if (process.platform !== 'win32') attempt('pty.killGroup', () => process.kill(-ptyProcess.pid, 'SIGTERM'));
  attempt('pty.kill', () => ptyProcess.kill());
  ptyProcess = null;
});

// ─── Shell / app surface ──────────────────────────────────────────────────

ipcMain.handle('shell:open-external', async (_, url) => {
  // Allowlist the scheme: a renderer-supplied string reaching openExternal can
  // otherwise launch file:// or a custom protocol handler.
  if (typeof url !== 'string') return { success: false };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false };
  }
  if (parsed.protocol !== 'https:') return { success: false };
  await shell.openExternal(parsed.toString());
  return { success: true };
});

ipcMain.handle('shell:open-n8n-data', async () => {
  await shell.openPath(n8nFolder);
  return { success: true };
});

ipcMain.handle('n8n:restart', async () => restartN8n());

ipcMain.handle('n8n:status', async () => ({
  running: !!(n8nProcess && !n8nProcess.killed),
  url: N8N_LOCAL_URL,
  publicDomain: loadSettings().publicDomain || null,
  dataDir,
  keyError: encryptionKeyError,
}));

// ─── Cloudflare tunnel ────────────────────────────────────────────────────

const cloudflaredConfigPath = () => path.join(os.homedir(), '.cloudflared', 'config.yml');

function readTunnelConfig() {
  const text = quiet('cloudflared.readConfig', () => fs.readFileSync(cloudflaredConfigPath(), 'utf8'), null);
  if (text === null) return CF.parseTunnelConfig('', N8N_PORT);
  // A parse failure used to report "no hostnames configured" for a perfectly
  // good tunnel, so it gets recorded.
  return quiet('cloudflared.parseConfig', () => CF.parseTunnelConfig(text, N8N_PORT),
    CF.parseTunnelConfig('', N8N_PORT));
}

ipcMain.handle('cloudflared:check', async () => {
  if (tryRun('cloudflared.versionNpx', 'npx', ['cloudflared', '--version'], { timeout: 15000, stdio: 'pipe' }) !== null) {
    return { installed: true };
  }
  if (tryRun('cloudflared.version', 'cloudflared', ['--version'], { timeout: 5000, stdio: 'pipe' }) !== null) {
    return { installed: true };
  }
  return { installed: false };
});

ipcMain.handle('cloudflared:install', async () => {
  try {
    run('npx', ['bun', 'add', '-g', 'cloudflared'], { timeout: 60000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('cloudflared:auth-status', async () => ({
  authenticated: fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem')),
}));

ipcMain.handle('cloudflared:login', async () => new Promise((resolve) => {
  let proc;
  try {
    proc = spawn('cloudflared', ['tunnel', 'login'], { stdio: 'pipe', detached: true, env: shellEnv() });
  } catch (e) {
    return resolve({ success: false, error: e.message });
  }
  let output = '';
  const collect = (d) => { output += d.toString(); };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);
  proc.on('error', (e) => resolve({ success: false, error: e.message }));
  const timer = setTimeout(() => {
    attempt('cloudflared.login.killTimeout', () => proc.kill());
    resolve({ success: false, error: 'Login timed out' });
  }, 300000);
  proc.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ success: true });
    else resolve({ success: false, error: output.trim() || `Exit code ${code}` });
  });
}));

ipcMain.handle('cloudflared:tunnel-status', async () => {
  const cfg = readTunnelConfig();
  return { configured: cfg.configured, tunnelName: cfg.tunnel, hostname: cfg.hostname };
});

ipcMain.handle('cloudflared:setup-tunnel', async (_, domain) => {
  const hostname = typeof domain === 'string' ? domain.trim() : '';
  if (!hostname) return { success: false, error: 'Domain is required' };
  if (!CF.isValidHostname(hostname)) {
    return { success: false, error: `"${hostname}" is not a valid hostname — use something like n8n.example.com` };
  }

  try {
    const tunnelName = 'mentat';
    const cfDir = path.join(os.homedir(), '.cloudflared');
    let tunnelId = null;

    const list = tryRun('cloudflared.list', 'cloudflared', ['tunnel', 'list', '-o', 'json'],
      { timeout: 15000, stdio: 'pipe' });
    if (list) {
      const tunnels = quiet('cloudflared.parseList', () => JSON.parse(list), []);
      const existing = Array.isArray(tunnels) ? tunnels.find((t) => t && t.name === tunnelName) : null;
      if (existing) {
        if (fs.existsSync(path.join(cfDir, `${existing.id}.json`))) {
          tunnelId = existing.id;
        } else {
          // The tunnel exists server-side but its credentials file is gone, so
          // it can never be run from this machine. Recreate rather than fail.
          console.log('Tunnel exists but credentials missing locally, recreating...');
          tryRun('cloudflared.delete', 'cloudflared', ['tunnel', 'delete', '-f', tunnelName],
            { timeout: 15000, stdio: 'pipe' });
        }
      }
    }

    if (!tunnelId) {
      const out = run('cloudflared', ['tunnel', 'create', tunnelName], { timeout: 15000, stdio: 'pipe' });
      tunnelId = CF.parseTunnelId(out);
      if (!tunnelId) return { success: false, error: `Failed to parse tunnel ID from: ${out}` };
    }

    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(cloudflaredConfigPath(), CF.renderTunnelConfig({
      tunnelId,
      credentialsFile: path.join(cfDir, `${tunnelId}.json`),
      hostname,
      port: N8N_PORT,
    }));

    try {
      run('cloudflared', ['tunnel', 'route', 'dns', '--overwrite-dns', tunnelId, hostname],
        { timeout: 15000, stdio: 'pipe' });
    } catch (e) {
      const err = (e.stderr && e.stderr.toString()) || '';
      if (!err.includes('already exists')) {
        return { success: false, error: `DNS route failed: ${err.trim() || e.message}` };
      }
    }

    // Persist the domain and hand n8n its public URL. Without this the tunnel
    // resolves but every webhook n8n hands out still says localhost.
    const previous = loadSettings();
    saveSettings({ publicDomain: hostname });
    const restartNeeded = N8N.needsRestartForDomain(previous, { publicDomain: hostname });

    return {
      success: true,
      tunnelId,
      hostname,
      url: `https://${hostname}`,
      restartNeeded,
      restartHint: restartNeeded ? 'Restart n8n to apply the new public domain.' : null,
    };
  } catch (e) {
    return { success: false, error: (e.stderr && e.stderr.toString().trim()) || e.message };
  }
});

ipcMain.handle('tunnel:start', async () => {
  if (tunnelProcess && !tunnelProcess.killed) return { success: true, url: tunnelUrl };
  try {
    const { hostname } = readTunnelConfig();
    if (!hostname) return { success: false, error: 'No tunnel configured — complete setup first' };

    tunnelProcess = spawn('cloudflared', ['tunnel', 'run'], { stdio: 'pipe', detached: true, env: shellEnv() });
    tunnelUrl = null;

    const sendLog = (text) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tunnel:log', text);
    };
    let connected = false;
    const onOutput = (data) => {
      const text = data.toString();
      sendLog(text);
      if (!connected && CF.isTunnelConnectedLine(text)) {
        connected = true;
        tunnelUrl = `https://${hostname}`;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tunnel:url-update', tunnelUrl);
      }
    };
    tunnelProcess.stdout.on('data', onOutput);
    tunnelProcess.stderr.on('data', onOutput);
    tunnelProcess.on('exit', (code) => {
      sendLog(`\n[cloudflared exited with code ${code}]\n`);
      tunnelProcess = null;
      tunnelUrl = null;
    });

    for (let i = 0; i < 20 && !tunnelUrl; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!tunnelUrl) return { success: false, error: 'Named tunnel failed to connect' };
    return { success: true, url: tunnelUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('tunnel:stop', async () => {
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
    tunnelUrl = null;
  }
  return { success: true };
});

ipcMain.handle('tunnel:status', async () => ({
  running: !!(tunnelProcess && !tunnelProcess.killed),
  url: tunnelUrl,
}));

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
