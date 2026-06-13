# StrongCode

# NOTE THIS IS STILL A WORK IN PROGRESS!

![Code Smarter](Code%20Smarter.gif)

StrongCode is a minimal TypeScript and Node 20 local agent harness with a terminal-first CLI and TUI. It gives you local configuration, JSONL session storage, provider and model management, mock and OpenAI-compatible model providers, read-only workspace tools, and deny-by-default tool permissions.

StrongCode is intentionally small. It does not ship shell execution, write/edit tools, MCP, plugins, streaming, or hidden agents.

## Functions Provided

StrongCode provides these main capabilities:

- Local project setup with `strongcode init`.
- Config validation for `strongcode.config.yaml`.
- An interactive terminal UI when you run `strongcode` with no arguments.
- One-shot prompt runs from the CLI with `strongcode run`.
- JSONL session storage and session inspection commands.
- Provider and model management for built-in providers: GPT / OpenAI, Kimi, Claude, Grok, Mock, and Custom Provider.
- Runtime support for `mock`, `openai`, and `openai-compatible` providers.
- OpenAI-compatible model discovery through each provider's models endpoint.
- ChatGPT account OAuth connection flows for OpenAI through browser or headless device-code auth.
- Read-only built-in tools guarded by workspace boundaries and permissions.

The package also exports a small library API:

- Config: `loadConfig`, `strongCodeConfigSchema`, `StrongCodeConfig`.
- Core results and errors: `StrongCodeError`, `Result`, `ok`, `err`.
- Runtime and agents: `AgentRunner`, `createRuntimeContext`.
- Models and providers: `MockModelProvider`, `BUILT_IN_PROVIDERS`, `orderedProviders`, `providerDefaults`, `ProviderAuthStore`, `createProviderCatalog`, `ProviderService`, `listProviders`, `discoverOpenAICompatibleModels`.
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
strongcode
```

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

## Basic Usage

Initialize a config file in the project you want StrongCode to manage:

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

## Configuration

Start from `strongcode.config.example.yaml`:

```yaml
version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: default
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
  default:
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

Do not put secrets directly in config. Config fields such as `apiKey`, `token`, `accessToken`, `refreshToken`, `idToken`, `clientSecret`, `secret`, `authorization`, or `bearerToken` are rejected. Use environment variable names such as `OPENAI_API_KEY` or provider credentials stored through `/connect`.

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

Use `/connect` inside the TUI to connect provider credentials. Use `/model` to inspect the active provider's configured models.

```text
/connect
/connect <provider-id> <api-key>
/connect openai chatgpt-browser
/connect openai chatgpt-headless
/connect remove <provider-id>
/model
```

`/connect <provider-id> <api-key>` stores credentials in `.strongcode/auth.json` with restrictive file permissions where the platform supports them. OpenAI-compatible discovery calls `GET <baseUrl>/models` and adds discovered models disabled by default so you can enable the ones you want.

Runtime completions are supported for `mock`, `openai`, and `openai-compatible` providers. Catalog-only providers can appear in the UI before a runtime client is implemented.

## Built-In Tools

StrongCode currently includes read-only workspace tools:

- `list_files`: lists direct children of a directory inside the configured workspace.
- `read_file`: reads a UTF-8 text file inside the configured workspace.

Both tools resolve paths against the configured workspace and reject traversal outside it.

## Sessions

Sessions are JSONL files under the configured data directory. By default, they are stored at:

```text
.strongcode/sessions/<session-id>.jsonl
```

## Development

Run the main checks with:

```sh
npm test
npm run typecheck
npm run build
```
