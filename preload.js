const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlist — contextIsolation is on and the renderer gets nothing
// beyond what is named here. Licensing calls were removed with the PRO gate:
// every tab is free.
contextBridge.exposeInMainWorld('electronAPI', {
  // n8n engine
  onN8nProgress: (cb) => ipcRenderer.on('n8n:progress', (_, data) => cb(data)),
  onN8nRestarted: (cb) => {
    ipcRenderer.removeAllListeners('n8n:restarted');
    ipcRenderer.on('n8n:restarted', (_, data) => cb(data));
  },
  n8nRestart: () => ipcRenderer.invoke('n8n:restart'),
  n8nStatus: () => ipcRenderer.invoke('n8n:status'),

  // Claude Code MCP
  mcpInstall: (apiKey) => ipcRenderer.invoke('mcp:install', apiKey),
  mcpUninstall: () => ipcRenderer.invoke('mcp:uninstall'),
  mcpInstallSkills: () => ipcRenderer.invoke('mcp:install-skills'),
  mcpRun: () => ipcRenderer.invoke('mcp:run'),
  mcpStop: () => ipcRenderer.invoke('mcp:stop'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),

  // Cloudflare tunnel
  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  cloudflaredCheck: () => ipcRenderer.invoke('cloudflared:check'),
  cloudflaredInstall: () => ipcRenderer.invoke('cloudflared:install'),
  cloudflaredAuthStatus: () => ipcRenderer.invoke('cloudflared:auth-status'),
  cloudflaredLogin: () => ipcRenderer.invoke('cloudflared:login'),
  cloudflaredTunnelStatus: () => ipcRenderer.invoke('cloudflared:tunnel-status'),
  cloudflaredSetupTunnel: (domain) => ipcRenderer.invoke('cloudflared:setup-tunnel', domain),
  onTunnelUrl: (cb) => ipcRenderer.on('tunnel:url-update', (_, url) => cb(url)),
  onTunnelLog: (cb) => ipcRenderer.on('tunnel:log', (_, text) => cb(text)),

  // Embedded Claude Code terminal
  ptySpawn: (cols, rows, skipPerms) => ipcRenderer.invoke('pty:spawn', cols, rows, skipPerms),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.send('pty:kill'),
  onPtyData: (cb) => {
    ipcRenderer.removeAllListeners('pty:data');
    ipcRenderer.on('pty:data', (_, data) => cb(data));
  },
  onPtyExit: (cb) => {
    ipcRenderer.removeAllListeners('pty:exit');
    ipcRenderer.on('pty:exit', () => cb());
  },

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openN8nData: () => ipcRenderer.invoke('shell:open-n8n-data'),

  // Auto-update (sdk/ui/update-bar.js consumes these)
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
