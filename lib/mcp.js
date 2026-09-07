'use strict';
//
// Pure Claude Code MCP wiring logic: detection, cache hygiene, and the
// generated `/mentat-n8na` command. No electron, no filesystem.

const N8N_MCP_SERVER = 'n8n-mcp';

/**
 * Arguments for `claude mcp add`, as an array.
 *
 * An array — not an interpolated string — because the API key lands here. The
 * shipped build built this as `claude ${args.join(' ')}` and handed it to
 * execSync, so a key containing a shell metacharacter was executed rather than
 * passed. Callers spawn the binary with this array directly.
 */
function mcpAddArgs({ apiKey, apiUrl }) {
  const args = [
    'mcp', 'add', N8N_MCP_SERVER,
    '-s', 'user',
    '-e', 'MCP_MODE=stdio',
    '-e', 'LOG_LEVEL=error',
    '-e', 'DISABLE_CONSOLE_OUTPUT=true',
    '-e', `N8N_API_URL=${apiUrl}`,
  ];
  if (apiKey) args.push('-e', `N8N_API_KEY=${apiKey}`);
  args.push('--', 'npx', '--yes', N8N_MCP_SERVER);
  return args;
}

/**
 * Is this `~/.npm/_npx/<hash>` entry a half-written n8n-mcp install?
 *
 * An interrupted `npx n8n-mcp` leaves the package directory in place with no
 * readable package.json, and every later npx run then fails against the
 * corpse instead of re-fetching. Deleting only entries that both hold the
 * package AND cannot be parsed keeps healthy caches intact.
 */
function isCorruptNpxEntry({ hasPackageDir, packageJsonText }) {
  if (!hasPackageDir) return false;
  if (typeof packageJsonText !== 'string' || !packageJsonText.trim()) return true;
  try {
    const pkg = JSON.parse(packageJsonText);
    return !pkg || typeof pkg !== 'object';
  } catch {
    return true;
  }
}

/** The `/mentat-n8na` slash command the app installs for Claude Code. */
function mentatCommandDoc({ apiUrl }) {
  return `---
name: mentat-n8na
description: Run n8n workflow tasks using n8n MCP server and n8n skills
allowed-tools:
  - mcp__n8n-mcp__*
---

You have access to a local n8n instance via the n8n MCP server.
Use n8n skills and n8n-mcp tools to fulfill the user's request.

The n8n instance runs at ${apiUrl}.

$ARGUMENTS
`;
}

module.exports = {
  N8N_MCP_SERVER,
  mcpAddArgs,
  isCorruptNpxEntry,
  mentatCommandDoc,
};
