import path from "node:path";
import type { ProviderConfig, StrongCodeConfig } from "../config/schema";
import { loadConfig } from "../config/load";
import { ensureStrongCodeHome } from "../config/home";
import { resolveStrongCodeHome } from "../config/paths";
import { StrongCodeError } from "../core/errors";
import { ProviderAuth, ProviderAuthStore } from "../models/auth-store";
import { runChatGptLogin, type ChatGptLoginMode, type ChatGptOAuthOptions } from "../models/chatgpt-oauth";
import { listChatGptModels } from "../models/chatgpt-models";
import { runGoogleAdcLogin } from "../models/gcloud-delegated";
import { parseProviderBaseUrl } from "../models/provider-url";
import { providerDefaults } from "../models/registry";
import { resolveProviderCredentials } from "../models/credentials";
import { configuredProviderIds, disableProvidersExcept, globalConfigPath, loadSetupConfig, mergeConfiguredProvider, saveSetupConfig } from "./config";
import { discoverModelsForSetup, scanLocalProviders, SetupDiscoveredModel, SetupDiscoveryHttpError, SetupDiscoveryOptions } from "./discovery";
import { TerminalSetupPrompter } from "./prompter";
import { emptySetupState, loadSetupState, updateSetupState } from "./state";
import { BLENDER_OFFER_VERSION, SetupCancelledError, SetupChoice, SetupPrompter, SetupResult, SetupState,
  VoiceToTextChoice } from "./types";
import { applyVoiceToTextInstructions } from "./voice-instructions";
import { setupBlenderIntegration, type BlenderSetupDependencies } from "./blender/setup";
import { mergeBlenderSetupResult } from "./blender/state";

const PROVIDER_CHOICES = [
  { value: "openai", label: "OpenAI / ChatGPT", hint: "Browser login · API key" },
  { value: "anthropic", label: "Anthropic", hint: "Claude" },
  { value: "google", label: "Google", hint: "Gemini · Vertex" },
  { value: "grok", label: "xAI", hint: "Grok" },
  { value: "kimi", label: "Kimi", hint: "Moonshot" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "GLM", hint: "Z.AI" },
  { value: "local", label: "Local", hint: "Ollama · LM Studio · vLLM" },
  { value: "custom", label: "Custom", hint: "Base URL" },
  { value: "catalog", label: "Other model", hint: "Browse providers" },
  { value: "cursor", label: "Cursor", hint: "Connect its provider" }
] as const;

const CURATED_MODEL_FAMILIES = [
  { value: "openai", label: "OpenAI / ChatGPT" },
  { value: "anthropic", label: "Anthropic / Claude" },
  { value: "google", label: "Google / Gemini / Gemma" },
  { value: "grok", label: "xAI / Grok" },
  { value: "kimi", label: "Moonshot / Kimi" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "zhipu", label: "Z.AI / GLM" },
  { value: "custom", label: "Llama · Qwen · Mistral · Other" }
] as const;

const API_ENV_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  grok: "XAI_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  "moonshot-cn": "MOONSHOT_API_KEY",
  "kimi-code": "KIMI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  "zhipu-cn": "ZHIPU_API_KEY"
};

export interface SetupWizardDependencies {
  homePath?: string;
  prompter?: SetupPrompter;
  authStore?: ProviderAuthStore;
  discovery?: SetupDiscoveryOptions;
  runChatGptLogin?: typeof runChatGptLogin;
  listChatGptModels?: typeof listChatGptModels;
  scanLocalProviders?: typeof scanLocalProviders;
  runGoogleAdcLogin?: typeof runGoogleAdcLogin;
  now?: () => Date;
  interactive?: boolean;
  workspace?: string;
  blender?: BlenderSetupDependencies;
}

export interface RunSetupOptions {
  force?: boolean;
}

interface WizardContext {
  homePath: string;
  prompter: SetupPrompter;
  authStore: ProviderAuthStore;
  discovery: SetupDiscoveryOptions;
  warnings: string[];
  runChatGptLogin: typeof runChatGptLogin;
  listChatGptModels: typeof listChatGptModels;
  scanLocalProviders: typeof scanLocalProviders;
  runGoogleAdcLogin: typeof runGoogleAdcLogin;
}

function requiredProvider(config: StrongCodeConfig, providerId: string): ProviderConfig {
  const provider = config.providers[providerId] ?? providerDefaults()[providerId];
  if (!provider) throw new StrongCodeError("CONFIG_ERROR", `Provider '${providerId}' is not registered`);
  return provider;
}

function withProviderDetails(base: ProviderConfig, values: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: values.type ?? base.type,
    displayName: values.displayName ?? base.displayName,
    apiKeyEnv: values.apiKeyEnv ?? base.apiKeyEnv,
    baseUrl: values.baseUrl ?? base.baseUrl,
    modelsEndpoint: values.modelsEndpoint ?? base.modelsEndpoint,
    allowUnauthenticated: values.allowUnauthenticated ?? base.allowUnauthenticated,
    enabled: values.enabled ?? true
  };
}

