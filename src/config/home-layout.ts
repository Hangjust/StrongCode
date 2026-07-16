import { BUILT_IN_AGENT_DEFINITIONS, agentPromptMarkdown } from "../agents/registry";
import { DEFAULT_AGENT_TOOLS, DEFAULT_TOOL_PERMISSIONS } from "../tools/defaults";
import { DEFAULT_GLOBAL_AGENT_INSTRUCTIONS } from "./bundled-instructions";
import { PREFLIGHT_HOME_DOCUMENTATION, PREFLIGHT_JSON_SCHEMA } from "./preflight-home-documentation";

export type StarterMergePolicy = "upgrade-generated" | "never";

export interface StrongCodeHomeStarterFile {
  content: string;
  mode?: number;
  merge: StarterMergePolicy;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function lines(...value: string[]): string {
  return `${value.join("\n")}\n`;
}

export const STRONGCODE_HOME_LAYOUT_VERSION = 8;

const STRONGCODE_HOME_EXPANDED_DIRECTORIES = [
  "agents",
  "artifacts",
  "attachments",
  "backups",
  "backups/config",
  "backups/manifests",
  "backups/memory",
  "backups/projects",
  "backups/state",
  "bin",
  "cache",
  "cache/downloads",
  "cache/http",
  "cache/images",
  "cache/mcps",
  "cache/models",
  "cache/plugins",
  "cache/providers",
  "cache/skills",
  "categories",
  "checkpoints",
  "commands",
  "config",
  "credentials",
  "credentials/mcp",
  "cron",
  "cron/history",
  "cron/output",
  "cron/scripts",
  "downloads",
  "evidence",
  "examples",
  "exports",
  "extensions",
  "formatters",
  "history",
  "hooks",
  "hooks/scripts",
  "hooks/scripts/approval",
  "hooks/scripts/error",
  "hooks/scripts/post-model",
  "hooks/scripts/post-tool",
  "hooks/scripts/pre-model",
  "hooks/scripts/pre-tool",
  "hooks/scripts/session-end",
  "hooks/scripts/session-start",
  "hooks/scripts/subagent",
  "hooks/scripts/turn-end",
  "hooks/scripts/turn-start",
  "imports",
  "indexes",
  "instructions",
  "locks",
  "logs",
  "logs/app",
  "logs/audit",
  "logs/cron",
  "logs/hooks",
  "logs/sessions",
  "logs/tools",
  "lsp",
  "marketplaces",
  "mcps",
  "memories",
  "memories/agents",
  "memories/global",
  "memories/inbox",
  "memories/projects",
  "memories/sessions",
  "models",
  "node_modules",
  "packages",
  "plans",
  "plans/active",
  "plans/archived",
  "plans/completed",
  "plans/queued",
  "plans/templates",
  "plugins",
  "plugins/cache",
  "plugins/data",
  "plugins/managed",
  "profiles",
  "profiles/default",
  "projects",
  "prompts",
  "prompts/agents",
  "prompts/snippets",
  "prompts/system",
  "registries",
  "rules",
  "rules/global",
  "rules/projects",
  "runtime",
  "runtime/checkpoints",
  "runtime/instances",
  "runtime/locks",
  "runtime/pids",
  "runtime/processes",
  "runtime/queues",
  "runtime/queues/dead-letter",
  "runtime/queues/pending",
  "runtime/queues/running",
  "runtime/sockets",
  "schemas",
  "sessions",
  "skills",
  "snapshots",
  "state",
  "tasks",
  "tasks/attachments",
  "tasks/blocked",
  "tasks/completed",
  "tasks/failed",
  "tasks/inbox",
  "tasks/queued",
  "tasks/running",
  "telemetry",
  "templates",
  "templates/project",
  "themes",
  "themes/custom",
  "tmp",
  "tmp/sessions",
  "tmp/tools",
  "tmp/uploads",
  "tools",
  "tools/bin",
  "tools/scripts",
  "trash",
  "tui",
  "updates",
  "worktrees"
] as const;

/** Only directories consumed by the current harness or its setup/runtime paths. */
export const STRONGCODE_HOME_DIRECTORIES = [
  "agents",
  "cache",
  "credentials",
  "credentials/codex",
  "credentials/codex/workspace",
  "credentials/mcp",
  "logs",
  "mcps",
  "node_modules",
  "project-auth",
  "projects",
  "prompts",
  "prompts/agents",
  "sessions",
  "skills",
  "tui"
] as const;

const agentOrder = BUILT_IN_AGENT_DEFINITIONS.map(agent => agent.id);

const agents = Object.fromEntries(BUILT_IN_AGENT_DEFINITIONS.map(agent => [agent.id, {
  displayName: agent.displayName,
  omoInspiration: agent.omoInspiration,
  compatibilityAlias: agent.legacyName,
  role: agent.role,
  primaryRole: agent.primaryRole,
  description: agent.description,
  enabled: true,
  mode: agent.tier === "primary" ? "primary" : "subagent",
  activation: agent.activation,
  prompt: `prompts/agents/${agent.id}.md`,
  model: agent.id === "tesla" ? "mock" : undefined,
  modelPreferences: agent.modelPreferences,
  strategy: agent.orchestration.strategy,
  minimumDistinctModels: agent.orchestration.minimumDistinctModels,
  maximumDistinctModels: agent.orchestration.maximumDistinctModels,
  handoffTo: agent.orchestration.handoffTo,
  receivesFrom: agent.orchestration.receivesFrom,
  requiresExplicitApproval: agent.orchestration.requiresExplicitApproval,
  fallbackModels: [],
  category: agent.tier === "primary" ? "deep" : undefined,
  permissionProfile: ["jbp", "bob-the-builder", "hood-research-department", "government", "meta", "sugar-boo", "warren-buffer"].includes(agent.id) ? "read-only" : "interactive",
  skills: agent.skills,
  tools: {}
}]));

const categories = Object.fromEntries([
  ["quick", "Small, bounded tasks."],
  ["unspecified-low", "Normal low-complexity work."],
  ["unspecified-high", "Complex implementation and refactoring."],
  ["writing", "Documentation and prose."],
  ["visual-engineering", "Frontend and visual work."],
  ["deep", "Deep autonomous engineering."],
  ["ultrabrain", "Architecture and difficult reasoning."]
].map(([id, description]) => [id, { description, model: "mock", fallbackModels: [] }]));

const baseSchema = (title: string, properties: Record<string, unknown>, required: string[] = ["version"]) => ({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  title,
  type: "object",
  required,
  properties,
  additionalProperties: true
});

const genericConfigSchema = baseSchema("StrongCode configuration fragment", {
  "$schema": { type: "string" },
  version: { type: "integer", minimum: 1 },
  preflight: PREFLIGHT_JSON_SCHEMA
});

export const STRONGCODE_HOME_EXPANDED_STARTER_FILES: Record<string, StrongCodeHomeStarterFile> = {
  "VERSION": {
    content: `${STRONGCODE_HOME_LAYOUT_VERSION}\n`,
    merge: "upgrade-generated"
  },
  "strongcode.json": {
    content: json({
      version: 1,
      layoutVersion: STRONGCODE_HOME_LAYOUT_VERSION,
      defaultAgent: "tesla",
      files: {
        runtimeConfig: "strongcode.config.yaml",
        setupState: "setup.json",
        agents: "agents.json",
        categories: "categories.json",
        providers: "providers.json",
        models: "models.json",
        permissions: "permissions.json",
        credentials: "auth.json",
        mcp: "mcp.json",
        discovery: "skills.mcps.json"
      },
      directories: {
        agents: "agents",
        cache: "cache",
        credentials: "credentials",
        logs: "logs",
        mcpServers: "mcps",
        nodeModules: "node_modules",
        projectAuth: "project-auth",
        projects: "projects",
        prompts: "prompts",
        sessions: "sessions",
        skills: "skills",
        tui: "tui"
      }
    }),
    merge: "upgrade-generated"
  },
  "settings.json": {
    content: json({
      "$schema": "./schemas/settings.schema.json",
      version: 1,
      activeProfile: "default",
      locale: "system",
      telemetry: { enabled: false },
      updates: { checkOnStart: false, autoInstall: false, channel: "stable" },
      execution: {
        maxConcurrentAgents: 4,
        maxConcurrentTools: 8,
        commandTimeoutMs: 120000,
        backgroundTasks: true
      },
      routing: { modelFallback: false, maxRetries: 1 },
      sessions: { autoSave: true, resumeLast: false },
      context: { respectGitignore: true, autoCompact: true, maxSingleFileBytes: 1048576 },
      logging: { level: "info", redactSecrets: true, retentionDays: 14, mcpStderrFile: "logs/mcp-stderr.log" },
      tui: { theme: "system", showTokenUsage: true, showCost: true },
      experimental: {}
    }),
    merge: "upgrade-generated"
  },
  "strongcode.config.yaml": {
    content: lines(
      "version: 1",
      "workspace: .",
      "dataDir: .",
      "defaultAgent: tesla",
      "providers:",
      "  mock:",
      "    type: mock",
      "    displayName: Mock",
      "    enabled: true",
      "agents:",
      "  tesla:",
      "    model: mock",
      "    tools:",
      ...DEFAULT_AGENT_TOOLS.map(tool => `      - ${JSON.stringify(tool)}`),
      "models:",
      "  mock:",
      "    provider: mock",
      "    model: mock",
      "    displayName: Mock",
      "    enabled: true",
      "permissions:",
      "  tools:",
      ...Object.entries(DEFAULT_TOOL_PERMISSIONS).map(([tool, permission]) => `    ${JSON.stringify(tool)}: ${permission}`)
    ),
    mode: 0o600,
    merge: "upgrade-generated"
  },
  "agents.json": {
    content: json({
      version: 1,
      generated: true,
      reviewOnly: true,
      runtimeSource: "Generated review/setup mirror only; runtime authority is strongcode.config.yaml plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement. This file is not runtime-loaded.",
      defaultAgent: "tesla",
      agentOrder,
      agents
    }),
    merge: "upgrade-generated"
  },
  ...Object.fromEntries(BUILT_IN_AGENT_DEFINITIONS.map(agent => [`prompts/agents/${agent.id}.md`, {
    content: agentPromptMarkdown(agent),
    merge: "upgrade-generated" as const
  }])),
  "categories.json": {
    content: json({
      version: 1,
      defaultCategory: "unspecified-low",
      categories
    }),
    merge: "upgrade-generated"
  },
  "providers.json": {
    content: json({
      version: 1,
      defaultProvider: "mock",
      credentialStore: "auth.json",
      credentialResolutionOrder: ["environment", "credentialStore"],
      modelsFile: "models.json",
      providers: {
        mock: {
          type: "mock",
          displayName: "Mock",
          enabled: true
        },
        chatgpt: {
          type: "chatgpt",
          displayName: "ChatGPT",
          enabled: false,
          credentialRef: "chatgpt"
        },
        openai: {
          type: "openai",
          displayName: "OpenAI",
          enabled: false,
          baseUrl: "https://api.openai.com/v1",
          baseUrlEnv: "OPENAI_BASE_URL",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialRef: "openai",
          request: { timeoutMs: 120000, retries: 2, headersFromEnv: {} }
        },
        kimi: {
          type: "openai-compatible",
          displayName: "Kimi",
          enabled: false,
          baseUrl: "https://api.moonshot.ai/v1",
          apiKeyEnv: "MOONSHOT_API_KEY",
          credentialRef: "kimi"
        },
        grok: {
          type: "openai-compatible",
          displayName: "Grok",
          enabled: false,
          baseUrl: "https://api.x.ai/v1",
          apiKeyEnv: "XAI_API_KEY",
          credentialRef: "grok"
        },
        anthropic: {
          type: "anthropic",
          displayName: "Anthropic",
          enabled: false,
          baseUrlEnv: "ANTHROPIC_BASE_URL",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          credentialRef: "anthropic"
        },
        google: {
          type: "google",
          displayName: "Google AI",
          enabled: false,
          baseUrlEnv: "GOOGLE_AI_BASE_URL",
          apiKeyEnv: "GOOGLE_API_KEY",
          credentialRef: "google"
        },
        "google-vertex": {
          type: "google-vertex",
          displayName: "Google Vertex AI (ADC)",
          enabled: false,
          credentialRef: "google-vertex"
        },
        deepseek: {
          type: "openai-compatible",
          displayName: "DeepSeek",
          enabled: false,
          baseUrl: "https://api.deepseek.com",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          credentialRef: "deepseek"
        },
        zhipu: {
          type: "openai-compatible",
          displayName: "Z.AI / GLM",
          enabled: false,
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKeyEnv: "ZAI_API_KEY",
          credentialRef: "zhipu"
        },
        ollama: {
          type: "openai-compatible",
          displayName: "Ollama (local)",
          enabled: false,
          baseUrl: "http://127.0.0.1:11434/v1",
          allowUnauthenticated: true
        },
        lmstudio: {
          type: "openai-compatible",
          displayName: "LM Studio (local)",
          enabled: false,
          baseUrl: "http://127.0.0.1:1234/v1",
          allowUnauthenticated: true
        },
        vllm: {
          type: "openai-compatible",
          displayName: "vLLM (local)",
          enabled: false,
          baseUrl: "http://127.0.0.1:8000/v1",
          allowUnauthenticated: true
        },
        openrouter: {
          type: "openai-compatible",
          displayName: "OpenRouter",
          enabled: false,
          baseUrlEnv: "OPENROUTER_BASE_URL",
          apiKeyEnv: "OPENROUTER_API_KEY",
          credentialRef: "openrouter"
        },
        azure: {
          type: "openai-compatible",
          displayName: "Azure OpenAI",
          enabled: false,
          baseUrlEnv: "AZURE_OPENAI_BASE_URL",
          apiKeyEnv: "AZURE_OPENAI_API_KEY",
          credentialRef: "azure"
        },
        local: {
          type: "openai-compatible",
          displayName: "Local OpenAI-compatible server",
          enabled: false,
          baseUrlEnv: "LOCAL_OPENAI_BASE_URL",
          apiKeyEnv: "LOCAL_OPENAI_API_KEY",
          credentialRef: "local"
        }
      }
    }),
    merge: "upgrade-generated"
  },
  "models.json": {
    content: json({
      version: 1,
      defaultModel: "mock",
      aliases: { default: "mock", tesla: "mock", sisyphus: "mock" },
      models: {
        mock: {
          provider: "mock",
          model: "mock",
          displayName: "Mock",
          enabled: true,
          capabilities: {},
          variants: {},
          options: {},
          limits: {}
        }
      }
    }),
    merge: "upgrade-generated"
  },
  "permissions.json": {
    content: json({
      version: 1,
      defaultProfile: "interactive",
      evaluation: {
        strategy: "last-match-wins",
        defaultEffect: "ask",
        effects: ["allow", "ask", "deny"],
        rememberApprovalsFor: "session"
      },
      profiles: {
        interactive: {
          enabled: true,
          rules: [
            { action: "*", resource: "*", effect: "ask" },
            { action: "filesystem.read", resource: "workspace:**", effect: "allow" },
            { action: "git.read", resource: "workspace:**", effect: "allow" },
            { action: "agent.spawn", resource: "*", effect: "allow" },
            { action: "shell.elevated", resource: "*", effect: "deny" },
            { action: "git.force", resource: "*", effect: "deny" },
            { action: "secrets.reveal", resource: "*", effect: "deny" },
            { action: "external.effect", resource: "*", effect: "deny" }
          ]
        },
        "read-only": {
          enabled: true,
          rules: [
            { action: "*", resource: "*", effect: "deny" },
            { action: "filesystem.read", resource: "workspace:**", effect: "allow" },
            { action: "git.read", resource: "workspace:**", effect: "allow" }
          ]
        },
        autonomous: { enabled: false, rules: [] }
      }
    }),
    merge: "upgrade-generated"
  },
  "mcp.json": {
    content: json({
      version: 1,
      defaults: {
        autoStart: false,
        timeout: { startupMs: 15000, requestMs: 60000 },
        environment: {
          inherit: false,
          allowlist: ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TMP", "TEMP"]
        },
        stderrFile: "logs/mcp-stderr.log"
      },
      mcpServers: {
        context7: {
          enabled: true,
          autoStart: true,
          type: "remote",
          description: "Current library and API documentation.",
          readOnly: true,
          url: "https://mcp.context7.com/mcp",
          headersFromEnv: { CONTEXT7_API_KEY: { env: "CONTEXT7_API_KEY", required: false } },
          oauth: false
        },
        grep_app: {
          enabled: true,
          autoStart: true,
          type: "remote",
          description: "Public GitHub code search powered by grep.app.",
          readOnly: true,
          url: "https://mcp.grep.app",
          oauth: false
        },
        exa: {
          enabled: true,
          autoStart: true,
          type: "remote",
          description: "Primary current-web search and content fetch provider.",
          readOnly: true,
          url: "https://mcp.exa.ai/mcp",
          headersFromEnv: { Authorization: { env: "EXA_API_KEY", prefix: "Bearer ", required: false } },
          oauth: false
        },
        tinyfish: {
          enabled: true,
          autoStart: false,
          type: "remote",
          description: "OAuth-backed web search, extraction, and browser automation; web-search fallback after Exa.",
          readOnly: false,
          url: "https://agent.tinyfish.ai/mcp",
          oauth: true
        },
        semble: {
          enabled: true,
          autoStart: false,
          type: "local",
          description: "Token-efficient semantic and lexical workspace code search.",
          readOnly: true,
          timeout: { startupMs: 60000, requestMs: 60000 },
          command: ["uvx", "--from", "semble[mcp]==0.5.0", "semble", "--content", "all"],
          environmentFromEnv: ["SEMBLE_CACHE_LOCATION"],
          tokenSaver: "caveman-shrink"
        },
        graphify: {
          enabled: true,
          autoStart: false,
          type: "local",
          description: "Queryable project knowledge graph when graphify-out/graph.json exists.",
          readOnly: true,
          timeout: { startupMs: 120000, requestMs: 60000 },
          requiredFiles: ["graphify-out/graph.json"],
          command: ["uvx", "--from", "graphifyy[mcp]==0.9.11", "python", "-m", "graphify.serve", "graphify-out/graph.json"],
          tokenSaver: "caveman-shrink"
        },
        playwright: {
          enabled: true,
          autoStart: false,
          type: "local",
          description: "Isolated headless browser automation through Microsoft's Playwright MCP.",
          readOnly: false,
          workingDirectory: "config",
          timeout: { startupMs: 60000, requestMs: 60000 },
          command: ["npx", "--registry", "https://registry.npmjs.org/", "-y", "@playwright/mcp@0.0.78", "--headless", "--isolated", "--block-service-workers", "--image-responses", "omit", "--output-dir", "cache/playwright-mcp"]
        },
        chrome_devtools: {
          enabled: true,
          autoStart: false,
          type: "local",
          description: "Isolated headless Chrome debugging and performance analysis through Chrome DevTools MCP.",
          readOnly: false,
          workingDirectory: "config",
          timeout: { startupMs: 60000, requestMs: 60000 },
          command: ["npx", "--registry", "https://registry.npmjs.org/", "-y", "chrome-devtools-mcp@1.6.0", "--headless", "--isolated", "--no-usage-statistics", "--no-performance-crux"]
        },
        github: {
          enabled: true,
          autoStart: false,
          type: "remote",
          description: "GitHub's official hosted MCP server.",
          readOnly: false,
          requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
          url: "https://api.githubcopilot.com/mcp/",
          headersFromEnv: { Authorization: { env: "GITHUB_PERSONAL_ACCESS_TOKEN", prefix: "Bearer ", required: true } },
          oauth: false
        },
        headroom: {
          enabled: true,
          autoStart: false,
          type: "local",
          description: "Local reversible tool-output compression and token-savings statistics.",
          readOnly: false,
          timeout: { startupMs: 120000, requestMs: 120000 },
          command: ["uvx", "--from", "headroom-ai[mcp]==0.31.0", "headroom", "mcp", "serve"],
          environmentFromEnv: ["HEADROOM_STORE_URL", "HEADROOM_DEFAULT_MODE", "HEADROOM_MODEL_LIMITS", "HEADROOM_TELEMETRY"]
        },
        brave: {
          enabled: false,
          autoStart: false,
          type: "local",
          description: "Optional Brave Search fallback; opt in and provide BRAVE_API_KEY.",
          readOnly: true,
          timeout: { startupMs: 60000, requestMs: 60000 },
          requiredEnv: ["BRAVE_API_KEY"],
          command: ["npx", "-y", "@brave/brave-search-mcp-server@2.0.82", "--transport", "stdio", "--enabled-tools", "brave_web_search"],
          environmentFromEnv: ["BRAVE_API_KEY"]
        }
      },
      webSearch: {
        providers: [
          { server: "exa", tool: "web_search_exa", queryParameter: "query", enabled: true },
          { server: "tinyfish", tool: "search", queryParameter: "query", enabled: true },
          { server: "brave", tool: "brave_web_search", queryParameter: "query", enabled: false }
        ]
      },
      templates: {
        "local-stdio": {
          enabled: false,
          type: "local",
          command: ["replace-with-executable"],
          environmentFromEnv: []
        },
        "remote-http": {
          enabled: false,
          type: "remote",
          url: "https://example.invalid/mcp",
          headersFromEnv: {},
          oauth: false
        },
        "duckduckgo-search-only": {
          enabled: false,
          note: "Add a reviewed DuckDuckGo search-only MCP command here; StrongCode does not auto-install an unaffiliated package."
        },
        "self-hosted-firecrawl": {
          enabled: false,
          note: "Add your self-hosted Firecrawl MCP endpoint as an HTTPS remote server and opt it into webSearch.providers."
        },
        "self-hosted-searxng": {
          enabled: false,
          note: "Add your self-hosted SearXNG MCP endpoint as an HTTPS remote server and opt it into webSearch.providers."
        }
      }
    }),
    merge: "upgrade-generated"
  },
  "resources.json": {
    content: json({
      "$schema": "./schemas/config.schema.json",
      version: 1,
      instructions: ["AGENTS.md", "instructions/**/*.md"],
      prompts: ["prompts/**/*.md"],
      rules: ["rules/**/*.md"],
      commands: ["commands/**/*.md"],
      tools: ["tools/**/tool.json"],
      hooks: "hooks/hooks.json",
      themes: ["themes/*.json", "themes/custom/*.json"],
      schemas: ["schemas/*.schema.json"],
      examplesDirectory: "examples"
    }),
    merge: "upgrade-generated"
  },
  "skills.mcps.json": {
    content: json({
      version: 1,
      loadOrder: [
        "permissions",
        "providers",
        "models",
        "agents",
        "categories",
        "skills",
        "mcpServers"
      ],
      permissions: { config: "permissions.json" },
      providers: { config: "providers.json" },
      models: { config: "models.json" },
      agents: { config: "agents.json", directory: "agents" },
      categories: { config: "categories.json" },
      skills: {
        directory: "skills",
        manifestName: "SKILL.md",
        autoDiscover: true,
        enabled: [],
        disabled: []
      },
      mcpServers: { config: "mcp.json", directory: "mcps", autoStart: true },
      projects: { directory: "projects" },
      nodeModules: {
        directory: "node_modules",
        packageFile: "package.json",
        installOnStart: false,
        allowLifecycleScripts: false
      }
    }),
    merge: "upgrade-generated"
  },
  "tui.json": {
    content: json({
      "$schema": "./schemas/config.schema.json",
      version: 1,
      theme: "system",
      mouse: true,
      animations: true,
      compactMode: "auto",
      diffStyle: "auto",
      showTokenUsage: true,
      showCost: true,
      notifications: { enabled: true, sound: false }
    }),
    merge: "upgrade-generated"
  },
  "keybinds.json": {
    content: json({
      "$schema": "./schemas/config.schema.json",
      version: 1,
      leader: "ctrl+x",
      bindings: {}
    }),
    merge: "upgrade-generated"
  },
  "auth.json": {
    content: json({}),
    mode: 0o600,
    merge: "never"
  },
  "package.json": {
    content: json({
      name: "strongcode-user-config",
      private: true,
      description: "User-owned dependencies for StrongCode skills, plugins, tools, hooks, and MCP servers.",
      scripts: { list: "npm ls --depth=0" },
      dependencies: {}
    }),
    merge: "upgrade-generated"
  },
  ".env.example": {
    content: lines(
      "# Copy only the variables you use into your private environment or credential manager.",
      "OPENAI_API_KEY=",
      "OPENAI_BASE_URL=",
      "ANTHROPIC_API_KEY=",
      "ANTHROPIC_BASE_URL=",
      "GOOGLE_API_KEY=",
      "GOOGLE_AI_BASE_URL=",
      "MOONSHOT_API_KEY=",
      "XAI_API_KEY=",
      "DEEPSEEK_API_KEY=",
      "ZAI_API_KEY=",
      "GEMINI_API_KEY=",
      "OPENROUTER_API_KEY=",
      "OPENROUTER_BASE_URL=",
      "CONTEXT7_API_KEY=",
      "EXA_API_KEY=",
      "GITHUB_PERSONAL_ACCESS_TOKEN=",
      "BRAVE_API_KEY=",
      "FIRECRAWL_API_KEY=",
      "AZURE_OPENAI_API_KEY=",
      "AZURE_OPENAI_BASE_URL=",
      "LOCAL_OPENAI_API_KEY=",
      "LOCAL_OPENAI_BASE_URL="
    ),
    merge: "upgrade-generated"
  },
  ".gitignore": {
    content: lines(
      "auth.json",
      ".env",
      "credentials/",
      "node_modules/",
      "sessions/",
      "logs/",
      "cache/",
      "project-auth/",
      "tui/"
    ),
    merge: "upgrade-generated"
  },
  "AGENTS.md": {
    content: `${DEFAULT_GLOBAL_AGENT_INSTRUCTIONS}\n`,
    merge: "upgrade-generated"
  },
  "README.md": {
    content: lines(
      "# StrongCode Home",
      "",
      "This directory contains StrongCode runtime configuration and state plus generated review/setup mirrors.",
      "Set `STRONGCODE_HOME` to relocate the entire directory.",
      "",
      "Runtime authority is `strongcode.config.yaml` plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement.",
      "Generated `agents.json` and `prompts/agents/*.md` are review/setup mirrors. They are not runtime-loaded, and edits to them do not affect runtime.",
      "Trusted-home `categories.json` supplies lower-precedence category routing; `strongcode.config.yaml` wins field-wise.",
      "Other generated JSON catalogs document setup defaults and discovered resources; use the supported runtime configuration paths for durable changes.",
      "Credentials stay in private `auth.json`; setup state stays in `setup.json`.",
      "Runtime state uses `sessions/`, `project-auth/`, `tui/`, `logs/`, and `cache/`.",
      ...PREFLIGHT_HOME_DOCUMENTATION
    ),
    merge: "upgrade-generated"
  },
  "DIRECTORY.md": {
    content: lines(
      "# StrongCode Directory Map",
      "",
      "## Runtime configuration and generated mirrors",
      "",
      "- `strongcode.json` — root manifest, default profile/agent, and canonical paths.",
      "- `settings.json` — execution, sessions, context, logging, TUI, update, and telemetry defaults.",
      "- `providers.json` / `models.json` — provider connectivity and the separate model catalog.",
      "- `agents.json` — generated review/setup mirror; it is not runtime-loaded.",
      "- `categories.json` — trusted-home category routing below `strongcode.config.yaml`, which wins field-wise.",
      "- `permissions.json` — generated permission-profile metadata; the compiled runtime enforces permissions and workspace boundaries.",
      "- `mcp.json` — enabled MCP catalog, lazy/auto-start policy, web-search fallback order, and transport templates.",
      "- `skills.mcps.json` / `resources.json` — discovery order and resource entry points.",
      "- `tui.json` / `keybinds.json` — terminal client preferences.",
      "",
      "## Reusable resources",
      "",
      "- `agents/`, `skills/`, `commands/`, `prompts/`, `rules/`, `instructions/`.",
      "- `tools/`, `hooks/`, `mcps/`, `plugins/`, `themes/`, `extensions/`.",
      "- `schemas/` validates editable JSON; `examples/` is documentation and is never auto-loaded.",
      "",
      "## Work and durable state",
      "",
      "- `projects/` and `worktrees/` hold managed repositories and external-project registrations.",
      "- `sessions/`, `tasks/`, `plans/`, `evidence/`, `artifacts/`, `attachments/`, `checkpoints/`, `snapshots/`.",
      "- `memories/` is split into global, project, agent, session, and inbox scopes.",
      "- `cron/` contains disabled-by-default jobs, scripts, history, and output.",
      "",
      "## Machine-managed and disposable state",
      "",
      "- `runtime/`, `logs/`, `cache/`, `tmp/`, `locks/`, `downloads/`, `updates/`, `telemetry/`.",
      "- `indexes/` is always rebuildable. `backups/`, `exports/`, `imports/`, and `trash/` are explicit lifecycle areas.",
      "- `profiles/` overlays root configuration without duplicating shared sessions or runtime state."
    ),
    merge: "upgrade-generated"
  },
  "SECURITY.md": {
    content: lines(
      "# StrongCode Home Security",
      "",
      "- Keep actual keys and OAuth tokens only in `auth.json`, `credentials/`, environment variables, or an OS credential store.",
      "- Provider and MCP configuration should reference environment-variable names, never literal secrets.",
      "- MCPs, hooks, tools, plugins, and package lifecycle scripts can execute code. Built-in remote read-only MCPs auto-start; local/downloaded/authenticated MCPs are lazy, and custom examples stay disabled.",
      "- Project-local executable configuration must require trust before it can run.",
      "- `permissions.json` is generated review metadata. Runtime permission enforcement and workspace boundaries provide the actual sandbox; editing this mirror does not change them.",
      "- Never commit `auth.json`, `.env`, `credentials/`, sessions, logs, or runtime data."
    ),
    merge: "upgrade-generated"
  },
  "config/sandbox.json": {
    content: json({ version: 1, enabled: true, workspaceOnly: true, network: "ask", elevatedCommands: "deny" }),
    merge: "upgrade-generated"
  },
  "config/compaction.json": {
    content: json({ version: 1, auto: true, pruneToolOutputs: true, preserveRecentTurns: 8, reservedTokens: null }),
    merge: "upgrade-generated"
  },
  "config/notifications.json": {
    content: json({ version: 1, enabled: true, desktop: true, sound: false, onCompletion: true, onApproval: true, onError: true }),
    merge: "upgrade-generated"
  },
  "config/telemetry.json": {
    content: json({ version: 1, enabled: false, anonymousUsage: false, crashReports: false, localAuditLog: true }),
    merge: "upgrade-generated"
  },
  "config/retention.json": {
    content: json({ version: 1, sessionsDays: null, logsDays: 14, cacheDays: 30, backupsToKeep: 10, trashDays: 30 }),
    merge: "upgrade-generated"
  },
  "config/updates.json": {
    content: json({ version: 1, channel: "stable", checkOnStart: false, autoDownload: false, autoInstall: false }),
    merge: "upgrade-generated"
  },
  "plugins/registry.json": {
    content: json({
      version: 1,
      settings: {
        autoDiscover: true,
        autoUpdate: false,
        allowRemoteInstall: false,
        allowLifecycleScripts: false,
        trustedByDefault: false,
        requireChecksumForRemote: true
      },
      marketplaces: {},
      plugins: {}
    }),
    merge: "upgrade-generated"
  },
  "projects/registry.json": {
    content: json({
      version: 1,
      defaultProject: null,
      storage: { projectsDirectory: "projects", worktreesDirectory: "worktrees" },
      projects: {},
      deletedProjectIds: []
    }),
    merge: "upgrade-generated"
  },
  "profiles/registry.json": {
    content: json({ version: 1, activeProfile: "default", profiles: { default: { path: "profiles/default", enabled: true } } }),
    merge: "upgrade-generated"
  },
  "profiles/default/profile.json": {
    content: json({ version: 1, id: "default", displayName: "Default", description: "Root StrongCode configuration without overrides.", extends: null, overrides: {} }),
    merge: "upgrade-generated"
  },
  "hooks/hooks.json": {
    content: json({
      version: 1,
      enabled: true,
      defaults: { timeoutMs: 10000, failurePolicy: "warn", environmentInherit: false },
      events: {
        sessionStart: [], sessionEnd: [], turnStart: [], turnEnd: [], preModel: [], postModel: [],
        preTool: [], postTool: [], approval: [], subagent: [], error: []
      }
    }),
    merge: "upgrade-generated"
  },
  "cron/jobs.json": {
    content: json({ version: 1, enabled: false, timezone: "local", jobs: {} }),
    merge: "upgrade-generated"
  },
  "themes/strongcode-dark.json": {
    content: json({ version: 1, name: "strongcode-dark", type: "dark", colors: {} }),
    merge: "upgrade-generated"
  },
  "themes/strongcode-light.json": {
    content: json({ version: 1, name: "strongcode-light", type: "light", colors: {} }),
    merge: "upgrade-generated"
  },
  "memories/global/MEMORY.md": {
    content: lines("# Global Memory", "", "Stable facts that should be available across StrongCode projects belong here."),
    merge: "never"
  },
  "memories/global/USER.md": {
    content: lines("# User Context", "", "User preferences and working conventions can be recorded here."),
    merge: "never"
  },
  "memories/global/preferences.md": {
    content: lines("# Preferences", ""),
    merge: "never"
  },
  "memories/global/corrections.md": {
    content: lines("# Corrections", ""),
    merge: "never"
  },
  "memories/global/decisions.jsonl": { content: "", merge: "never" },
  "plans/templates/implementation.md": {
    content: lines("# Implementation Plan", "", "## Goal", "", "## Constraints", "", "## Steps", "", "## Verification"),
    merge: "upgrade-generated"
  },
  "plans/templates/research.md": {
    content: lines("# Research Plan", "", "## Question", "", "## Sources", "", "## Findings", "", "## Decision"),
    merge: "upgrade-generated"
  },
  "plans/templates/migration.md": {
    content: lines("# Migration Plan", "", "## Source", "", "## Destination", "", "## Safety", "", "## Rollback", "", "## Verification"),
    merge: "upgrade-generated"
  },
  "tasks/index.json": { content: json({ version: 1, tasks: {} }), merge: "upgrade-generated" },
  "worktrees/index.json": { content: json({ version: 1, worktrees: {} }), merge: "upgrade-generated" },
  "sessions/index.jsonl": { content: "", merge: "never" },
  "history/prompts.jsonl": { content: "", merge: "never" },
  "indexes/projects.json": { content: json({ version: 1, generatedAt: null, projects: {} }), merge: "upgrade-generated" },
  "indexes/worktrees.json": { content: json({ version: 1, generatedAt: null, worktrees: {} }), merge: "upgrade-generated" },
  "indexes/tasks.json": { content: json({ version: 1, generatedAt: null, tasks: {} }), merge: "upgrade-generated" },
  "indexes/resources.json": { content: json({ version: 1, generatedAt: null, resources: {} }), merge: "upgrade-generated" },
  "indexes/models.json": { content: json({ version: 1, generatedAt: null, models: {} }), merge: "upgrade-generated" },
  "indexes/plugins.json": { content: json({ version: 1, generatedAt: null, plugins: {} }), merge: "upgrade-generated" },
  "indexes/tools.json": { content: json({ version: 1, generatedAt: null, tools: {} }), merge: "upgrade-generated" },
  "state/layout.json": {
    content: json({ version: 1, layoutVersion: STRONGCODE_HOME_LAYOUT_VERSION, migrations: [] }),
    merge: "upgrade-generated"
  },
  "updates/state.json": { content: json({ version: 1, lastCheckAt: null, availableVersion: null, downloadedVersion: null }), merge: "upgrade-generated" },
  "backups/index.json": { content: json({ version: 1, backups: [] }), merge: "upgrade-generated" },
  "exports/index.json": { content: json({ version: 1, exports: [] }), merge: "upgrade-generated" },
  "imports/index.json": { content: json({ version: 1, imports: [] }), merge: "upgrade-generated" },
  "registries/marketplaces.json": { content: json({ version: 1, marketplaces: {} }), merge: "upgrade-generated" },
  "agents/README.md": {
    content: lines(
      "# Generated Agent Mirror Assets",
      "",
      "Place generated agent prompt packages or role-specific review assets here.",
      "Routing authority is `strongcode.config.yaml` plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement.",
      "`../agents.json` is a generated review/setup mirror, is not runtime-loaded, and cannot change runtime behavior."
    ),
    merge: "upgrade-generated"
  },
  "skills/README.md": { content: lines("# Skills", "", "Each skill uses `skills/<id>/SKILL.md` with optional `scripts/`, `references/`, and `assets/`."), merge: "upgrade-generated" },
  "commands/README.md": { content: lines("# Commands", "", "Place reusable command Markdown files here."), merge: "upgrade-generated" },
  "tools/README.md": { content: lines("# Tools", "", "Tools can contain a `tool.json`, implementation, and README. Review executable code before enabling it."), merge: "upgrade-generated" },
  "hooks/README.md": { content: lines("# Hooks", "", "Hook registration lives in `hooks.json`; executable scripts are grouped by lifecycle event under `scripts/`."), merge: "upgrade-generated" },
  "mcps/README.md": { content: lines("# MCP Servers", "", "User MCP declarations live in `../mcp.json`. Keep reusable server packages or documentation here."), merge: "upgrade-generated" },
  "plugins/README.md": { content: lines("# Plugins", "", "Installed plugin records live in `registry.json`; managed copies use `managed/`, caches use `cache/`, and plugin data uses `data/`."), merge: "upgrade-generated" },
  "projects/README.md": { content: lines("# Projects", "", "Managed repositories may live here. External repositories can be registered in `registry.json` without being moved."), merge: "upgrade-generated" },
  "worktrees/README.md": { content: lines("# Worktrees", "", "StrongCode-managed Git worktrees are grouped here by project and worktree id."), merge: "upgrade-generated" },
  "indexes/README.md": { content: lines("# Rebuildable Indexes", "", "Everything in this directory is derived state and can be deleted and rebuilt."), merge: "upgrade-generated" },
  "examples/README.md": { content: lines("# Examples", "", "Files here are documentation only and are never automatically loaded or executed."), merge: "upgrade-generated" },
  "examples/agent.example.json": {
    content: json({ version: 1, id: "example-agent", enabled: false, mode: "subagent", model: "mock", permissionProfile: "read-only" }),
    merge: "upgrade-generated"
  },
  "examples/project.example.json": {
    content: json({ version: 1, id: "example-project", name: "Example", path: "replace-with-absolute-path", trusted: false, archived: false }),
    merge: "upgrade-generated"
  },
  "examples/mcp.example.json": {
    content: json({ version: 1, mcpServers: { example: { enabled: false, type: "local", command: ["replace-with-executable"] } } }),
    merge: "upgrade-generated"
  },
  "examples/plugin.example.json": {
    content: json({ version: 1, id: "example-plugin", enabled: false, trusted: false, source: "replace-with-local-path", checksum: null }),
    merge: "upgrade-generated"
  },
  "examples/cron-job.example.json": {
    content: json({ version: 1, id: "example-job", enabled: false, schedule: "replace-with-schedule", command: "replace-with-command" }),
    merge: "upgrade-generated"
  },
  "examples/theme.example.json": {
    content: json({ version: 1, name: "example-theme", type: "dark", colors: {} }),
    merge: "upgrade-generated"
  },
  "schemas/config.schema.json": { content: json(genericConfigSchema), merge: "upgrade-generated" },
  "schemas/strongcode.schema.json": {
    content: json(baseSchema("StrongCode root manifest", {
      "$schema": { type: "string" },
      version: { const: 1 },
      layoutVersion: { type: "integer", minimum: 1 },
      defaultAgent: { type: "string", minLength: 1 },
      defaultProfile: { type: "string", minLength: 1 },
      files: { type: "object", additionalProperties: { type: "string" } },
      directories: { type: "object", additionalProperties: { type: "string" } }
    }, ["version", "layoutVersion", "defaultAgent", "files", "directories"])),
    merge: "upgrade-generated"
  },
  "schemas/settings.schema.json": { content: json(baseSchema("StrongCode settings", { "$schema": { type: "string" }, version: { const: 1 } })), merge: "upgrade-generated" },
  "schemas/agents.schema.json": {
    content: json({
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      title: "StrongCode generated review-only agents mirror",
      description: "Read-only generated review/setup mirror. It is not runtime-loaded; runtime authority is strongcode.config.yaml plus StrongCode's compiled typed agent registry/factory and runtime permission enforcement.",
      readOnly: true,
      type: "object",
      required: ["version", "generated", "reviewOnly", "runtimeSource", "defaultAgent", "agents"],
      properties: {
        "$schema": { type: "string" },
        version: { const: 1 },
        generated: { const: true },
        reviewOnly: { const: true },
        runtimeSource: { type: "string", minLength: 1 },
        defaultAgent: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
        agentOrder: { type: "array", items: { type: "string" }, uniqueItems: true },
        agents: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["enabled", "mode"],
            properties: {
              enabled: { type: "boolean" },
              mode: { enum: ["primary", "subagent"] },
              model: { type: "string", minLength: 1 },
              category: { type: "string", minLength: 1 },
              fallbackModels: { type: "array", items: { type: "string" } }
            },
            additionalProperties: true
          }
        }
      },
      additionalProperties: true
    }),
    merge: "upgrade-generated"
  },
  "schemas/categories.schema.json": { content: json(baseSchema("StrongCode categories", { "$schema": { type: "string" }, version: { const: 1 }, categories: { type: "object" } }, ["version", "categories"])), merge: "upgrade-generated" },
  "schemas/providers.schema.json": { content: json(baseSchema("StrongCode providers", { "$schema": { type: "string" }, version: { const: 1 }, providers: { type: "object" } }, ["version", "providers"])), merge: "upgrade-generated" },
  "schemas/models.schema.json": { content: json(baseSchema("StrongCode models", { "$schema": { type: "string" }, version: { const: 1 }, models: { type: "object" } }, ["version", "models"])), merge: "upgrade-generated" },
  "schemas/permissions.schema.json": { content: json(baseSchema("StrongCode permissions", { "$schema": { type: "string" }, version: { const: 1 }, profiles: { type: "object" } }, ["version", "profiles"])), merge: "upgrade-generated" },
  "schemas/mcp.schema.json": { content: json(baseSchema("StrongCode MCP servers", { "$schema": { type: "string" }, version: { const: 1 }, mcpServers: { type: "object" } }, ["version", "mcpServers"])), merge: "upgrade-generated" },
  "schemas/resources.schema.json": { content: json(baseSchema("StrongCode discovery resources", { "$schema": { type: "string" }, version: { const: 1 }, loadOrder: { type: "array", items: { type: "string" } } }, ["version", "loadOrder"])), merge: "upgrade-generated" }
};

