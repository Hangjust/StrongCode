# StrongCode

# NOTE THIS IS STILL A WORK IN PROGRESS!

![Code Smarter](Code%20Smarter.gif)

StrongCode is a TypeScript and Node 20 local agent harness with a terminal-first CLI and TUI. It provides one-time provider onboarding, global and project configuration, JSONL sessions, hosted and local model discovery, native provider adapters, workspace tools, MCP transports, and deny-by-default tool permissions.

## Functions Provided

StrongCode provides these main capabilities:

- Local project setup with `strongcode init`.
- Config validation for `strongcode.config.yaml`.
- An interactive terminal UI when you run `strongcode` with no arguments.
- One-shot prompt runs from the CLI with `strongcode run`.
- JSONL session storage and session inspection commands.
- First-run onboarding with a durable completion marker and `strongcode setup --force` reconfiguration.
- Consent-gated Blender detection and optional integration setup with `strongcode setup --blender`.
- Built-ins for ChatGPT, OpenAI, Anthropic, Google Gemini/Vertex, xAI, Moonshot/Kimi, DeepSeek, GLM, Ollama, LM Studio, vLLM, and custom providers.
- Native Anthropic and Gemini adapters plus OpenAI-compatible hosted/local discovery.
- Native ChatGPT browser/device-code OAuth with automatic refresh, plus Google browser/headless login through `gcloud` ADC.
- DeepSeek/Gemma 4 auxiliary-model follow-up and optional voice-to-text guidance in global `AGENTS.md`.
- Read-only built-in tools guarded by workspace boundaries and permissions.

The package also exports a small library API:

- Config: `loadConfig`, `strongCodeConfigSchema`, `StrongCodeConfig`.
- Core results and errors: `StrongCodeError`, `Result`, `ok`, `err`.
- Runtime and agents: `AgentRunner`, `createAgent`, `createRuntimeContext`, the built-in agent registry, canonical primary-role display names, primary-agent cycling, and role-specific model routing.
- Models and providers: `MockModelProvider`, `EnsembleModelProvider`, `BUILT_IN_PROVIDERS`, `orderedProviders`, `providerDefaults`, `ProviderAuthStore`, `createProviderCatalog`, `ProviderService`, `listProviders`, and protocol-aware discovery helpers.
- Setup: `runSetup`, `shouldRunFirstSetup`, `SetupState`, and `SetupResult`.
- Sessions and tools: `SessionStore`, `createDefaultToolRegistry`, `ToolRegistry`, `assertToolAllowed`, `getToolPermission`.

## Install Via Git

Clone the repository, install dependencies, build the CLI, then link the local package:

```sh
git clone <repository-url> StrongCode
cd StrongCode
npm install
npm run build
npm link
```

Replace `<repository-url>` with this repository's Git URL. `npm link` registers the `strongcode` command globally on your machine, pointing at the built `dist/cli.js` file.

After linking, run:

```sh
strongcode --help
strongcode setup
strongcode
```

`strongcode setup` (also available as `strongcode install`) finishes with `StrongCode harness is ready.` The first interactive harness command runs the same wizard automatically when setup is incomplete; non-interactive runtime commands stop with a clear instruction to run setup first.

If you change TypeScript source after linking, run `npm run build` again so the linked command uses the latest compiled code.

## Install Locally

Use this flow when you already have the project folder locally:

```sh
npm install
npm run build
npm link
```

You can also run the compiled CLI from the project without linking:

```sh
node dist/cli.js --help
node dist/cli.js
```

StrongCode requires Node 20 or newer.

## StrongCode Home

On first run, StrongCode creates one predictable user-owned directory:

```text
~/.config/strongcode
```

On Windows that resolves to `%USERPROFILE%\.config\strongcode`. Run `strongcode home` to create it explicitly and print the resolved path. Set `STRONGCODE_HOME` when the whole directory needs to live somewhere else; `XDG_CONFIG_HOME/strongcode` is used when `STRONGCODE_HOME` is unset.

The home is intentionally small and contains only current harness configuration, loadable resources, and runtime state:

