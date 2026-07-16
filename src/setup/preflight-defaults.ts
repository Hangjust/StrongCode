import { resolvePreflightModel } from "../agents/preflight/routing";
import type { PreflightModelRoute } from "../agents/preflight/config";
import { modelReferenceSchema } from "../agents/preflight/text";
import type { StrongCodeConfig } from "../config/schema";
import { StrongCodeError } from "../core/errors";

const GENERATED_PREFLIGHT_TOOLS = [
  "list_files",
  "read_file",
  "find_files",
  "ripgrep",
  "web_search"
] as const;

function generatedRoute(model: string): PreflightModelRoute {
  return {
    model: modelReferenceSchema.parse(model),
    fallbackModels: [],
    tools: GENERATED_PREFLIGHT_TOOLS
  };
}

export function withGeneratedPreflightDefaults(config: StrongCodeConfig): StrongCodeConfig {
  if (config.preflight) return config;
  try {
    const model = resolvePreflightModel(config, "summary").modelId;
    return {
      ...config,
      preflight: {
        enabled: true,
        summary: generatedRoute(model),
        analysis: generatedRoute(model),
        explorer: generatedRoute(model)
      }
    };
  } catch (error) {
    if (error instanceof StrongCodeError && error.code === "MODEL_ERROR") return config;
    throw error;
  }
}
