# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

![N8N-Mentat app logo](./output.png)

## Repository location

- Local: `/var/minis/repos/ai-mentat-n8n` — **all repos live under `/var/minis/repos/`**
- Remote: `hexstack-apps/ai-mentat-n8n` (private)

## Conventions

- One logical change = one commit, with the measurements behind it.
- Add a `Requested: "..."` trailer citing the originating request.
- Push to the private `hexstack-apps` remote — that is the backup.
- Never `mv` a git repo inside `/var/minis` (it corrupts the object
  store on this Android FS); re-clone from GitHub instead.
- Run tests AND build before deploying; smoke-test the bundle.
