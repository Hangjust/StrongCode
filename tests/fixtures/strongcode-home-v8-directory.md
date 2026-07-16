# StrongCode Directory Map

## Runtime configuration and generated mirrors

- `strongcode.json` — root manifest, default profile/agent, and canonical paths.
- `settings.json` — execution, sessions, context, logging, TUI, update, and telemetry defaults.
- `providers.json` / `models.json` — provider connectivity and the separate model catalog.
- `agents.json` / `categories.json` — generated review/setup mirrors of agent and task-category routing; they are not runtime-loaded.
- `permissions.json` — generated permission-profile metadata; the compiled runtime enforces permissions and workspace boundaries.
- `mcp.json` — enabled MCP catalog, lazy/auto-start policy, web-search fallback order, and transport templates.
- `skills.mcps.json` / `resources.json` — discovery order and resource entry points.
- `tui.json` / `keybinds.json` — terminal client preferences.

## Reusable resources

- `agents/`, `skills/`, `commands/`, `prompts/`, `rules/`, `instructions/`.
- `tools/`, `hooks/`, `mcps/`, `plugins/`, `themes/`, `extensions/`.
- `schemas/` validates editable JSON; `examples/` is documentation and is never auto-loaded.

## Work and durable state

- `projects/` and `worktrees/` hold managed repositories and external-project registrations.
- `sessions/`, `tasks/`, `plans/`, `evidence/`, `artifacts/`, `attachments/`, `checkpoints/`, `snapshots/`.
- `memories/` is split into global, project, agent, session, and inbox scopes.
- `cron/` contains disabled-by-default jobs, scripts, history, and output.

## Machine-managed and disposable state

- `runtime/`, `logs/`, `cache/`, `tmp/`, `locks/`, `downloads/`, `updates/`, `telemetry/`.
- `indexes/` is always rebuildable. `backups/`, `exports/`, `imports/`, and `trash/` are explicit lifecycle areas.
- `profiles/` overlays root configuration without duplicating shared sessions or runtime state.