function customProviderId(displayName: string, suggestedId: string | undefined, reserved: Set<string>): string {
  const fallback = suggestedId ?? "custom";
  const base = (suggestedId ?? displayName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "") || fallback;
  let value = base;
  for (let suffix = 2; reserved.has(value); suffix += 1) value = `${base}-${suffix}`;
  return value;
}

function titleFromId(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function validateProviderName(value: string): string | undefined {
  if (!value.trim()) return "Enter a name.";
  if (Array.from(value).length > 80) return "Use 80 characters or fewer.";
  if (/\u001B|[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(value)) {
    return "Remove control characters from the name.";
  }
  return undefined;
}

function validateBaseUrl(value: string): string | undefined {
  try {
    parseProviderBaseUrl(value, "custom setup");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function modelPreferenceScore(model: SetupDiscoveredModel): number {
  const value = `${model.id} ${model.displayName}`.toLowerCase();
  if (/embedding|moderation|rerank|image|audio|speech|whisper|transcri|tts/.test(value)) return -100;
  if (/chat|instruct|reason|gpt|claude|gemini|gemma|grok|kimi|moonshot|deepseek|glm|coder|code/.test(value)) return 100;
  return 0;
}

function rankedModels(models: SetupDiscoveredModel[]): SetupDiscoveredModel[] {
  const unsafe = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
  const sanitized = models.flatMap(model => {
    if (!model.id || model.id.length > 256 || unsafe.test(model.id)) return [];
    const displayName = model.displayName
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return [{ ...model, displayName: Array.from(displayName || model.id).slice(0, 160).join("") }];
  });
  return sanitized.sort((left, right) =>
    modelPreferenceScore(right) - modelPreferenceScore(left)
      || left.displayName.localeCompare(right.displayName)
      || left.id.localeCompare(right.id)
  );
}

async function chooseModels(ctx: WizardContext, providerLabel: string, discovered: SetupDiscoveredModel[], manualDefault = ""): Promise<SetupDiscoveredModel[]> {
  const ranked = rankedModels(discovered);
  if (ranked.length === 0) {
    const id = await ctx.prompter.text(`${providerLabel} model ID`, {
      initialValue: manualDefault || undefined,
      placeholder: "provider-model-id",
      validate: value => {
        if (!value.trim()) return "Enter a model ID.";
        if (value.length > 256 || /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(value)) {
          return "Use a model ID without control characters (maximum 256 characters).";
        }
        return undefined;
      }
    });
    return [{ id, displayName: id }];
  }
  if (ranked.length === 1) return ranked;
  const selected = await ctx.prompter.multiselect(
    `Models · ${providerLabel}`,
    ranked.map(model => ({ value: model.id, label: model.displayName, hint: model.id === model.displayName ? undefined : model.id })),
    [ranked[0]!.id]
  );
  const selectedModels = ranked.filter(model => selected.includes(model.id));
  if (selectedModels.length < 2) return selectedModels;
  const defaultId = await ctx.prompter.select(
    `Default · ${providerLabel}`,
    selectedModels.map(model => ({ value: model.id, label: model.displayName, hint: model.id === model.displayName ? undefined : model.id })),
    selectedModels[0]!.id
  );
  const preferred = selectedModels.find(model => model.id === defaultId)!;
  return [preferred, ...selectedModels.filter(model => model.id !== defaultId)];
}

type ApiKeySource = "existing" | "environment" | "entered";

interface ResolvedApiKey {
  apiKey: string;
  configured: boolean;
  source?: ApiKeySource;
}

interface ConfiguredModelsResult {
  models: SetupDiscoveredModel[];
  authenticationRejected: boolean;
}

async function resolveApiKey(ctx: WizardContext, providerId: string, provider: ProviderConfig): Promise<ResolvedApiKey> {
  const existing = await ctx.authStore.get(providerId);
  const envName = provider.apiKeyEnv ?? API_ENV_BY_PROVIDER[providerId];
  const envAvailable = Boolean(envName && process.env[envName]);
  const choices: SetupChoice[] = [
    { value: "enter", label: "API key" }
  ];
  if (envName && envAvailable) choices.push({ value: "environment", label: envName, hint: "environment" });
  if (existing?.type === "api") choices.unshift({ value: "existing", label: "Saved key" });
  choices.push({ value: "skip", label: "Not now" });
  const method = await ctx.prompter.select(`Auth · ${provider.displayName}`, choices, existing?.type === "api" ? "existing" : envAvailable ? "environment" : "enter");
  if (method === "skip") return { apiKey: "", configured: false };
  if (method === "existing" && existing?.type === "api") return { apiKey: existing.key, configured: true, source: "existing" };
  if (method === "environment") {
    const apiKey = envName ? process.env[envName] ?? "" : "";
    if (!apiKey) {
      ctx.prompter.note(`${envName ?? "The provider API-key environment variable"} is not set, so this provider was not enabled.`);
      return { apiKey: "", configured: false };
    }
    return { apiKey, configured: true, source: "environment" };
  }
  const apiKey = await ctx.prompter.secret(`${provider.displayName} API key`);
  return { apiKey, configured: true, source: "entered" };
}

async function configuredModels(ctx: WizardContext, providerId: string, provider: ProviderConfig, apiKey: string, manualDefault = ""): Promise<ConfiguredModelsResult> {
  let discovered: SetupDiscoveredModel[] = [];
  const status = ctx.prompter.status?.(`Finding ${provider.displayName} models`);
  try {
    discovered = await discoverModelsForSetup(provider, apiKey, ctx.discovery);
    status?.stop(`${discovered.length} ${provider.displayName} model${discovered.length === 1 ? "" : "s"}`);
  } catch (error) {
    if (error instanceof SetupDiscoveryHttpError && (error.status === 401 || error.status === 403)) {
      const warning = `${provider.displayName} rejected the API key (HTTP ${error.status}). Check the key and try again.`;
      ctx.warnings.push(warning);
      status?.stop(`${provider.displayName} API key rejected`, "error");
      ctx.prompter.note(warning);
      return { models: [], authenticationRejected: true };
    }
    const warning = `${provider.displayName} model discovery was unavailable: ${error instanceof Error ? error.message : String(error)}`;
    ctx.warnings.push(warning);
    status?.stop(`Could not load ${provider.displayName} models`, "error");
    if (!status) ctx.prompter.note(warning);
  }
  return { models: await chooseModels(ctx, provider.displayName, discovered, manualDefault), authenticationRejected: false };
}

async function configureApiProvider(ctx: WizardContext, config: StrongCodeConfig, providerId: string, override?: ProviderConfig, manualDefault = "", primary = false): Promise<StrongCodeConfig> {
  const provider = override ?? requiredProvider(config, providerId);
  const auth = await resolveApiKey(ctx, providerId, provider);
  if (!auth.configured) return config;
  const result = await configuredModels(ctx, providerId, provider, auth.apiKey, manualDefault);
  if (result.authenticationRejected) {
    if (auth.source === "existing") await ctx.authStore.remove(providerId);
    return config;
  }
  if (result.models.length === 0) return config;
  if (auth.source === "entered") {
    await ctx.authStore.set(providerId, {
      type: "api",
      key: auth.apiKey,
      metadata: {
        providerType: provider.type,
        ...(provider.baseUrl ? { origin: provider.baseUrl } : {})
      }
    });
  }
  return mergeConfiguredProvider(config, providerId, provider, result.models, {
    replaceExistingModels: primary,
    selectAsDefault: primary
  });
}

function withProviderEnabled(config: StrongCodeConfig, providerId: string, enabled: boolean): StrongCodeConfig {
  const provider = config.providers[providerId];
  if (!provider || provider.enabled === enabled) return config;
  return {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: { ...provider, enabled }
    }
  };
}

async function configureChatGpt(
  ctx: WizardContext,
  config: StrongCodeConfig,
  method: "browser" | "device-code" | "existing"
): Promise<StrongCodeConfig> {
  if (method !== "existing") {
    ctx.prompter.note(method === "browser" ? "Opening ChatGPT in your browser." : "Starting ChatGPT device login.");
    try {
      const loginOptions: ChatGptOAuthOptions = {
        onPrompt: prompt => {
          ctx.prompter.note(prompt.instructions);
          if (prompt.userCode) ctx.prompter.note(`Code: ${prompt.userCode}`);
          ctx.prompter.note(prompt.url);
        }
      };
      await ctx.runChatGptLogin(method as ChatGptLoginMode, ctx.authStore, loginOptions);
    } catch (error) {
      ctx.prompter.note(`ChatGPT login could not start: ${error instanceof Error ? error.message : String(error)}`);
      if (await ctx.prompter.confirm("Use an OpenAI API key instead?", true)) {
        const configured = await configureApiProvider(ctx, config, "openai", requiredProvider(config, "openai"), "", true);
        return configured === config ? config : withProviderEnabled(configured, "chatgpt", false);
      }
      if (await ctx.prompter.confirm("Skip ChatGPT for now?", false)) return config;
      throw error;
    }
  }
  let models: SetupDiscoveredModel[] = [];
  const status = ctx.prompter.status?.("Finding ChatGPT models");
  try {
    models = (await ctx.listChatGptModels()).map(model => ({ id: model.id, displayName: model.displayName }));
    status?.stop(`${models.length} ChatGPT model${models.length === 1 ? "" : "s"}`);
  } catch (error) {
    const warning = `ChatGPT model discovery was unavailable: ${error instanceof Error ? error.message : String(error)}`;
    ctx.warnings.push(warning);
    status?.stop("Could not load ChatGPT models", "error");
    if (!status) ctx.prompter.note(warning);
  }
  const selected = await chooseModels(ctx, "ChatGPT", models, "chatgpt-default");
  if (selected.length === 0) return config;
  const auth = await ctx.authStore.get("chatgpt");
  if (auth?.type !== "oauth") throw new StrongCodeError("CONFIG_ERROR", "ChatGPT login completed without OAuth credentials");
  const configured = mergeConfiguredProvider(config, "chatgpt", {
    type: "chatgpt",
    displayName: "ChatGPT",
    apiKeyEnv: undefined,
    baseUrl: undefined,
    modelsEndpoint: undefined,
    allowUnauthenticated: undefined,
    enabled: true
  }, selected, { replaceExistingModels: true, selectAsDefault: true });
  return withProviderEnabled(configured, "openai", false);
}

async function configureOpenAi(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const existingChatGpt = await ctx.authStore.get("chatgpt");
  const existingOpenAi = await ctx.authStore.get("openai");
  const choices: SetupChoice[] = [];
  if (existingChatGpt?.type === "oauth") {
    choices.push({ value: "existing-chatgpt", label: "Saved ChatGPT login" });
  }
  choices.push(
    { value: "browser", label: "ChatGPT account", hint: "Browser login" },
    { value: "device-code", label: "ChatGPT headless", hint: "Device code" },
    { value: "api-key", label: "OpenAI API key" },
    { value: "skip", label: "Not now" }
  );
  const initial = existingChatGpt?.type === "oauth"
    ? "existing-chatgpt"
    : existingOpenAi?.type === "api" ? "api-key" : "browser";
  const method = await ctx.prompter.select("OpenAI / ChatGPT", choices, initial);
  if (method === "skip") return config;
  if (method === "api-key") {
    const configured = await configureApiProvider(ctx, config, "openai", requiredProvider(config, "openai"), "", true);
    return configured === config ? config : withProviderEnabled(configured, "chatgpt", false);
  }
  return configureChatGpt(ctx, config, method === "existing-chatgpt" ? "existing" : method as "browser" | "device-code");
}

async function configureKimi(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const region = await ctx.prompter.select("Kimi", [
    { value: "kimi", label: "International", hint: "Moonshot" },
    { value: "moonshot-cn", label: "China" },
    { value: "kimi-code", label: "Kimi Code" }
  ], "kimi");
  const base = requiredProvider(config, "kimi");
  if (region === "kimi") return configureApiProvider(ctx, config, "kimi", base, "", true);
  const provider = withProviderDetails(base, region === "moonshot-cn" ? {
    displayName: "Moonshot China",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1"
  } : {
    displayName: "Kimi Code",
    apiKeyEnv: "KIMI_API_KEY",
    baseUrl: "https://api.kimi.com/coding/v1"
  });
  return configureApiProvider(ctx, config, region, provider, region === "kimi-code" ? "kimi-for-coding" : "", true);
}

async function configureGoogle(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const method = await ctx.prompter.select("Google", [
    { value: "api-key", label: "Gemini API key" },
    { value: "adc-browser", label: "Cloud login", hint: "Vertex AI" },
    { value: "adc-headless", label: "Headless cloud login", hint: "Vertex AI" },
    { value: "skip", label: "Not now" }
  ], "api-key");
  if (method === "skip") return config;
  if (method === "api-key") return configureApiProvider(ctx, config, "google", requiredProvider(config, "google"), "", true);

  ctx.prompter.note("Opening the official Google Cloud login.");
  try {
    await ctx.runGoogleAdcLogin(method === "adc-headless" ? "headless" : "browser");
  } catch (error) {
    ctx.prompter.note(`Google Cloud login could not start: ${error instanceof Error ? error.message : String(error)}`);
    if (await ctx.prompter.confirm("Skip Google Cloud for now and continue setup?", true)) return config;
    throw error;
  }
  const projectId = await ctx.prompter.text("Google Cloud project ID", {
    placeholder: "my-project",
    validate: value => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : "Use a valid Google Cloud project ID."
  });
  const location = await ctx.prompter.text("Vertex AI location", {
    initialValue: "us-central1",
    validate: value => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : "Use a valid Google Cloud location."
  });
  const modelId = await ctx.prompter.text("Vertex AI model ID", {
    placeholder: "gemini-model-id",
    validate: value => value.trim() ? undefined : "Enter a model ID."
  });
  const provider: ProviderConfig = {
    type: "google-vertex",
    displayName: "Google Vertex AI (ADC)",
    baseUrl: `https://${location}-aiplatform.googleapis.com`,
    projectId,
    location,
    enabled: true
  };
  await ctx.authStore.set("google-vertex", { type: "delegated", provider: "gcloud", metadata: { projectId, location } });
  return mergeConfiguredProvider(config, "google-vertex", provider, [{ id: modelId, displayName: modelId }], {
    replaceExistingModels: true,
    selectAsDefault: true
  });
}

async function configureZhipu(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const region = await ctx.prompter.select("GLM", [
    { value: "zhipu", label: "International", hint: "Z.AI" },
    { value: "zhipu-cn", label: "China", hint: "BigModel" }
  ], "zhipu");
  const base = requiredProvider(config, "zhipu");
  if (region === "zhipu") return configureApiProvider(ctx, config, "zhipu", base, "", true);
  return configureApiProvider(ctx, config, "zhipu-cn", withProviderDetails(base, {
    displayName: "BigModel / GLM China",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4"
  }), "", true);
}

async function configureCustom(ctx: WizardContext, config: StrongCodeConfig, suggestedId?: string, selectAsDefault = false): Promise<StrongCodeConfig> {
  const protocol = await ctx.prompter.select("Protocol", [
    { value: "openai-compatible", label: "OpenAI-compatible", hint: "recommended" },
    { value: "anthropic", label: "Anthropic-compatible" },
    { value: "google", label: "Gemini-native" }
  ], "openai-compatible");
  const reservedProviderIds = new Set([...Object.keys(providerDefaults()), ...Object.keys(config.providers)]);
  const displayName = await ctx.prompter.text("Name", {
    initialValue: suggestedId ? titleFromId(suggestedId) : undefined,
    placeholder: "My provider",
    validate: validateProviderName
  });
  const providerId = customProviderId(displayName, suggestedId, reservedProviderIds);
  const baseUrl = await ctx.prompter.text("Base URL", { placeholder: "https://example.com/v1", validate: validateBaseUrl });
  const apiKey = await ctx.prompter.secret("API key", { optional: true });
  const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parseProviderBaseUrl(baseUrl, "custom setup").hostname);
  const apiKeyEnv = `${providerId.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
  const environmentApiKey = process.env[apiKeyEnv] ?? "";
  if (!apiKey && !isLocal && !environmentApiKey) {
    ctx.prompter.note("A remote endpoint needs an API key.");
    return config;
  }
  const provider: ProviderConfig = {
    type: protocol,
    displayName,
    apiKeyEnv: apiKey || !isLocal ? apiKeyEnv : undefined,
    baseUrl,
    modelsEndpoint: "/models",
    allowUnauthenticated: !apiKey && isLocal ? true : undefined,
    enabled: true
  };
  const result = await configuredModels(ctx, providerId, provider, apiKey || environmentApiKey);
  if (result.authenticationRejected || result.models.length === 0) return config;
  if (apiKey) {
    await ctx.authStore.set(providerId, {
      type: "api",
      key: apiKey,
      metadata: { providerType: protocol, origin: baseUrl }
    });
  }
  return mergeConfiguredProvider(config, providerId, provider, result.models, { selectAsDefault });
}

async function configureLocal(ctx: WizardContext, config: StrongCodeConfig, gemmaOnly = false, selectAsDefault = false): Promise<StrongCodeConfig> {
  const status = ctx.prompter.status?.("Finding local models");
  const found = await ctx.scanLocalProviders(ctx.discovery);
  if (found.length === 0) {
    status?.stop("No local model server found", "error");
    if (!status) ctx.prompter.note("No local model server found.");
    return configureCustom(ctx, config, gemmaOnly ? "local-gemma" : "local-models", selectAsDefault);
  }
  status?.stop(`${found.length} local server${found.length === 1 ? "" : "s"}`);
  const providerId = await ctx.prompter.select("Local server", found.map(provider => ({
    value: provider.id,
    label: provider.label,
    hint: `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`
  })), found[0]!.id);
  const selectedProvider = found.find(provider => provider.id === providerId)!;
  const candidates = gemmaOnly ? selectedProvider.models.filter(model => /gemma[-_ ]?4/i.test(model.id)) : selectedProvider.models;
  const models = await chooseModels(ctx, selectedProvider.label, candidates, gemmaOnly ? "gemma-4-31b-it" : "");
  if (models.length === 0) return config;
  const registered = config.providers[providerId] ?? providerDefaults()[providerId];
  const provider: ProviderConfig = registered ? withProviderDetails(registered, {
    baseUrl: selectedProvider.baseUrl,
    modelsEndpoint: selectedProvider.modelsEndpoint,
    allowUnauthenticated: true,
    enabled: true
  }) : {
    type: "openai-compatible",
    displayName: selectedProvider.label,
    apiKeyEnv: undefined,
    baseUrl: selectedProvider.baseUrl,
    modelsEndpoint: selectedProvider.modelsEndpoint,
    allowUnauthenticated: true,
    enabled: true
  };
  return mergeConfiguredProvider(config, providerId, provider, models, {
    replaceExistingModels: selectAsDefault,
    selectAsDefault
  });
}

async function configureCuratedModelFamily(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const providerId = await ctx.prompter.select("Provider", [...CURATED_MODEL_FAMILIES], "openai");
  return configureProvider(ctx, config, providerId);
}

async function configureProvider(ctx: WizardContext, config: StrongCodeConfig, providerId: string): Promise<StrongCodeConfig> {
  if (providerId === "chatgpt" || providerId === "openai") return configureOpenAi(ctx, config);
  if (providerId === "kimi") return configureKimi(ctx, config);
  if (providerId === "zhipu") return configureZhipu(ctx, config);
  if (providerId === "google") return configureGoogle(ctx, config);
  if (providerId === "custom") return configureCustom(ctx, config, undefined, true);
  if (providerId === "catalog") return configureCuratedModelFamily(ctx, config);
  if (providerId === "local") return configureLocal(ctx, config, false, true);
  if (providerId === "cursor") {
    ctx.prompter.note("Cursor tokens cannot be imported safely.");
    return await ctx.prompter.confirm("Connect its model provider instead?", true)
      ? configureCustom(ctx, config, "cursor-provider", true)
      : config;
  }
  return configureApiProvider(ctx, config, providerId, requiredProvider(config, providerId), providerId === "deepseek" ? "deepseek-chat" : "", true);
}

function deepSeekConfigured(config: StrongCodeConfig): boolean {
  return Object.values(config.models).some(model =>
    model.enabled !== false
      && config.providers[model.provider]?.enabled !== false
      && /(?:^|[/:-])deepseek(?:[-_:/]|$)/i.test(model.model ?? "")
  );
}

function gemmaConfigured(config: StrongCodeConfig): boolean {
  return Object.values(config.models).some(model =>
    model.enabled !== false
      && config.providers[model.provider]?.enabled !== false
      && /(?:^|[/:-])gemma[-_ ]?4(?:[-_:/.]|$)/i.test(model.model ?? "")
  );
}

async function configureGemma(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const source = await ctx.prompter.select("Gemma 4", [
    { value: "google", label: "Google API" },
    { value: "local", label: "Local", hint: "Ollama · LM Studio · vLLM" },
    { value: "custom", label: "Custom" }
  ], "google");
  if (source === "local") return configureLocal(ctx, config, true);
  if (source === "custom") return configureCustom(ctx, config, "gemma-provider");

  const provider = requiredProvider(config, "google");
  const auth = await resolveApiKey(ctx, "google", provider);
  if (!auth.configured) return config;
  let candidates: SetupDiscoveredModel[] = [];
  const status = ctx.prompter.status?.("Finding Gemma 4 models");
  try {
    candidates = (await discoverModelsForSetup(provider, auth.apiKey, ctx.discovery)).filter(model => /gemma[-_ ]?4/i.test(model.id));
    status?.stop(`${candidates.length} Gemma 4 model${candidates.length === 1 ? "" : "s"}`);
  } catch (error) {
    if (error instanceof SetupDiscoveryHttpError && (error.status === 401 || error.status === 403)) {
      const warning = `Google rejected the API key (HTTP ${error.status}). Check the key and try again.`;
      ctx.warnings.push(warning);
      status?.stop("Google API key rejected", "error");
      ctx.prompter.note(warning);
      if (auth.source === "existing") await ctx.authStore.remove("google");
      return config;
    }
    const warning = `Gemma 4 discovery was unavailable: ${error instanceof Error ? error.message : String(error)}`;
    ctx.warnings.push(warning);
    status?.stop("Could not load Gemma 4 models", "error");
    if (!status) ctx.prompter.note(warning);
  }
  const models = await chooseModels(ctx, "Gemma 4", candidates, "gemma-4-31b-it");
  if (models.length === 0) return config;
  if (auth.source === "entered") {
    await ctx.authStore.set("google", {
      type: "api",
      key: auth.apiKey,
      metadata: {
        providerType: provider.type,
        ...(provider.baseUrl ? { origin: provider.baseUrl } : {})
      }
    });
  }
  return mergeConfiguredProvider(config, "google", provider, models);
}

async function configureAuxiliaryModels(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  let next = config;
  let hasDeepSeek = deepSeekConfigured(next);
  let hasGemma = gemmaConfigured(next);
  if (!hasDeepSeek && await ctx.prompter.confirm("Add DeepSeek for auxiliary tasks?", false)) {
    next = await configureApiProvider(ctx, next, "deepseek", requiredProvider(next, "deepseek"), "deepseek-chat");
    hasDeepSeek = deepSeekConfigured(next);
  }
  if (!hasGemma && await ctx.prompter.confirm(`${hasDeepSeek ? "DeepSeek is configured. " : ""}Add Gemma 4 too?`, false)) {
    next = await configureGemma(ctx, next);
  }
  return next;
}

async function chooseVoiceToText(ctx: WizardContext, state: SetupState): Promise<VoiceToTextChoice> {
  const choice = await ctx.prompter.select("Voice-to-text prompts?", [
    { value: "yes", label: "Yes", hint: "optimize AGENTS.md" },
    { value: "no", label: "No" },
    { value: "maybe", label: "Maybe later" }
  ], state.voiceToText);
  return choice as VoiceToTextChoice;
}

function setupProviderChoices(config: StrongCodeConfig): { choices: SetupChoice[]; initialValues: string[] } {
  const fixedValues = new Set<string>(PROVIDER_CHOICES.map(choice => choice.value));
  const currentProviders = configuredProviderIds(config);
  const extras = currentProviders
    .filter(providerId => providerId !== "chatgpt" && !fixedValues.has(providerId))
    .map(providerId => ({
      value: `existing:${providerId}`,
      label: config.providers[providerId]?.displayName ?? providerId,
      hint: providerId
    }));
  const initialValues = [...new Set(currentProviders.map(providerId => {
    if (providerId === "chatgpt") return "openai";
    return fixedValues.has(providerId) ? providerId : `existing:${providerId}`;
  }))];
  return {
    choices: [...PROVIDER_CHOICES, ...extras],
    initialValues: initialValues.length > 0 ? initialValues : ["openai"]
  };
}

function keptProviderIds(config: StrongCodeConfig, selected: string[]): string[] {
  return selected.flatMap(value => {
    if (value.startsWith("existing:")) return [value.slice("existing:".length)];
    if (value === "openai") return ["openai", "chatgpt"].filter(providerId => Boolean(config.providers[providerId]));
    return config.providers[value] ? [value] : [];
  });
}

async function chooseGlobalDefaultModel(ctx: WizardContext, config: StrongCodeConfig): Promise<StrongCodeConfig> {
  const candidates = Object.entries(config.models).filter(([, model]) =>
    model.provider !== "mock"
      && model.enabled !== false
      && config.providers[model.provider]?.enabled !== false
  );
  if (candidates.length === 0) {
    return {
      ...config,
      agents: {
        ...config.agents,
        [config.defaultAgent]: { ...config.agents[config.defaultAgent], model: "mock" }
      }
    };
  }
  const providerIds = new Set(candidates.map(([, model]) => model.provider));
  const currentModel = config.agents[config.defaultAgent]?.model;
  let modelKey = candidates.some(([key]) => key === currentModel) ? currentModel : candidates[0]![0];
  if (providerIds.size > 1) {
    modelKey = await ctx.prompter.select("Default model", candidates.map(([key, model]) => ({
      value: key,
      label: model.displayName ?? model.model ?? key,
      hint: config.providers[model.provider]?.displayName ?? model.provider
    })), modelKey);
  }
  return {
    ...config,
    agents: {
      ...config.agents,
      [config.defaultAgent]: { ...config.agents[config.defaultAgent], model: modelKey }
    }
  };
}

async function restoreAuthSnapshot(store: ProviderAuthStore, snapshot: Record<string, ProviderAuth>): Promise<void> {
  const current = await store.all();
  for (const providerId of Object.keys(current)) {
    if (!snapshot[providerId]) await store.remove(providerId);
  }
  for (const [providerId, auth] of Object.entries(snapshot)) await store.set(providerId, auth);
}

export async function runSetup(options: RunSetupOptions = {}, dependencies: SetupWizardDependencies = {}): Promise<SetupResult> {
  const homePath = path.resolve(dependencies.homePath ?? resolveStrongCodeHome());
  await ensureStrongCodeHome({ homePath });
  const state = await loadSetupState(homePath);
  const prompter = dependencies.prompter ?? new TerminalSetupPrompter();
  if (state.completed && !options.force && await setupRuntimeIsRunnable(homePath, state)) {
    prompter.outro("StrongCode harness is ready.");
    prompter.close();
    return { status: "already-complete", state, warnings: [] };
  }

  const ctx: WizardContext = {
    homePath,
    prompter,
    authStore: dependencies.authStore ?? new ProviderAuthStore(homePath),
    discovery: dependencies.discovery ?? {},
    warnings: [],
    runChatGptLogin: dependencies.runChatGptLogin ?? runChatGptLogin,
    listChatGptModels: dependencies.listChatGptModels ?? listChatGptModels,
    scanLocalProviders: dependencies.scanLocalProviders ?? scanLocalProviders,
    runGoogleAdcLogin: dependencies.runGoogleAdcLogin ?? runGoogleAdcLogin
  };
  let authSnapshot: Record<string, ProviderAuth> = {};
  let completed = false;

  try {
    authSnapshot = await ctx.authStore.all();
    prompter.intro("MODEL SETUP");
    let config = await loadSetupConfig(homePath);
    const providerSelection = setupProviderChoices(config);
    const selected = await prompter.multiselect("Providers", providerSelection.choices, providerSelection.initialValues);
    let mockOnlyConfirmed = false;
    if (selected.length === 0) {
      mockOnlyConfirmed = await prompter.confirm("Continue with the mock model only?", false);
      if (!mockOnlyConfirmed) throw new SetupCancelledError();
    }
    config = disableProvidersExcept(config, keptProviderIds(config, selected));
    for (const providerId of selected) {
      if (!providerId.startsWith("existing:")) config = await configureProvider(ctx, config, providerId);
    }
    if (configuredProviderIds(config).length === 0 && !mockOnlyConfirmed) {
      if (!await prompter.confirm("No provider is ready. Use the mock model?", false)) {
        throw new SetupCancelledError();
      }
      mockOnlyConfirmed = true;
    }
    config = await chooseGlobalDefaultModel(ctx, config);
    config = await configureAuxiliaryModels(ctx, config);
    const voiceToText = await chooseVoiceToText(ctx, state);
    await applyVoiceToTextInstructions(path.join(homePath, "AGENTS.md"), voiceToText);
    config = await saveSetupConfig(homePath, config);
    const completedState = await updateSetupState(homePath, () => ({
      completed: true,
      completedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      selectedProviders: configuredProviderIds(config),
      deepSeekConfigured: deepSeekConfigured(config),
      gemmaConfigured: gemmaConfigured(config),
      mockOnlyConfirmed: config.models[config.agents[config.defaultAgent]?.model]?.provider === "mock" && mockOnlyConfirmed,
      voiceToText
    }));
    completed = true;
    const shouldOfferBlender = !state.completed
      && !completedState.blender
      && (completedState.blenderOfferVersion ?? 0) < BLENDER_OFFER_VERSION
      && (dependencies.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true));
    const finalState = shouldOfferBlender
      ? await mergeBlenderSetupResult(homePath, await setupBlenderIntegration({
        homePath,
        workspace: path.resolve(dependencies.workspace ?? process.cwd()),
        state: completedState,
        prompter,
        mode: "automatic"
      }, { ...dependencies.blender, now: dependencies.blender?.now ?? dependencies.now }))
      : completedState;
    if (ctx.warnings.length) prompter.note(`${ctx.warnings.length} warning${ctx.warnings.length === 1 ? "" : "s"} · rerun with strongcode setup --force`);
    prompter.outro("StrongCode harness is ready.");
    return { status: "completed", state: finalState, config, warnings: ctx.warnings };
  } catch (error) {
    if (!completed) {
      try {
        await restoreAuthSnapshot(ctx.authStore, authSnapshot);
      } catch (restoreError) {
        ctx.warnings.push(`Could not fully roll back staged credentials: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    if (error instanceof SetupCancelledError) {
      prompter.note("Setup cancelled · run strongcode setup to continue");
      return { status: "cancelled", state: state ?? emptySetupState(), warnings: ctx.warnings };
    }
    if (completed) {
      throw new StrongCodeError("CONFIG_ERROR", `Core setup completed, but Blender integration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  } finally {
    prompter.close();
  }
}

async function setupRuntimeIsRunnable(homePath: string, state: SetupState): Promise<boolean> {
  const loaded = await loadConfig(globalConfigPath(homePath), { strongCodeHome: globalConfigPath(homePath) });
  if (!loaded.ok) return false;
  const config = loaded.value.config;
  const agent = config.agents[config.defaultAgent];
  const model = agent ? config.models[agent.model] : undefined;
  const provider = model ? config.providers[model.provider] : undefined;
  if (!agent || !model || model.enabled === false || !provider || provider.enabled === false) return false;
  if (model.provider === "mock") return state.mockOnlyConfirmed === true;
  const authStore = new ProviderAuthStore(homePath);
  if (provider.type === "chatgpt" || provider.type === "codex-cli" || provider.type === "google-vertex") {
    const auth = await authStore.get(model.provider);
    if (provider.type === "chatgpt") return auth?.type === "oauth" && Boolean(auth.access);
    if (provider.type === "codex-cli") return false;
    return auth?.type === "delegated" && auth.provider === "gcloud";
  }
  try {
    await resolveProviderCredentials(model.provider, provider, { authStore, allowEnvironmentCredentials: true });
    return true;
  } catch {
    return false;
  }
}

export async function shouldRunFirstSetup(homePath = resolveStrongCodeHome()): Promise<boolean> {
  const state = await loadSetupState(homePath);
  if (!state.completed) return true;
  return !await setupRuntimeIsRunnable(homePath, state);
}
