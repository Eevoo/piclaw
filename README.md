# PiClaw - Minimal Pi Agent Sandbox

![PiClaw](docs/icon-256.png)

A minimal Docker-based sandbox for running [Pi Coding Agent](https://github.com/badlogic/pi-mono) in an isolated Debian environment, with an optional WhatsApp integration via **piclaw**. Inspired by [agentbox](https://github.com/rcarmo/agentbox) and [nanoclaw](https://github.com/qwibitai/nanoclaw).

## What's Included

- **Debian Bookworm** (slim) base image
- **Homebrew** package manager
- **Bun** JavaScript runtime
- **Pi Coding Agent** (pre-installed globally via `bun add -g`)
- **Piclaw** — WhatsApp → pi orchestrator (nanoclaw-style agentic loop)
- **Web UI** — Built-in single-user UI inspired by [Vibes](https://github.com/rcarmo/vibes)
- Essential dev tools: git, vim, tmux, htop, ripgrep, jq, tree, build-essential

## Quick Start

```bash
# Build the image
make build

# Start the container
make up

# Enter the container
make enter

# Inside the container, run pi interactively
cd /workspace
pi
```

Then use `/skill:setup` to scaffold a new project, or `/skill:debug` to check the environment.

### Web UI

Piclaw ships with a built-in web UI (Vibes-inspired). Once the container is up, open:

```
http://localhost:8080
```

Set `PICLAW_WEB_PORT` or `PICLAW_WEB_HOST` to change where it listens.

## Volumes & Persistence

Everything that should survive container recreation lives on two volumes:

| Mount | Container path | Contents |
|-------|---------------|----------|
| Home  | `/config`     | Agent home persistence (`.pi/`, `.gitconfig`, `.bashrc`) |
| Workspace | `/workspace` | User files, projects, and piclaw state |

### Workspace layout

```
/workspace/
├── AGENTS.md                # Pi system prompt (seeded from skeleton on first boot)
├── .pi/skills/              # Project-level skills (setup, debug)
├── .piclaw/                 # Piclaw state (auto-created, gitignored)
│   ├── store/messages.db    # SQLite database (chats, messages, tasks)
│   ├── data/sessions/       # Pi session history
│   ├── data/ipc/            # IPC files (messages, tasks)
│   └── data/chats.json      # Registered chat JIDs
├── notes/                   # Agent memory (created by pi as needed)
└── <your projects>/
```

### Using an external volume

By default, `docker-compose.yml` bind-mounts `./workspace`. To use a different path or a named volume, set `WORKSPACE_PATH` in `.env`:

```bash
# Use a directory on an external drive
echo 'WORKSPACE_PATH=/mnt/data/piclaw-workspace' >> .env
make up
```

Or override directly:

```bash
WORKSPACE_PATH=/mnt/data/piclaw-workspace docker compose up -d
```

### Piclaw path overrides

All piclaw paths are env-configurable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PICLAW_WORKSPACE` | `/workspace` | Where pi runs (working directory) |
| `PICLAW_STORE` | `/workspace/.piclaw/store` | SQLite database location |
| `PICLAW_DATA` | `/workspace/.piclaw/data` | Sessions, IPC, chats.json |
| `ASSISTANT_NAME` | `pi` | Trigger name (`@pi`) |
| `AGENT_TIMEOUT` | `600000` | Max pi invocation time (ms) |

## Piclaw — WhatsApp Integration

Piclaw is a persistent orchestrator that connects WhatsApp to pi:

1. WhatsApp messages arrive via Baileys
2. Messages matching `@pi` trigger are stored in SQLite
3. Poll loop detects new messages, sends prompt to persistent agent session
4. Pi's output is sent back to the chat

### Agent Pool (Warm Start)

Piclaw uses the pi SDK directly instead of spawning `pi --print` subprocesses.
A pool of persistent `AgentSession` instances (one per chat JID) stays alive in
memory:

- *First message* pays the warm-up cost (resource discovery, model init)
- *Subsequent messages* reuse the live session — no startup overhead, full
  conversation context already loaded
- Sessions auto-compact when context gets large
- Idle sessions are evicted after 10 minutes to free memory
- All sessions are gracefully disposed on shutdown

```bash
# Inside the container
piclaw                                    # scan QR code to connect WhatsApp
```

> **Note:** Piclaw does not require any API keys directly. LLM provider, model, and
> credentials are all configured through pi's own settings (`~/.pi/agent/settings.json`).
> Run `pi` interactively once to set your provider, or edit the settings file directly:
>
> ```json
> {
>   "defaultProvider": "github-copilot",
>   "defaultModel": "claude-sonnet-4-20250514"
> }
> ```
>
> Pi supports multiple providers (Anthropic, OpenAI, Google, GitHub Copilot, etc.).
> Any API keys needed are resolved by pi itself — via its settings, environment
> variables, or credential helpers — not by piclaw.

### IPC Skills

Pi can interact with piclaw while running via IPC files:

- `/skill:send-message` — Send a message to the chat immediately (progress updates)
- `/skill:schedule` — Create/manage scheduled tasks (cron, interval, one-shot)

### Pushover Notifications

Piclaw can send push notifications via [Pushover](https://pushover.net/) for proactive
nudges — scheduled task results and IPC messages (e.g. reminders, progress updates).
Regular conversation responses are **not** sent to Pushover; only agent-initiated
notifications are.

Set these in your `.env` or as environment variables:

```bash
PUSHOVER_APP_TOKEN=your-app-token    # Required — from pushover.net/apps
PUSHOVER_USER_KEY=your-user-key      # Required — from pushover.net
PUSHOVER_DEVICE=myphone              # Optional — target a specific device
PUSHOVER_PRIORITY=0                  # Optional — -2 (silent) to 2 (emergency)
PUSHOVER_SOUND=pushover              # Optional — notification sound
```

When both `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY` are set, the channel activates
automatically. Messages longer than 1024 characters are truncated (Pushover API limit).

## Agent Configuration

Pi uses `AGENTS.md` for project context and `.pi/` for configuration. LLM provider
and model selection are configured entirely through pi's settings — piclaw simply
invokes `pi --print` and inherits whatever provider/model/keys pi is configured to use.

| Path | Purpose |
|------|---------|
| `~/.pi/agent/settings.json` | Global settings (provider, model, thinking level) |
| `~/.pi/agent/skills/` | Global skills (schedule, send-message) |
| `AGENTS.md` | Project instructions (loaded at startup) |
| `.pi/skills/` | Project-level skills (`/skill:name`) |
| `.pi/settings.json` | Project-level settings (overrides global) |

### Skills

Skills are on-demand capabilities invoked via `/skill:name`:

**Global** (shipped with container at `~/.pi/agent/skills/`):
- `/skill:schedule` — Schedule tasks via piclaw IPC
- `/skill:send-message` — Send chat messages via piclaw IPC

**Project** (shipped with workspace at `.pi/skills/`):
- `/skill:setup` — Initialize a new project
- `/skill:debug` — Diagnose container/environment issues
- `/skill:reload` — Hot-restart piclaw after code changes
- `/skill:playwright` — Local Playwright browser automation

Add your own to `.pi/skills/<name>/SKILL.md` (project) or `~/.pi/agent/skills/<name>/SKILL.md` (global).

## Resource Limits

Set via environment variables in `docker-compose.yml` or `.env`:

```
CPU_LIMITS=2
MEMORY_LIMITS=4G
```

## Credits

- [rcarmo/agentbox](https://github.com/rcarmo/agentbox) — Original multi-agent sandbox
- [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) — WhatsApp agentic loop pattern
- [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — Pi coding agent

## License

MIT

## Container Runtime

PiClaw is a standard OCI image and works with any compliant container runtime:

- **Docker** / Docker Desktop — primary development target
- **Apple Containers** (macOS 26+) — works natively; use the GHCR image or build locally
- **Podman**, **nerdctl**, etc. — standard `docker compose` equivalents work

The multi-arch image (amd64 + arm64) is published to GHCR on every tag push, so `docker pull ghcr.io/<owner>/piclaw:latest` works on both Intel and Apple Silicon.

## CI / Release Pipeline

Pushing a version tag triggers the GitHub Actions workflow (`.github/workflows/publish.yml`):

1. **Native multi-arch builds** — AMD64 on `ubuntu-24.04`, ARM64 on `ubuntu-24.04-arm` (no slow QEMU emulation)
2. **Manifest merge** — combines both digests into a single multi-arch `latest` + versioned tag
3. **Artifact cleanup** — keeps only the 5 most recent releases, tags, workflow runs, and Docker image versions

```bash
make bump-patch   # bumps VERSION, commits, creates git tag
make push         # pushes commits + tag → triggers CI
```
