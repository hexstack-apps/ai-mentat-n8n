const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Licensing
  licenseValidate: () => ipcRenderer.invoke('license:validate'),
  licenseActivate: () => ipcRenderer.invoke('license:activate'),
  licensePoll: (requestData) => ipcRenderer.invoke('license:poll', requestData),
  licenseStatus: () => ipcRenderer.invoke('license:status'),

  onN8nProgress: (cb) => ipcRenderer.on('n8n:progress', (_, data) => cb(data)),

  mcpInstall: (apiKey) => ipcRenderer.invoke('mcp:install', apiKey),
  mcpUninstall: () => ipcRenderer.invoke('mcp:uninstall'),
  mcpInstallSkills: () => ipcRenderer.invoke('mcp:install-skills'),
  mcpRun: () => ipcRenderer.invoke('mcp:run'),
  mcpStop: () => ipcRenderer.invoke('mcp:stop'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpOpenClaude: () => ipcRenderer.invoke('mcp:open-claude'),

  tunnelStart: () => ipcRenderer.invoke('tunnel:start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel:stop'),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  cloudflaredCheck: () => ipcRenderer.invoke('cloudflared:check'),
  cloudflaredInstall: () => ipcRenderer.invoke('cloudflared:install'),
  cloudflaredAuthStatus: () => ipcRenderer.invoke('cloudflared:auth-status'),
  cloudflaredLogin: () => ipcRenderer.invoke('cloudflared:login'),
  cloudflaredTunnelStatus: () => ipcRenderer.invoke('cloudflared:tunnel-status'),
  cloudflaredSetupTunnel: (domain) => ipcRenderer.invoke('cloudflared:setup-tunnel', domain),

  ptySpawn: (cols, rows, skipPerms) => ipcRenderer.invoke('pty:spawn', cols, rows, skipPerms),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
  ptyKill: () => ipcRenderer.send('pty:kill'),
  onPtyData: (cb) => { ipcRenderer.removeAllListeners('pty:data'); ipcRenderer.on('pty:data', (_, data) => cb(data)); },
  onPtyExit: (cb) => { ipcRenderer.removeAllListeners('pty:exit'); ipcRenderer.on('pty:exit', () => cb()); },

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openN8nData: () => ipcRenderer.invoke('shell:open-n8n-data'),
  onTunnelUrl: (callback) => ipcRenderer.on('tunnel:url-update', (_, url) => callback(url)),
  onTunnelLog: (callback) => ipcRenderer.on('tunnel:log', (_, text) => callback(text)),
});