```text
~/.config/strongcode/
├── strongcode.json       # main directory manifest
├── strongcode.config.yaml # executable global runtime config
├── setup.json            # versioned one-time onboarding state
├── agents.json           # generated agent review/setup mirror
├── categories.json       # task category -> model routing
├── providers.json        # provider URLs and credential references
├── models.json           # model catalog and aliases
├── permissions.json      # named permission profiles
├── auth.json             # private credentials; never commit
├── project-auth/         # isolated per-project credential vaults
├── skills.mcps.json      # canonical discovery/load-order manifest
├── mcp.json              # MCP catalog, lazy startup, web fallback, env references
├── agents/  prompts/  skills/  mcps/
├── projects/  sessions/  tui/
├── node_modules/
└── logs/  cache/
```

Runtime authority is `strongcode.config.yaml` plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement. Generated `agents.json` and `prompts/agents/*.md` are review/setup mirrors, are not runtime-loaded, and must not be treated as editable runtime configuration. Setup records the selected default agent/model in the mirror for review. API keys do not belong in `agents.json`, `providers.json`, `mcp.json`, or `skills.mcps.json`; the setup wizard masks provider keys and writes them only to private `auth.json`. MCP configuration contains environment-variable references rather than embedded secrets.

Automatic bootstrap is monotonic: it creates missing core artifacts and does not modify existing files. Run `strongcode home --expand` to replace only byte-identical, known StrongCode starter files; customized files are preserved.

## Basic Usage

Run the one-time global setup:

```sh
strongcode setup
```

On the first interactive setup, StrongCode performs read-only Blender detection. Completed users who have not seen the current Blender offer receive the same detection on a later interactive no-argument launch, without rerunning provider onboarding. A compatible Blender 4.2+ profile and 64-bit CPython 3.11 on Windows are required before it displays one default-deny installation consent prompt. Declining suppresses that offer version; cancellation or missing prerequisites remain eligible for a later launch. None of those outcomes changes Blender. To run only this integration setup, without rerunning provider onboarding, use:

```sh
strongcode setup --blender
strongcode setup --blender --force
```

`strongcode setup --blender` verifies an existing owned installation without changing managed Blender or profile artifacts and refreshes StrongCode metadata only; `--force` performs a newly consented installation or repair.

The persisted addon and preferences enable automatic startup of the addon on future Blender GUI launches. The Blender-only command requires an interactive TTY. Installation uses pinned, hash-verified assets, a private runtime, transactional rollback, and an authenticated ephemeral loopback listener. It does not install Python or uv, create OS autostart, or modify project configuration.

The global setup config is used automatically in directories without a project config, while the active working directory remains the model/tool workspace. To override it for one repository, initialize a project config:

```sh
strongcode init
```

Validate the config and inspect available tools:

```sh
strongcode config validate --config strongcode.config.yaml
strongcode tools list --config strongcode.config.yaml
```

Run a prompt and store it in a session:

```sh
strongcode run "hello" --config strongcode.config.yaml --session demo
```

Inspect saved sessions:

```sh
strongcode session list --config strongcode.config.yaml
strongcode session show demo --config strongcode.config.yaml
```

Running `strongcode` with no arguments opens the interactive TUI.

In the full OpenTUI, the `question` tool can request one or two compact questions, or three to six tabbed questions with a final Confirm tab and optional guidance. It is not available in the fallback terminal or one-shot CLI. Simplify is optional: it sends only the visible headers, question text, options, and descriptions to DeepSeek, so do not enter secrets. The configured provider may process or retain that text under its own privacy policy.

## Built-In Agents

The four main agents appear in this fixed order. Their role designs are inspired by OMO counterparts; this is design lineage, not a claim that the StrongCode roles previously had those identities. Press `Tab` or `Shift+Tab` to cycle them, or use `/agent <name>`:

