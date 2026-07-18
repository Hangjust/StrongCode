export const EXAMPLE_CONFIG = `version: 1
workspace: "."
dataDir: ".strongcode"
defaultAgent: tesla
providers:
  chatgpt:
    type: chatgpt
    displayName: ChatGPT
    enabled: false
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
    baseUrl: https://api.anthropic.com/v1
    modelsEndpoint: /models
    enabled: false
  grok:
    type: openai-compatible
    displayName: Grok
    apiKeyEnv: XAI_API_KEY
    baseUrl: https://api.x.ai/v1
    modelsEndpoint: /models
    enabled: false
  google:
    type: google
    displayName: Google Gemini
    apiKeyEnv: GEMINI_API_KEY
    baseUrl: https://generativelanguage.googleapis.com/v1beta
    modelsEndpoint: /models
    enabled: false
  deepseek:
    type: openai-compatible
    displayName: DeepSeek
    apiKeyEnv: DEEPSEEK_API_KEY
    baseUrl: https://api.deepseek.com
    modelsEndpoint: /models
    enabled: false
  zhipu:
    type: openai-compatible
    displayName: Z.AI / GLM
    apiKeyEnv: ZAI_API_KEY
    baseUrl: https://api.z.ai/api/paas/v4
    modelsEndpoint: /models
    enabled: false
  ollama:
    type: openai-compatible
    displayName: Ollama (local)
    baseUrl: http://127.0.0.1:11434/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
    enabled: false
  lmstudio:
    type: openai-compatible
    displayName: LM Studio (local)
    baseUrl: http://127.0.0.1:1234/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
    enabled: false
  vllm:
    type: openai-compatible
    displayName: vLLM (local)
    baseUrl: http://127.0.0.1:8000/v1
    modelsEndpoint: /models
    allowUnauthenticated: true
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
permissions:
  tools:
    list_files: allow
    read_file: allow
`;
