# Pi Agent Configuration

Personal AI coding assistant configuration with multi-agent harness, Discord integration, and browser-based frontend.

## Structure

- `agent/` — Pi coding agent config (models, agents, skills, auth)
- `frontend/` — Browser-based multi-session frontend
- `harness/` — Multi-agent orchestration harness with subagents
- `services/` — Companion services (Discord bot, SearXNG search)

## Quick Start

1. Install [pi](https://github.com/earendil-works/pi-mono)
2. Clone this repo to `~/.pi`
3. Copy `agent/auth.json.example` to `agent/auth.json` and add your API keys
4. Copy `services/discord/config.json.example` to `services/discord/config.json` and add your bot token
5. `cd frontend && npm install`
6. Start the frontend: `cd frontend && npm start`

## Agent Models

| Role | Model |
|------|-------|
| Planner / Architect / Verifier | `qwencloud/qwen3-235b-a22b` (thinking) |
| Executor / Engineer / Coder / Browser | `qwencloud/qwen-plus` |

See `agent/AGENTS.md` for full agent documentation.

## Services

### Discord Bot (`services/discord/`)
Runs a Discord bot that accepts `/pi` commands in allowed guilds.

### SearXNG (`services/searxng/`)
Local search engine for web search capability.

### Frontend (`frontend/`)
Express + WebSocket server for multi-session browser UI.