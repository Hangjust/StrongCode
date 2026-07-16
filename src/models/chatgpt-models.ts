import { readBoundedResponseText } from "./response-body";

export interface ChatGptModelInfo {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface ChatGptModelCatalogOptions {
  fetcher?: typeof fetch;
  catalogUrl?: string;
  timeoutMs?: number;
}

const BUILT_IN_CHATGPT_MODELS: ChatGptModelInfo[] = [
  { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
  { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: false },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", isDefault: false },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark", isDefault: false }
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function supportedModel(id: string): boolean {
  if (BUILT_IN_CHATGPT_MODELS.some(model => model.id === id)) return true;
  const match = id.match(/^gpt-(\d+\.\d+)(?:[-_.]|$)/i);
  return Boolean(match && Number.parseFloat(match[1]!) > 5.4);
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(text || fallback).slice(0, 160).join("");
}

function parseCatalog(value: unknown): ChatGptModelInfo[] {
  const root = record(value);
  const provider = record(root?.openai);
  const models = record(provider?.models);
  if (!models) return [];
  return Object.entries(models).flatMap(([key, raw]) => {
    const model = record(raw);
    const id = typeof model?.id === "string" ? model.id.trim() : key.trim();
    if (!id || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id) || !supportedModel(id)) return [];
    return [{ id, displayName: safeText(model?.name, id), isDefault: id === "gpt-5.5" }];
  }).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || right.id.localeCompare(left.id));
}

export async function listChatGptModels(options: ChatGptModelCatalogOptions = {}): Promise<ChatGptModelInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await (options.fetcher ?? fetch)(options.catalogUrl ?? "https://models.dev/api.json", {
      method: "GET",
      headers: { "User-Agent": "strongcode/0.1.0" },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) return [...BUILT_IN_CHATGPT_MODELS];
    const text = await readBoundedResponseText(response, {
      maxBytes: 5 * 1024 * 1024,
      tooLargeMessage: "ChatGPT model catalog exceeded 5 MB"
    });
    const discovered = parseCatalog(JSON.parse(text));
    if (discovered.length === 0) return [...BUILT_IN_CHATGPT_MODELS];
    const seen = new Set(discovered.map(model => model.id));
    return [...discovered, ...BUILT_IN_CHATGPT_MODELS.filter(model => !seen.has(model.id))];
  } catch {
    return [...BUILT_IN_CHATGPT_MODELS];
  } finally {
    clearTimeout(timeout);
  }
}

export function builtInChatGptModels(): ChatGptModelInfo[] {
  return BUILT_IN_CHATGPT_MODELS.map(model => ({ ...model }));
}