- **Tesla - Main Agent** (`tesla`; aliases include `sisyphus`; inspired by OMO Sisyphus) — delegation-aware orchestrator that owns the user's outcome through integration and verified delivery. Prefers GPT 5.6 SOL, then Terra.
- **Newton - Deep Worker** (`newton`; aliases include `deep-agent` and `hephaestus`; inspired by OMO Hephaestus) — autonomous, goal-oriented worker that explores, implements, verifies, and exercises the delivered surface. Prefers SOL Ultra, then SOL.
- **JBP - Plan Builder** (`jbp`; aliases include `plan-builder` and `prometheus`; inspired by OMO Prometheus) — sticky planning-only agent that produces a decision-complete execution plan and never implements it.
- **Bob The Builder - Plan Executor** (`bob-the-builder`; aliases include `atlas` and `atlas-plan-builder`; inspired by OMO Atlas) — executes only an approved JBP plan, works dependency-ordered checkpoints without routine pauses, and owns final integration and verification.

The specialist agents are **Hood Research Department** (four-model brainstorming), **Steve Jobs** (platform-aware UI/UX), **Government** (security), **Meta** (marketing), **Sugar Boo** (ethical engagement/retention), and **Warren Buffer** (monetization and unit economics). Activate one with `/agent <id>`; `/agents` lists the full roster and aliases.

JBP and Bob have an explicit approval boundary. Build and review a plan with JBP, then run `/start-work`. StrongCode switches the same session to Bob and preserves the plan in conversation history. Selecting Bob directly with `Tab` or `/agent` keeps his role-level tool policy read-only; `/start-work` removes that restriction, while configured permissions still apply. Planning and security specialists, including JBP and Government, are read-only by policy; they hand approved implementation work to Bob. Hood Research Department fails closed unless at least four distinct enabled models are available; it gathers independent responses in parallel and synthesizes them without granting the panel tool access.

Each role has an ordered model preference chain. Resolution honors an explicit per-agent model, user fallback models, the role's preferences, the configured default, and finally another runnable onboarding model. The active provider is not made exclusive, so specialists can use different connected providers. The selected provenance is shown when switching agents.

## Configuration

Start from `strongcode.config.example.yaml`:

```yaml
version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: tesla
providers:
  openai:
    type: openai
    displayName: GPT / OpenAI
    apiKeyEnv: OPENAI_API_KEY
    baseUrl: https://api.openai.com/v1
    modelsEndpoint: /models
    enabled: false
  kimi:
    type: openai-compatible
    displayName: Kimi
    apiKeyEnv: MOONSHOT_API_KEY
    baseUrl: https://api.moonshot.ai/v1
    modelsEndpoint: /models
    enabled: false
  anthropic:
    type: anthropic
    displayName: Claude
    apiKeyEnv: ANTHROPIC_API_KEY
    enabled: false
  grok:
    type: openai-compatible
    displayName: Grok
    apiKeyEnv: XAI_API_KEY
    baseUrl: https://api.x.ai/v1
    modelsEndpoint: /models
    enabled: false
  mock:
    type: mock
    displayName: Mock
    enabled: true
  custom:
    type: openai-compatible
    displayName: Custom Provider
    apiKeyEnv: CUSTOM_PROVIDER_API_KEY
    modelsEndpoint: /models
    enabled: false
agents:
  tesla:
    model: mock
    tools:
      - list_files
      - read_file
models:
  mock:
    provider: mock
    model: mock
    enabled: true
permissions:
  tools:
    list_files: allow
    read_file: allow
```

Permissions are `allow`, `ask`, or `deny`. Unknown tools are denied. `ask` is denied non-interactively in this MVP.

### Optional Hidden Preflight

The optional hidden `$summary` runtime role is configured through `preflight` and summarizes only the first meaningful prompt. Its committed result contains a title, one general summary, and source-ordered requested items. The primary still receives the exact original prompt; generated decomposition is separate, untrusted advice and never replaces or rewrites the request.

Setup generates summary, analysis, and explorer routes only after an eligible model is actually discovered and configured. It prefers a semantic DeepSeek V4 Flash match, then a semantic Gemma match. If neither is available, `preflight` remains unset; StrongCode never inserts a guessed model ID or silently routes these roles to the primary/default model. Operators may replace every hidden route with any configured model key. Model identity does not grant permission: restrictions derive from the instantiated hidden role, so the same model used as a primary retains the primary agent's configured capabilities.

