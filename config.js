const path = require('path');

const config = {
  // n8n Configuration
  N8N_ENCRYPTION_KEY: 'your-super-long-random-encryption-key-here-replace-this',

  // Note: N8N_USER_FOLDER is set dynamically in electron-main.js based on app.isPackaged
  // Development: current directory + .n8n
  // Production: executable directory + .n8n
};

module.exports = config;