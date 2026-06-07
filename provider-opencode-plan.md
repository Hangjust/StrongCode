# OpenCode Provider Implementation Plan

## Why `/provider` Feels Dead

StrongCode already has provider-related code, but exact `/provider` in the full TUI is intercepted as a home-screen overlay instead of being submitted to `handleProviderCommand`. That overlay currently only opens a provider picker and then advances to model selection; it does not connect or authenticate a provider.

In fallback/scripted TUI mode, `/provider` prints the provider status panel, which is why tests pass while the real interactive TUI can still feel like nothing happened.

Upstream OpenCode does not use `/provider` as the TUI provider-connection command. It uses `/connect`. The backend HTTP APIs are under `/provider`.

## Upstream OpenCode Reference

Reference repository: <https://github.com/anomalyco/opencode>

Relevant upstream behavior:

- TUI command: `provider.connect`, slash command `/connect`, opens the provider connection dialog.
- UI flow: `DialogProvider` / `DialogModel` style provider connection and model selection.
- Backend API: provider list/auth/OAuth routes under `/provider`.
- Auth storage: provider-ID keyed `auth.json` credential storage with restrictive file permissions.
- Provider catalog: Models.dev + AI SDK provider registry + config overrides + auth/env/plugin providers.
- Model selection: connected provider catalog drives `/models`.

## Current StrongCode Gap

StrongCode has:

- Provider registry/defaults.
- Config validation and persistence.
- Provider and model selection commands.
- OpenAI-compatible model discovery and completions.
- Mock provider support.

StrongCode is missing:

- An upstream-style `/connect` command.
- A provider connection/authentication dialog flow.
- Provider credential storage separate from YAML config.
- A provider catalog service comparable to upstream OpenCode's provider service.
- Model picker data sourced from connected provider/auth state.
- Full backend support for non-OpenAI-compatible providers already listed in the registry.

## Implementation Plan

### 1. Backend Catalog First

Add a StrongCode provider catalog service.

The catalog should represent:

- Provider ID.
- Display name.
- Auth methods.
- Available models.
- Model capabilities.
- Runtime support status.

Keep existing hardcoded providers working, but make the catalog the long-term source of truth.

### 2. Credential Storage

Add `auth.json`-style provider auth storage.

Required operations:

- `get(providerId)`
- `all()`
- `set(providerId, auth)`
- `remove(providerId)`

Do not store raw API keys in `strongcode.config.yaml`. Keep YAML config for provider/model configuration, not secrets.

### 3. Provider API/Service Layer

Add internal service functions equivalent to upstream provider endpoints:

- List providers.
- List auth methods.
- Set auth.
- Remove auth.
- OAuth authorize/callback, either real or explicitly unsupported initially.

Start with internal service functions. Add HTTP routes only if StrongCode later grows a server/API layer.

### 4. TUI Provider Flow

Add upstream-compatible `/connect`.

Update exact `/provider` behavior so it either:

- Aliases `/connect`, or
- Shows provider status with an obvious connect action.

Provider selection should:

1. Show available providers.
2. Ask for the selected provider's auth method.
3. Prompt for API key or OAuth details.
4. Save credentials through auth storage.
5. Refresh provider/model state.
6. Open model selection.

### 5. Model Selection Integration

Rework the model picker so model data comes from provider catalog/auth state instead of only the existing static registry/config path.

Preserve existing commands where possible:

- `/model`
- `/models`
- `/provider list`
- `/provider models <id>`
- `/provider select <id>`

### 6. Command Semantics

Recommended command behavior:

- `/connect`: upstream-compatible provider connection flow.
- `/provider`: StrongCode alias for connect flow or provider status screen with connect action.
- `/provider ...`: keep existing StrongCode provider subcommands.
- `/models`: model selection sourced from connected provider catalog.

### 7. Tests

Add or update tests for:

- `/connect` opens provider connection UI.
- Exact `/provider` no longer appears inert.
- Existing `/provider ...` subcommands still work.
- Auth storage set/get/remove.
- Provider catalog output.
- Model picker uses catalog/auth-backed provider state.
- Model selection after provider auth.

Existing relevant test files:

- `tests/tui.test.ts`
- `tests/tui-commands.test.ts`
- `tests/model-discovery.test.ts`
- `tests/provider-registry.test.ts`

### 8. Documentation

Update the README/provider docs to explain:

- `/connect` is the OpenCode-compatible provider connection command.
- `/provider` remains StrongCode's provider command namespace or alias.
- Where credentials are stored.
- Which provider backends are fully supported.
- Which providers are catalog-visible but not yet runtime-supported.

## Risks

- Upstream OpenCode is a large Effect/AI SDK/Models.dev architecture; copying files directly will not drop into StrongCode cleanly.
- StrongCode currently only truly supports mock and OpenAI-compatible completions.
- Registry entries like Anthropic need real backend clients before they should be presented as fully usable.
- Credential storage needs Windows-safe security handling.
- Upstream UI is Solid/OpenTUI component-based; StrongCode has a simpler mixed text/overlay TUI, so port behavior rather than raw components.
- Config format differs: upstream uses OpenCode JSON/JSONC config, while StrongCode uses YAML.

## Suggested Work Order

1. Provider catalog abstraction and tests.
2. Auth storage and tests.
3. Provider service/API layer and tests.
4. `/connect` plus exact `/provider` TUI flow.
5. Catalog-backed model selection.
6. Command aliases/help text.
7. Documentation update.
8. Final test/typecheck/build pass.
