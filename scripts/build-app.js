#!/usr/bin/env node
/** `npm run build` — build for the current system into
 *  /.hexstack-app/ai-mentat-n8n/ai-mentat-n8n.<ext> */
'use strict';
const path = require('path');
const { build } = require('../sdk/logic/app-scripts');

build({ appName: 'ai-mentat-n8n', root: path.resolve(__dirname, '..') });
