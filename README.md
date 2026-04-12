# N8N-Mentat: self-hosted local N8N running out-of-box, with GUI, cloudflare tunnel exposure to domain and claude code MCP-server
![N8N-Mentat app logo](./output.png)

| Features implemented | Pains solved | Version |
|------|------|-----|
| Run self-hosted N8N locally as GUI app with zero setup | <a target="_blank" href="https://community.n8n.io/t/an-easy-step-by-step-guide-on-how-to-self-host-n8n/6505"><img src="https://n8n.io/favicon.ico" width="24" height="24" alt="n8n"></a> <a target="_blank" href="https://community.n8n.io/t/tutorial-for-non-techies-on-how-to-install-self-hosted-n8n-in-2024/48208"><img src="https://n8n.io/favicon.ico" width="24" height="24" alt="n8n"></a> <a target="_blank" href="https://medium.com/@emmanuelolaoluwa17/the-complete-beginners-guide-to-self-hosting-n8n-free-low-cost-options-that-actually-work-1bf738e6d141"><img src="https://cdn-icons-png.flaticon.com/24/5968/5968906.png" width="24" height="24" alt="Medium"></a> <a target="_blank" href="https://medium.com/@macaroniwdcheese/how-i-set-up-and-self-hosted-n8n-with-docker-and-prepared-it-for-github-a27ed2d7b5a5"><img src="https://cdn-icons-png.flaticon.com/24/5968/5968906.png" width="24" height="24" alt="Medium"></a> | 🆓 |
| No-docker cross-platform GUI runner for self-hosted N8N | <a target="_blank" href="https://techblog.flaviusdinu.com/self-host-n8n-with-docker-should-you-do-it-c33d6fb2d372"><img src="https://cdn-icons-png.flaticon.com/24/5968/5968906.png" width="24" height="24" alt="Medium"></a> <a target="_blank" href="https://dev.to/vikasprogrammer/the-cheapest-way-to-self-host-n8n-in-2026-8ac"><img src="https://dev.to/favicon.ico" width="24" height="24" alt="DEV.to"></a> <a target="_blank" href="https://dev.to/code42cate/5-awesome-n8n-alternatives-528g"><img src="https://dev.to/favicon.ico" width="24" height="24" alt="DEV.to"></a> <a target="_blank" href="https://www.toksta.com/products/n8n"><img src="https://www.toksta.com/favicon.ico" width="24" height="24" alt="Toksta"></a> | 🆓 |
| Serve self-hosted N8N on domain via tunnel without VPS or exposure risks | <a target="_blank" href="https://community.n8n.io/t/securely-self-hosting-n8n-with-docker-cloudflare-tunnel-the-arguably-less-painful-way/93801"><img src="https://n8n.io/favicon.ico" width="24" height="24" alt="n8n"></a> | 🆓 |
| Automate N8N flows development with AI MCP / AI Agent in claude code | <a target="_blank" href="https://community.n8n.io/t/feedback-self-hosted-pricing/22727?page=4"><img src="https://n8n.io/favicon.ico" width="24" height="24" alt="n8n"></a> <a target="_blank" href="https://dev.to/code42cate/5-awesome-n8n-alternatives-528g"><img src="https://dev.to/favicon.ico" width="24" height="24" alt="DEV.to"></a> | 🌟 |

[![Download button MacOS, Windows, Linux](./md-ui-kit/btn-download-all_small.png)](./output.png)⠀⠀[![Learn more... youtube.com](./md-ui-kit/btn-learn_more-youtube.png)](./output.png)

## Features
| **🆓FREE:** Get started when just opened app! Single GUI, single app window. Data stored locally | ![N8N-Mentat app logo](./output.png) |
|------|------|
| **🆓FREE:** Expose the local running N8N to your domain via Cloudflare tunnel in 3-clicks in GUI | ![N8N-Mentat app logo](./output.png) |
| **🌟PRO:** Setup and run ready-to-use MCP server & custom command for Your Claude code in 2 clicks in GUI with prepared integration to build automating workflows | ![N8N-Mentat app logo](./output.png) |

[![Download button MacOS, Windows, Linux](./md-ui-kit/btn-download-all_large.png)](./output.png)

## TLDR;

### Features description

#### 🆓 Free

**N8N Localhost** — Run n8n locally with zero setup
- One-click launch of self-hosted n8n — no Docker, no VPS, no terminal
- Built-in n8n web UI embedded directly in the app
- Auto-starts n8n server on localhost:5678
- Data persists locally between sessions
- Works on macOS, Windows, and Linux
- Community edition — free and open-source n8n engine

**Cloudflare Tunnel** — Expose n8n to the internet securely
- 4-step guided tunnel setup wizard
- Install cloudflared directly from the app
- Authenticate with Cloudflare account
- Create named tunnel with custom domain
- Start/stop tunnel on demand — no port forwarding, no static IP
- Webhooks and external integrations just work

**FAQ** — Quick reference
- n8n licensing explained (community vs enterprise)
- How to activate enterprise features
- Troubleshooting common issues

#### 🌟 PRO

**Claude Code MCP** — AI-powered n8n workflow development
- Install n8n MCP server for Claude Code with one click
- Install n8n Skills pack (pre-built Claude commands for n8n)
- Start/stop MCP server process from the app
- Embedded Claude Code terminal with `/mentat-n8na` command
- Optional skip permissions mode for faster AI iteration
- AI reads your n8n setup context and builds workflows


### Tech stack
* <a target="_blank" href="https://github.com/electron/electron"><img src="https://avatars.githubusercontent.com/u/13409222?s=48&v=4" width="50" height="50" alt="Electron"/> Electron</a>
* <a target="_blank" href="https://github.com/n8n-io/n8n"><img src="https://avatars.githubusercontent.com/u/45487711?s=48&v=4" width="50" height="50" alt="n8n"/> n8n</a>
* <a target="_blank" href="https://github.com/nodejs/node"><img src="https://avatars.githubusercontent.com/u/9950313?s=48&v=4" width="50" height="50" alt="Node.js"/> Node.js</a>
* <a target="_blank" href="https://github.com/xtermjs/xterm.js"><img src="https://avatars.githubusercontent.com/u/25796608?s=48&v=4" width="50" height="50" alt="xterm.js"/> xterm.js</a>
* <a target="_blank" href="https://github.com/cloudflare/cloudflared"><img src="https://avatars.githubusercontent.com/u/314135?s=48&v=4" width="50" height="50" alt="Cloudflare"/> Cloudflare Tunnel</a>
* <a target="_blank" href="https://github.com/anthropics/claude-code"><img src="https://avatars.githubusercontent.com/u/76263028?s=48&v=4" width="50" height="50" alt="Anthropic"/> Claude Code MCP</a>

### Download at itch.io
[![Download button MacOS, Windows, Linux](./md-ui-kit/btn-download-all_large.png)](./output.png)