```yaml
preflight:
  enabled: true
  summary:
    model: your-configured-model-key
    tools: [list_files, read_file, find_files, ripgrep, web_search]
  analysis:
    model: your-configured-model-key
    tools: [list_files, read_file, find_files, ripgrep, web_search]
  explorer:
    model: your-configured-model-key
    tools: [list_files, read_file, find_files, ripgrep, web_search]
```

The host accepts 0-25 optional depth-one analysis/explorer children, with at most 25 total and 25 concurrent. The overall preflight deadline is 90 seconds, each child has at most 30 seconds, and there is a 5-second finalizer reserve for the single finalizer. These numeric scheduler limits are host-owned and cannot be configured.

Hidden roles receive only the intersection of configured tools and host-classified read/search/read-only-web operations. They cannot write, edit, delete, execute shell, invoke worker or task entrypoints, spawn agents, perform recursive delegation, or use unclassified MCP tools. Violations, unavailable routes, invalid output, child/finalizer failure, and timeouts produce a visible automatic `failed-open` outcome instead of blocking the primary. Cancellation stops descendants and suppresses primary dispatch; late completions cannot revive orchestration.

Token telemetry is shown only when supplied by the provider and is labeled `provider-reported`. Immutable configured context-window metadata can show the reported input-token context use; immutable configured pricing can produce an `estimated` spend only for a complete, unambiguous provider input/output token split. Provider costs remain `provider-reported`, and missing values remain unavailable rather than being estimated from prompt text. Generated config, examples, and documentation contain environment-variable references only, never credentials.

Do not put secrets directly in config. Config fields such as `apiKey`, `token`, `accessToken`, `refreshToken`, `idToken`, `clientSecret`, `secret`, `authorization`, or `bearerToken` are rejected. Global/home configs may reference environment variable names such as `OPENAI_API_KEY`. For a repository-local config, use `/connect`; StrongCode stores the key in an isolated project vault under StrongCode home, never inside the repository.

### Project Trust Boundary

Repository-local configs are untrusted by default. They use only their isolated project vault and do not implicitly inherit global credentials from StrongCode home or read ambient provider credential variables. Repository `AGENTS.md` content and configured agent `systemPrompt` values are also excluded from trusted system instructions.

Set `STRONGCODE_TRUST_PROJECT_CONFIG=1` only for a repository whose config and instructions you have reviewed and trust. Passing a repository config explicitly with `--config` is also treated as an intentional trust decision for that invocation. Either opt-in enables project instructions and configured system prompts and permits ambient credential variables; it still does not inherit global credentials from StrongCode home. Without trust, workspace and data paths must stay inside the project, delegated account providers are rejected, repository-defined remote endpoints cannot receive API keys, and write-capable tool permissions are downgraded.

### Filesystem Trust Boundary

Automatic StrongCode-home paths reject linked or junctioned roots and ancestors, and automatically trusted regular files must have exactly one hard link. This covers automatic home config, catalogs, instructions, MCP files, and session or home bootstrap paths. Passing a config explicitly with `--config` and setting `STRONGCODE_TRUST_PROJECT_CONFIG=1` remain intentional trust decisions.

Dependency-free Node component and handle checks validate paths before and after authority is granted or mutation occurs, blocking static redirected-path attacks. They cannot guarantee freedom from active kernel-level namespace races because Node lacks portable descriptor-relative APIs; an active race can create an empty namespace entry before StrongCode detects it.

StrongCode also reads an editable model catalog from `.strongcode/models.json`. This file is for provider/model metadata only; do not put API keys in it. Catalog entries can add display names and models, but credential-routing fields such as API key environment variables and base URLs must come from built-in provider defaults, `strongcode.config.yaml`, or `/connect`. It accepts an OpenCode-style provider-centric shape:

```json
{
  "providers": {
    "openai": {
      "name": "GPT / OpenAI",
      "env": ["OPENAI_API_KEY"],
      "api": "https://api.openai.com/v1",
      "models": {
        "gpt-4.1": { "name": "GPT-4.1", "id": "gpt-4.1" }
      }
    },
    "kimi": {
      "name": "Kimi",
      "env": ["MOONSHOT_API_KEY"],
      "api": "https://api.moonshot.ai/v1",
      "models": {
        "kimi-k2": { "name": "Kimi K2", "id": "kimi-k2" }
      }
    }
  }
}
```

