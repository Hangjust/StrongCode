# StrongCode Open Computer Use Handoff

## Objective

Integrate `iFurySt/open-codex-computer-use` into StrongCode as a trusted, lazy local MCP and install it in the actual StrongCode home.

This work is substantially implemented. Continue from **Remaining Work** below. Do not redo repository research, upstream analysis, installation, migration design, or the completed implementation.

## User Decisions

- Use the canonical package `open-computer-use@0.2.0`.
- Exact launch argv:

  ```text
  npx --registry https://registry.npmjs.org/ --yes open-computer-use@0.2.0 mcp
  ```

- Server ID: `open_computer_use`.
- Keep it enabled but lazy with `autoStart: false`.
- Use `workingDirectory: "config"`.
- Classify it as write-capable with `readOnly: false`.
- The user explicitly selected **allow by default** for `mcp__open_computer_use__*`.
- Do not create a Blender-style managed installer or global npm installation.
- Do not commit unless the user explicitly asks.

## Completed Work

### Catalog and permissions

- Added the pinned lazy MCP entry to `src/config/home-layout.ts`.
- Added `mcp__open_computer_use__*` to `DEFAULT_AGENT_TOOLS` in `src/tools/defaults.ts`.
- It inherits default `allow` and is deliberately absent from audited read-only patterns.
- Startup timeout is 180 seconds; request timeout is 120 seconds.
- Production `environmentFromEnv` remains empty.

### Home migration

- Bumped StrongCode home layout from 8 to 9.
- Added exact version-8 legacy hashes for `mcp.json`, `strongcode.config.yaml`, and `strongcode.json`.
- Added tracked version-7/version-8 fixtures, including `.fixture` suffixes needed to avoid `.gitignore` rules.
- Migration tests cover:
  - explicit v8-to-v9 expansion;
  - no expansion without `--expand`;
  - byte-preserving customized v7/v8 homes;
  - mixed customized/untouched homes;
  - direct v7-to-v9 migration;
  - idempotence;
  - exact fixture SHA-256 validation and deliberate mismatch rejection;
  - symlink/junction/hardlink safety.

### CLI behavior

- `strongcode home --expand` now reports sanitized, sorted preserved customized filenames.
- Added `tests/cli-home-expand.test.ts` for output and byte preservation.
- Split the oversized CLI without behavior changes:
  - `src/cli.ts`: process orchestration, `main`, guards, executable boundary.
  - `src/cli/program.ts`: Commander command registration and `createProgram`.
  - `src/cli/types.ts`: `CliDependencies`.
  - `src/cli/example-config.ts`: byte-identical fallback example config.
- `src/cli.ts` still re-exports `createProgram` and `CliDependencies`; existing consumers need no changes.
- Current pure LOC measurements:
  - `src/cli.ts`: 127
  - `src/cli/program.ts`: 204
  - `src/cli/types.ts`: 15
  - `src/cli/example-config.ts`: 104
- The example config body SHA remains `fea2d17244873dcac31b4baab4a2297ba116f2285772c0a859f9fd3ec482472f`.

### Tests and cleanup

- Added `tests/mcp-open-computer-use-catalog.test.ts`.
- Added opt-in `tests/mcp-open-computer-use-smoke.test.ts`.
- The smoke performs only MCP initialization and `tools/list`; it never calls a desktop-control tool.
- On Darwin only, the smoke passes `OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY=1` through the smoke-only MCP config, then restores it. Production config does not receive this variable.
- Temporary migration/catalog homes are now deleted deterministically after tests.
- The smoke uses temporary StrongCode-home/npm-cache directories and cleans them after closing the manager.

### Documentation

`README.md` now documents:

- exact package/version/registry/subcommand;
- lazy first-use fetch and lifecycle-script risk;
- six supported 64-bit targets;
- macOS, Windows, and Linux prerequisites;
- default-allow desktop-control risk;
- accessibility/application text reaching the configured model and session history;
- correct Windows `npx.cmd`/`cmd.exe` nuance;
- explicit expansion and preserved customized-home behavior;
- complete manual YAML merge including `mcp_list_tools`, `mcp_call`, and the namespace under both tools and permissions;
- Darwin smoke isolation and limitations.

### Actual local installation

The actual home is `C:\Users\giolu\.config\strongcode`.

