#!/usr/bin/env node
/** `npm run setup` — install every npm and non-npm dependency needed to run. */
'use strict';
const path = require('path');
const { setup } = require('../sdk/logic/app-scripts');

setup({
  appName: 'ai-mentat-n8n',
  root: path.resolve(__dirname, '..'),
  // n8n itself is installed on first launch (`bun add -g n8n`), not here:
  // it is a 500 MB dependency and the app reports progress while it lands.
  // cloudflared is optional — only the tunnel tab needs it.
  system: ['git'],
});
