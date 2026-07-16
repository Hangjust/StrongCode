# StrongCode Home

This directory contains StrongCode runtime configuration and state plus generated review/setup mirrors.
Set `STRONGCODE_HOME` to relocate the entire directory.

Runtime authority is `strongcode.config.yaml` plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement.
Generated `agents.json` and `prompts/agents/*.md` are review/setup mirrors. They are not runtime-loaded, and edits to them do not affect runtime.
Other generated JSON catalogs document setup defaults and discovered resources; use the supported runtime configuration paths for durable changes.
Credentials stay in private `auth.json`; setup state stays in `setup.json`.
Runtime state uses `sessions/`, `project-auth/`, `tui/`, `logs/`, and `cache/`.