- `strongcode.json` is layout version 9.
- `mcp.json` contains the exact lazy `open_computer_use` server.
- `strongcode.config.yaml` gives Tesla:
  - `mcp_list_tools`
  - `mcp_call`
  - `mcp__open_computer_use__*`
- All three permissions are `allow`.
- `node .\dist\cli.js tools list --config "C:\Users\giolu\.config\strongcode\strongcode.config.yaml"` reports configured server `open_computer_use`.
- Do **not** reinstall or rewrite the actual home. Read-only verification is enough.

## Verification Already Completed

- Changed-file LSP diagnostics: clean.
- No-excuse TypeScript audit: clean.
- Focused CLI/migration/catalog suite after CLI split: 39 passed, real smoke skipped by default.
- `npm run typecheck`: passed after CLI split.
- `npm run build`: passed after CLI split.
- `dist/cli.js --help`: passed with a temporary home.
- Real pinned-package smoke passed repeatedly and advertised exactly these nine tools:
  - `click`
  - `drag`
  - `get_app_state`
  - `list_apps`
  - `perform_secondary_action`
  - `press_key`
  - `scroll`
  - `set_value`
  - `type_text`
- Prior complete offline run before later concurrent Blender edits: 1,706 passed, 5 skipped.
- Latest broad run before CLI split: 1,812 passed, 5 skipped, with one unrelated Blender assertion failure described below.

## Review Status

The second five-lane review returned:

- Goal/constraint verification: PASS
- Hands-on QA: PASS
- Security: PASS
- Context mining: PASS
- Code quality: FAIL only because:
  1. `src/cli.ts` was still above 250 pure LOC.
  2. migration/catalog tests leaked temporary homes.

Both code-quality findings have now been fixed by the CLI split and deterministic teardown. A final review has **not** yet been run after those fixes.

## Remaining Work

1. Run the full suite once after the CLI split:

   ```powershell
   npm test
   ```

2. If the only failure is the unrelated Blender expectation below, do not modify Blender code. Record it as an unrelated concurrent failure.
3. Run the opt-in smoke once more only if desired; do not call any MCP control tool:

   ```powershell
   $env:STRONGCODE_REAL_OPEN_COMPUTER_USE_SMOKE = "1"
   try {
     npm test -- tests/mcp-open-computer-use-smoke.test.ts
   } finally {
     Remove-Item Env:STRONGCODE_REAL_OPEN_COMPUTER_USE_SMOKE -ErrorAction SilentlyContinue
   }
   ```

4. Rerun the five-lane post-implementation review. Focus reviewers on the CLI split and test teardown; do not repeat upstream research.
5. All five lanes must PASS. If they do, mark the final review todo complete and report completion.
6. Do not commit unless the user asks.

## Known Unrelated Failure

The shared dirty worktree contains large concurrent Blender/TUI work unrelated to this task. The latest persistent broad-suite failure was:

```text
tests/setup-blender-install.test.ts
repairs an owned MCP fragment while preserving unrelated JSON content
expected /--force|repair required/i
received "Blender MCP server 'blender' conflicts with the managed server and is unowned"
```

Do not fix or revert this as part of Open Computer Use integration.

## Scoped Repository Files

- `README.md`
- `src/cli.ts`
- `src/cli/example-config.ts`
- `src/cli/program.ts`
- `src/cli/types.ts`
- `src/config/home-layout.ts`
- `src/tools/defaults.ts`
- `tests/cli-home-expand.test.ts`
- `tests/config-home-ancestor-security.test.ts`
- `tests/config-home-migration.test.ts`
- `tests/config-home.test.ts`
- `tests/mcp-open-computer-use-catalog.test.ts`
- `tests/mcp-open-computer-use-smoke.test.ts`
- `tests/fixtures/strongcode-home-v7/strongcode.config.yaml.fixture`
- `tests/fixtures/strongcode-home-v8/*`

Some files are untracked because this is a shared dirty worktree. Include them in review/diff reasoning, but do not stage or commit them automatically.

## Do Not Redo

- Do not re-analyze the upstream repository or Ego Lite.
- Do not research alternative MCP packaging.
- Do not redesign this as a managed installer.
- Do not reinstall the actual StrongCode home.
- Do not change the accepted default-allow decision.
- Do not repeat the migration or CLI implementation.
- Do not touch unrelated Blender/TUI/setup/design changes.
- Do not invoke desktop-control tools during verification.