const STRONGCODE_HOME_CORE_FILES = new Set([
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "agents.json",
  "auth.json",
  "categories.json",
  "mcp.json",
  "models.json",
  "package.json",
  "permissions.json",
  "providers.json",
  "skills.mcps.json",
  "strongcode.config.yaml",
  "strongcode.json",
  ...BUILT_IN_AGENT_DEFINITIONS.map(agent => `prompts/agents/${agent.id}.md`)
]);

/** Starter artifacts required by the current harness; expanded speculative scaffolding is intentionally excluded. */
export const STRONGCODE_HOME_STARTER_FILES: Record<string, StrongCodeHomeStarterFile> = Object.fromEntries(
  Object.entries(STRONGCODE_HOME_EXPANDED_STARTER_FILES).filter(([relativePath]) => STRONGCODE_HOME_CORE_FILES.has(relativePath))
);

/** SHA-256 hashes of untouched older generated files eligible for explicit expansion. */
export const STRONGCODE_HOME_LEGACY_HASHES: Record<string, readonly string[]> = {
  "VERSION": ["53c234e5e8472b6ac51c1ae1cab3fe06fad053beb8ebfd8977b010655bfdd3c3", "06e9d52c1720fca412803e3b07c4b228ff113e303f4c7ab94665319d832bbfb7"],
  ".gitignore": ["43b3969a042902e8bde00fe5629a304f2d1c6112beb6e39bd53c00a386315101"],
  "agents.json": ["6c0c629ac94daf926db6655c97920ab1054cccd0d31179be38efe2f62864019e", "929574aa9579892f65995fad703860e947c4e38a1360e70f51fc933d682ed971", "7a5fa9b4782efb0b1c1c69381de789f91d7b76967a7555c04943af4ebb4fed80", "821ec04bc569e95ebd76131a64a00d446773f66ff08cdeb01b695e4feaf7561e"],
  "AGENTS.md": ["24ac6fa7cc3d187917078b2c9a2c630443f95bf2b8e72086b931d34433504486"],
  "mcp.json": ["d4f41040dd1622f1b5f936d9b6705372ec2eaf85625535dddbd903112954e4ad", "d7fb203472edf219daf70c1e3be7cf109adbca6becd8980362c3be2af32461dc"],
  "package.json": ["a98249b792eff6d0c4d78ed427c9d24301f6f083ea429bdcb25f071799861212"],
  "providers.json": ["104560e6065d7eee49e00eee3a9672f494c6e7a6d24e0dc0c16570ab5e999e2d", "a71b26077a6c199060f768e8d0baf058175213cd4be8b0aeddb3a4ab183293ed"],
  "README.md": ["f78fc1863ca3f32d760c1a7c56e4031c6e400322d6f801f778bcc8ec78b9dfdd", "a947891a9343c9ea9189ff1ff19bc34fee2bc175889edb96d5c00a5c7fd30f1d", "febcc57ec494626888dc08c25ea12622e2b0f8d7258bf9009df47743954ab005"],
  "DIRECTORY.md": ["8fe76b708edca250f1dd575e62ab2ab51d758bde3727e5f4cffeeb27b3811e0a", "23b1bfcbdff12eca0e85cf013512a2084b303c44396142c4791767724b5b4bcb"],
  "SECURITY.md": ["d3c0e05a9b59b05fecba7919964bb5767e236bf4637578cb984bba426be452db"],
  "skills.mcps.json": ["a27b542445f5fb4744406b88364543ca31e58f3f0c73b4872f0e7a9122797f19"],
  "strongcode.json": ["957744f1fd1bec68d0218cd358bc95a84940c7557acf8b6a76c411702d5f7d31", "733bffba3e4633a4aeeacfbeee07cfee1a38979026edb0c31ec16fd2152b65b8", "4410f3f81cd2e96628be1cfe2c1f5bb33a4a275c7ef5b60b8ac56eb99d08a38c", "f8572f1364acf862e7b9801ad736139df2798af790d966660d20b495fc661256"],
  "strongcode.config.yaml": ["17091f5d52c5f0ef41a0d1a149a41c446b133e2c7eefef02e8de8104f7aa9dac", "35d034f0269623f5465414cba15ea9d2c50ea37810843561292406e23f4c3bcd"],
  "categories.json": ["b042143166c9ea8bdedc9030160c46f2092a19b0f1e251fd7859e7d1b4ba8b98"],
  "models.json": ["8b4675ad4724271617af8df484fadaf22ce25c4c1e467a8c9590ac09b988c6f2"],
  "prompts/agents/tesla.md": ["dec7c49d0316e878b9912fcf73422655c7cc6376a1b334e6aee733fb44e33238", "0364c9785cfe28ddbec40eaaeaad7acc5a30bb9ead41b2d6476cc8451cc261fd", "c01122303397d1edeff4cf9a02bafd7f5fc55d4a7a6987bf9ba5ffb93fbeca22"],
  "prompts/agents/newton.md": ["f9f162a85a74e025b1428b7e6fddcf6f13b5a6ba3571d43e645c666d9437c4a0", "1e005ac4d395d7cc4bac8dd67ee6b04175ce442ed800e7a8a44730565f09f8d1", "383c44e2e15a192ace9779a7e378562d103155e4639c5022ec37ff98e6c7c46e"],
  "prompts/agents/jbp.md": ["a4482cf6e0112675f86837a7f2b4995267fc57519813947300559c6752f1177a", "ef8e89da8ee3e5cd8601bbf5aa1eb8d439aac43ce44578200cc145e9d77eb829", "bdd669e84d75822abd613b33b7fc1fc03bf8ea09659b2e57f5ec4da658869a52"],
  "prompts/agents/bob-the-builder.md": ["c052e7ce30410479e0ef38d6a4552468c97f455f9e103bcd360183765c91d6e6", "962a32d0432e73bcd2d7f33ab3608fda354131571146ee1cce5b61185255ede5", "1e97a2d15dc9e5276ef7958779c5ca9d3122588e08d9284b1b0b89058574cd44"],
  "prompts/agents/hood-research-department.md": ["4139c1c940bdf764744c14f7b3dba3ce8a9794b01dc172df20289e7fbd2e65e7", "f4e390769a29c286dc5eaf923e67f8cbcf5435bda761adb253e4ed4291ddc8ad"],
  "prompts/agents/steve-jobs.md": ["29fd9dd20b33ac37a2820c37052d16c9e73297e4e79c281b26f2617655ed6680", "12e248ba0417920e393b494b6eae88d27d7ddafaef02ce229b8883d69e99679f"],
  "prompts/agents/government.md": ["9bcec98e09ed58beb327ebea3289a4104e28552045252f14630a982da3e2d5b6", "a13e118d9b267f8ec575547dba77dd236ee1ab077adf4f6155f4e942e0ff3b7e"],
  "prompts/agents/meta.md": ["b14570036456e203ff45e4f3f3234a15ddf84beabad0c8a765660fe69393b875", "893b1d5ec9883a068d602277b956eafbefe599dcd68aa7222140e14d8befdb1f"],
  "prompts/agents/sugar-boo.md": ["7948113c7071b3f561322e724f44739279a65bc8ae16011100daff7b1ea33650", "4f519b3b370b838467fd8ee11f46599f470451a3834ce359d88cc4a8f2628808"],
  "prompts/agents/warren-buffer.md": ["5b1b5d879090eed4a2fbda97f2ca46292036352994c5d85082209d2486a67d5a", "d3cc181232adfc1b97f3862b6207a71a3ca90e78ea4d151ea8d087a4de7f4116"],
  "state/layout.json": ["da94737c17eddbe21efe4d7da36bf1568aab37d8d59176ccba12c8de307b378b", "5b0720814c7319c40f9e202cd017afabe71a2d737e9a12dd2dd79a8a74e3bd10"]
};
