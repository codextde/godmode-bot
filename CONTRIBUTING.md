# Contributing to Godmode Bot

Thanks for helping build an AI teammate people can trust! 🎉

## Development setup

Requirements: [Bun](https://bun.sh) ≥ 1.3, Node.js ≥ 22, [pnpm](https://pnpm.io) 12, Rust (stable) for the desktop shell,
[Claude Code](https://code.claude.com) CLI, [uv](https://docs.astral.sh/uv/) (for browser-use) and Google Chrome/Chromium.

```bash
git clone https://github.com/codextde/godmode-bot
cd godmode-bot
pnpm install

# Option A — web UI + core (fastest loop)
pnpm dev            # core on :7777 (bun --watch) + UI on http://127.0.0.1:1420

# Option B — full desktop app
pnpm dev:app        # tauri dev (spawns the core from source)
```

Use a throwaway data directory while hacking: `GODMODE_HOME=/tmp/godmode-dev pnpm dev`.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- `packages/shared` — the contract (types) between core and UI
- `packages/core` — Bun daemon: API, runner (Claude Code CLI), vault, browser (CDP + browser-use), scheduler, MCP gateway
- `apps/desktop` — React UI + Tauri shell

## Checks

```bash
pnpm typecheck
pnpm test            # bun test in packages/core
pnpm --filter @godmode/desktop build
```

## Guidelines

- Keep the shared types in `packages/shared` as the single source of truth for API payloads.
- Security first: never log or persist secrets in plaintext; route secret access through the vault and audit log.
- UI: use the existing design tokens (`index.css`) and shadcn/ui components; support dark + light themes.
- Small, focused PRs with a clear description. Add tests for core logic.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

## Reporting security issues

Please do **not** open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).
