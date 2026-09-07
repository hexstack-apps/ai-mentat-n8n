# CLAUDE.md — Hexstack Mentat N8NA

Electron desktop app that runs [n8n](https://n8n.io) locally with no Docker and
no VPS: the n8n editor embedded in the window, a Cloudflare named tunnel to put
it on a real domain, and a one-click Claude Code MCP setup with an embedded
terminal.

## Provenance — read this before "fixing" something

The 2026-04 source was lost with the rest of the `hexstack` monorepo (see
[[no-local-backups]] in the session memory). This repo was **recovered from the
shipped 1.1.0 build**: `app.asar` in `mentat-n8na-1.1.0.dmg` held unminified
esbuild output with the original module paths intact, so `electron-main.js`,
`electron-licensing.js` and `config.js` came back as source, and `app.html`,
`app.css`, `preload.js`, `pty-helper.py`, `icon.png` and `vendor/` were shipped
verbatim.

The DMG is the **12 Apr 2026** state. Four changes documented in the prompt
archive landed *after* it and have been reapplied here, so do not "restore"
them to match the DMG:

| Change | Why it is not in the DMG |
|---|---|
| Licensing removed, all tabs free | Decided 16 Apr; the whole family dropped Moonbase licensing |
| `buildN8nEnv()` publishes the public domain to n8n | Fixed 23 Apr — see below |
| `restartN8n()` + "Restart n8n to apply" button | Added 23 Apr alongside it |
| `sdk/` submodule, `lib/`, data-dir contract | The family conventions the three sibling apps moved to on 5 Sep |

## Run and test

```sh
npm install
npm run gui            # esbuild the main process, then launch
npm test               # 57 unit tests, no deps, no Electron, no display
npm run test:mutation  # 25 mutation checks — every fix must fail when reverted
npm run build          # -> /.hexstack-app/ai-mentat-n8n/ai-mentat-n8n.dmg
```

## Architecture

| Layer | File | Notes |
|---|---|---|
| Main process | `electron-main.js` | n8n / MCP / tunnel / PTY supervision |
| Preload bridge | `preload.js` | contextIsolation on, explicit allowlist |
| UI | `app.html` + `app.css` | single page, 4 tabs |
| Terminal backend | `pty-helper.py` | real PTY behind the embedded xterm.js |
| **Pure logic** | **`lib/*.js`** | **the only unit-testable code** |
| Shared plumbing | `sdk/` (submodule) | bundling, auto-update, publish/release, data-dir |

### Why `lib/` exists

`electron-main.js` cannot be loaded outside Electron — `require('electron')`
throws under plain node — and it exports nothing, so PATH construction, n8n
resolution, config parsing and the domain→env mapping had **zero coverage** in
the shipped build. `lib/` holds them as pure functions with injected probes,
so a macOS-only path is verifiable on Linux.

**Rule: new platform-conditional or parsing logic goes in `lib/` with a test.**

## Design decisions worth preserving

**The tunnel domain must reach n8n's environment, not just cloudflared.**
The shipped build wrote the domain only to `~/.cloudflared/config.yml`. n8n
never learned its public name, so webhook nodes handed
`http://localhost:5678/webhook/...` to external services — the tunnel came up
and webhooks still did not work. `buildN8nEnv()` passes `WEBHOOK_URL`,
`N8N_EDITOR_BASE_URL` and `N8N_PROTOCOL=https` when a domain is set.

**`N8N_HOST` stays `0.0.0.0` regardless of the domain.** cloudflared reaches
the port from outside the process; binding to the hostname breaks the tunnel.
There is a mutation test pinning this.

**n8n reads those vars only at boot**, hence `restartN8n()` and the explicit
"Restart n8n to apply" button. The restart kills the process *group* and waits
for the port to free before respawning, and sets `n8nRestarting` so n8n's exit
handler does not close the window — without that flag, applying a domain quit
the app.

**A restart is decided by comparing rendered environments, not raw fields.** A
whitespace-only edit to the domain must not bounce a running server.

**Readiness means "n8n answers", not "the port answers".** Anything could be
listening on 5678; the probe checks the body, because loading the window
against a stranger's server is worse than waiting.

**The app's own bun install wins the n8n search.** Behaviour must not change
based on what the user happens to have installed globally. The npm/Homebrew
locations are fallbacks for a machine that already had n8n. A dangling
`~/.bun/bin/n8n` symlink is *not* a usable script — the target is re-checked.

**PATH is prepended, not appended.** A GUI app launched from Finder inherits a
launchd PATH without `/opt/homebrew/bin`, `~/.local/bin` or `~/.bun/bin`, so
`claude`, `bun` and `cloudflared` all read as missing for anyone who did not
start the app from a terminal.

**`config.yml` is parsed as ingress entries, not line pairs.** The shipped
build matched the `service:` line and read the hostname from the line *above*
it, so a hand-edited entry with the keys in the other order — valid YAML that
cloudflared honours — reported "no tunnel configured" and the app offered to
create a second tunnel over a working one. The parser also picks the entry
pointing at **our** port, so a shared cloudflared config does not hand back
another app's hostname.

## Security decisions

These matter because this repo is public and the app spawns processes on the
user's machine.

**The n8n encryption key is generated per install, never committed.** The
shipped build read `N8N_ENCRYPTION_KEY` from a committed `config.js` holding
the literal `'your-super-long-random-encryption-key-here-replace-this'`. n8n
encrypts every stored credential with that key, so one constant in a public
repo means anyone who obtains a `.n8n` directory can decrypt what is in it.
`lib/encryption-key.js` now generates 32 CSPRNG bytes on first run and stores
them 0600 in the data dir. **An existing key is never regenerated** — a
present-but-unreadable key file is a hard error, because a fresh key would make
already-stored credentials permanently undecryptable.

**Every child process gets an argv array, never a composed command string.**
The shipped build built `claude ${args.join(' ')}` and handed it to `execSync`
with the user's n8n API key inside, so a key containing a shell metacharacter
was executed rather than passed. `run()` uses `execFileSync`. The tunnel
hostname is additionally validated by `CF.isValidHostname()` before it reaches
a command line or a config file.

**Response-header rewriting is scoped to n8n's own origin.** n8n serves
`X-Frame-Options` and a `frame-ancestors` CSP that would refuse to render in
the window, and its cookies need `SameSite=None` to survive the embed — but the
shipped build applied that stripping to `<all_urls>`, removing the CSP of every
page the app could ever load.

**`webSecurity` is on.** The shipped build disabled it to get n8n into the
iframe; framing is actually governed by the headers above, and turning it off
disables the same-origin policy for the whole renderer.
`MENTAT_ALLOW_INSECURE=1` re-disables it for local diagnosis only.

**`shell:open-external` allowlists `https:`** — a renderer-supplied string
reaching `openExternal` can otherwise launch `file://` or a custom protocol
handler.

## Error handling convention — fail-safe, never silent

`lib/failsafe.js`, shared verbatim with the sibling apps.

```js
const { quiet, quietAsync, attempt } = require('./lib/failsafe');
const out = quiet('cloudflared.readConfig', () => fs.readFileSync(p, 'utf8'), null);
attempt('settings.write', () => fs.writeFileSync(f, json));
```

Every suppressed error gets a stable operation label, message, optional
context, and a bounded 200-entry buffer readable via `recentFailures()`.

**Rule: do not write `catch {}` for anything whose failure a user could
notice.** The `op` label must be a stable literal, not a template string — it
is what you grep for. The few remaining bare catches are process-kill calls
where the failure is "it was already dead".

## Gotchas

- `main` points at `electron-main.bundle.js`, esbuild output regenerated before
  every run and package. **Edit `electron-main.js`.**
- Use the glob: `node --test 'test/*.js'`. `node --test test/` treats the bare
  directory as a file named `test` and reports a spurious failure.
- `app.html` loads `sdk/ui/update-bar.js` **directly from the submodule**. The
  sibling apps reference a copied `update-ui.js` that `bundle-electron.js`
  looks for in `sdk/utils/` and no longer produces, so their update bar
  silently never appears.
- Data lives at `/.hexstack-app/ai-mentat-n8n/data` (family contract), falling
  back to `~/.hexstack-app/...` when the filesystem root is not writable. Run
  `npm run setup` to prepare the root location.
- **Upgrading from the released 1.1.0 starts a fresh n8n home.** 1.1.0 kept it
  under Electron's `userData`; workflows from an old install are not migrated
  and still sit there.
- `pty-helper.py` must stay in `asarUnpack` — python3 cannot execute a script
  inside the asar archive.
- `certs/` is a gitignored signing input.
- **`npm run bundle` passes the project dir explicitly.**
  `sdk/utils/bundle-electron.js` defaults `projectDir` to
  `path.resolve(__dirname, '..')`, which was the repo root when that file lived
  at `__shared__/scripts/` but is `<repo>/sdk` in the submodule layout. The
  scripts here pass `.`; **the other three ai-mentat repos still omit it, so
  their `bundle` and `gui` scripts fail** — worth fixing in the SDK.
- **Electron's postinstall may not fetch its binary.** If
  `node_modules/electron/dist` is missing after `npm install`, run
  `(cd node_modules/electron && node install.js)`.
- To run and screenshot the GUI, use the project skill at
  `.claude/skills/run-app/` — it documents the driver and its gotchas.