Models from this catalog are merged with `strongcode.config.yaml` at startup, so `/model` and `/models` show them alongside configured or discovered models.

## Providers

Use `strongcode setup` for provider discovery and account login. Use `/connect` for credential updates and `/model` to inspect configured models.

```text
/connect
/connect <provider-id> <api-key>
/connect remove <provider-id>
/model
```

The full TUI conceals API-key input and shows the exact provider origin before accepting a key. Canonical built-in origins may be connected from an untrusted project, but repository-defined remote endpoints require an explicit `--config` or `STRONGCODE_TRUST_PROJECT_CONFIG=1` trust decision first. Inline keys are rejected by the fallback line-oriented terminal because that input may be echoed; use the full TUI or `strongcode setup --force` there.

`/connect <provider-id> <api-key>` stores credentials in a config-path-keyed `project-auth/<id>/auth.json` vault under StrongCode home. This keeps secrets out of Git while isolating one project's keys from every other project and from the global setup store. Global setup credentials are deliberately not inherited by repository-local configs, because an untrusted project could otherwise redirect a provider ID to a credential-stealing endpoint. Repository runtimes also ignore ambient credential variables unless you explicitly set `STRONGCODE_TRUST_PROJECT_CONFIG=1`. New keys are bound to the selected provider type and origin; auth files use restrictive permissions, serialized atomic replacement, and symlink checks.

Setup presents one **OpenAI / ChatGPT** connection with browser login, headless/device-code login, or an OpenAI API key. ChatGPT login is implemented natively with OAuth Authorization Code + PKCE on a loopback callback, or OpenAI's device-code flow for headless machines. StrongCode stores the resulting access/refresh tokens in its private `auth.json`, refreshes them automatically, and sends ChatGPT requests directly to the Codex Responses service; installing the Codex CLI is not required. OpenAI API-key access remains a separate transport. Google Gemini accepts an API key, while Google Vertex login delegates browser/headless ADC setup and token refresh to `gcloud`. Anthropic is API-key only.

The “My model is not listed here” path presents the major model families and then loads the selected provider's live catalog, avoiding a stale hard-coded model list. Custom setup asks for protocol, base URL, optional key, and model-list endpoint, then discovers the models exposed by that endpoint. Local discovery probes only known loopback ports for Ollama, LM Studio, and vLLM; it never scans the LAN. Cursor session/cookie import is intentionally unsupported because Cursor has no documented third-party inference authentication contract—use a provider API key or compatible custom endpoint instead.

Selecting no provider requires explicit confirmation before StrongCode enables mock-only mode. During `strongcode setup --force`, providers and provider models that are no longer selected are disabled, and setup moves the default agent to the selected chat-capable default (or deliberately back to mock). Discovered embedding, image, audio, moderation, and reranking models remain selectable but are not preferred as chat defaults.

Runtime completions are supported for `mock`, OpenAI/OpenAI-compatible APIs, native Anthropic, native Gemini, Vertex AI via ADC, and ChatGPT through the native OAuth-backed Responses transport.

After primary providers are selected, setup detects actual model IDs. If DeepSeek is present but Gemma 4 is not, it offers Gemma; if Gemma 4 is present but DeepSeek is not, it offers DeepSeek; if both are already present, it skips the auxiliary questions. Hosted and locally imported models both count.

The voice-to-text question has `Yes`, `No`, and `I might get it` choices. `Yes` inserts the supplied transcription-aware text inside an idempotent managed block in the global `AGENTS.md`; `No` removes only that managed block; `I might get it` defers activation until a later `strongcode setup --force` run. Existing user instructions are preserved.

## Built-In Tools

StrongCode includes workspace-bounded general tools:

