# StrongCode



# NOTE THIS IS STILL A WORK IN PROGRESS!

![Code Smarter](Code%20Smarter.gif)

StrongCode is a small TypeScript/Node 20 scaffold for a local agent harness with a terminal-first operations console TUI. It is intentionally minimal: local configuration, JSONL sessions, provider/model management, a mock model provider, OpenAI-compatible chat completions, read-only tools, deny-by-default permissions, a CLI, and a TUI.

It does not include shell execution, write/edit tools, MCP, plugins, streaming, or hidden agents.

## Install

```sh
npm install
npm run build
npm link
```

`npm link` registers the local package bin globally, so you can run `strongcode` from your terminal instead of `node dist/cli.js`.

If you change TypeScript source after linking, run `npm run build` again so the terminal command uses the latest compiled code.

## Use The Command

From this project directory:

```sh
strongcode
strongcode --help
strongcode init
strongcode config validate --config strongcode.config.yaml
strongcode tools list --config strongcode.config.yaml
strongcode run "hello" --config strongcode.config.yaml --session demo
strongcode session show demo --config strongcode.config.yaml
```

After `npm link`, the `strongcode` command is available in any terminal. Running `strongcode` with no arguments opens the interactive TUI. Run `strongcode init` in whichever project folder you want the harness to manage; it creates that project's `strongcode.config.yaml`.

## Quick Start

```sh
npm run build
strongcode init
strongcode config validate --config strongcode.config.yaml
strongcode tools list --config strongcode.config.yaml
strongcode run "hello" --config strongcode.config.yaml --session demo
strongcode session show demo --config strongcode.config.yaml
```

The mock provider works without external credentials.

## Configuration

See `strongcode.config.example.yaml`:

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
permissions:
  tools:
    list_files: allow
    read_file: allow
```

Permissions are `allow`, `ask`, or `deny`. Unknown tools are denied. `ask` is denied non-interactively in this MVP.

## Providers

Use `/connect` inside the TUI to connect provider credentials. Use `/provider` to inspect provider status and `/provider ...` for provider subcommands. The built-in order is GPT / OpenAI, Kimi, Claude, Grok, Mock, then Custom Provider.

```text
/connect
/connect <provider-id> <api-key>
/connect openai chatgpt-browser
/connect openai chatgpt-headless
/connect remove <provider-id>
/provider
/provider list
/provider select openai
/provider models custom
/provider configure custom http://localhost:11434/v1 LOCAL_MODEL_API_KEY
/provider enable model <model-id>
/provider disable model <model-id>
/models
/model <model-id>
```

Provider config stores env var names such as `OPENAI_API_KEY`, not API keys. `/connect <provider-id> <api-key>` stores API credentials in `.strongcode/auth.json` with restrictive file permissions where the platform supports them. `/connect openai chatgpt-browser` starts ChatGPT account OAuth in a browser, and `/connect openai chatgpt-headless` starts the device-code flow. OpenAI-compatible discovery uses a `GET <baseUrl>/models` response and adds discovered models disabled by default so you can enable the ones you want.

Do not put `apiKey`, `token`, `accessToken`, `refreshToken`, `idToken`, `clientSecret`, `secret`, `authorization`, or `bearerToken` fields in config. The loader rejects those fields at provider and model config levels. Providers of type `openai` or `openai-compatible` use `apiKeyEnv` or `.strongcode/auth.json` credentials at discovery/completion time. API-key completions send non-streaming chat completions to `<baseUrl>/chat/completions`; OpenAI ChatGPT account OAuth completions use the ChatGPT Codex endpoint.

Fully supported runtime providers are `mock`, `openai`, and `openai-compatible`. Catalog-visible providers such as `anthropic` are listed for connection/status but remain unsupported for completions until a backend client is added.

## Sessions

Sessions are JSONL files under the configured data directory, defaulting to `.strongcode/sessions/<session-id>.jsonl`.

## Tools

Built-in tools are read-only:

- `list_files`: list direct children of a directory inside the configured workspace.
- `read_file`: read a UTF-8 text file inside the configured workspace.

Both tools resolve paths against the configured workspace and reject traversal outside it.

## Development


```sh
npm test
npm run typecheck
npm run build
```