- `question`: asks the user one to six decision questions in the full OpenTUI only.
- `list_files`: lists direct children of a directory inside the configured workspace.
- `read_file`: reads a UTF-8 text file inside the configured workspace.
- `find_files`: finds files using path substrings and globs through the bundled ripgrep binary.
- `ripgrep`: searches file contents with the bundled platform binary while respecting ignore files.
- `write_file`: creates files with explicit overwrite semantics.
- `edit_file`: replaces exact text with occurrence checking.
- `delete_path`: deletes files or explicitly recursive directories, never the workspace root.
- `shell`: launches one executable directly with an argument array; it does not interpret pipes, redirects, or shell operators.
- `web_search`: follows the configured current-web provider route.
- `mcp_list_tools` / `mcp_call`: lazily discover and invoke any enabled MCP server.

Filesystem tools resolve real paths through symlinks and reject traversal outside the workspace. Shell working directories are workspace-bounded. Tool names and permission keys may use `*` wildcards for namespaced MCP tools.

## MCP Servers and Token Savers

StrongCode loads trusted MCP declarations from `mcp.json` beside the active runtime config. It supports stdio and Streamable HTTP, passes only allowlisted environment variables to local servers, rejects credentials embedded in URLs/config, and exposes auto-started tools as `mcp__<server>__<tool>`. Heavier servers remain available through `mcp_list_tools` and `mcp_call` without paying their schema/startup cost on every session. Starting a local server, including tool discovery, requires permission for its `mcp__<server>__*` namespace.

The generated home catalog includes:

- Context7, grep.app, and Exa as auto-started read-only remote servers.
- TinyFish as the Exa web-search fallback. TinyFish uses OAuth 2.1; StrongCode opens the browser on first explicit use, receives the loopback callback, and stores refresh/access tokens privately under `credentials/mcp/` in StrongCode home.
- Semble, Graphify, Playwright, Chrome DevTools, GitHub MCP, and Headroom as enabled lazy servers. Graphify activates only when `graphify-out/graph.json` exists; the hosted GitHub server requires `GITHUB_PERSONAL_ACCESS_TOKEN` because generic hosts cannot reuse another application's GitHub OAuth registration.
- Playwright for isolated browser automation, and Chrome DevTools for console, network, debugging, and performance inspection. Both set `autoStart: false`, deferring overlapping schemas and startup cost until an explicit `mcp_list_tools` or `mcp_call`. They run from the trusted config directory rather than the active workspace; Playwright writes artifacts under `cache/playwright-mcp` there. Chrome DevTools MCP `1.6.0` requires Node `20.19+` and an available Chrome or Chrome for Testing installation.
- Caveman's `caveman-shrink@0.1.0` around compatible local search/graph MCP servers to shrink tool descriptions without installing the Caveman skill. Playwright stays direct because its current MCP process is not compatible with that proxy.
- Brave Search as a disabled opt-in fallback. DuckDuckGo search-only, self-hosted Firecrawl, and self-hosted SearXNG remain disabled templates because their deployment/package endpoints are user-specific; add a reviewed server entry and then opt it into `webSearch.providers`.

Exa and TinyFish are the only web providers enabled in the generated fallback route. Configure credentials in the process environment, never in `mcp.json`:

```sh
EXA_API_KEY=...
CONTEXT7_API_KEY=...
GITHUB_PERSONAL_ACCESS_TOKEN=...
BRAVE_API_KEY=...
```

Local packages are version-pinned in the generated catalog and fetched through `npx -y`, with no project dependency. Browser packages also pin the canonical npm registry before the package name so project npm configuration cannot redirect resolution. Packages are fetched only when their lazy server is explicitly discovered/called or when the user changes that server to `autoStart: true`. Native Windows launches run `npx` directly, not `cmd /c`.

## Sessions

Sessions are JSONL files under the configured data directory. By default, they are stored at:

```text
.strongcode/sessions/<session-id>.jsonl
```

In the interactive TUI, run `/compact` while the session is idle to reduce the active model context. StrongCode uses the active agent's current model and system prompt with tools disabled, retains the newest user messages within an approximate 20,000-token budget, and generates a handoff summary for the next turn. `/compress` is not an alias.

Compaction preserves the JSONL audit history: it appends a checkpoint instead of deleting earlier events, while subsequent model requests project their context from the latest checkpoint. If the session changes before the checkpoint can be published, compaction fails without replacing that newer history; run `/compact` again.

## Development

Run the main checks with:

```sh
npm test
npm run typecheck
npm run build
```
