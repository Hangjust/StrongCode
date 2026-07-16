export const PREFLIGHT_HOME_DOCUMENTATION = [
  "",
  "## Optional hidden preflight",
  "",
  "Setup adds `preflight` routes only when an enabled configured DeepSeek V4 Flash semantic match or, secondarily, a Gemma semantic match was actually discovered.",
  "If neither eligible model is configured, the routes remain unset. Every route may be replaced with any configured model key.",
  "Only the first meaningful prompt is summarized into a title, general summary, and source-ordered requested items; the exact original prompt is preserved for the primary.",
  "The host permits 0-25 optional depth-one analysis/explorer children, at most 25 concurrently, with a 90-second overall deadline, 30-second child deadline, and 5-second finalizer reserve.",
  "The hidden roles are advisory and receive only configured read/search/read-only-web tools.",
  "They cannot mutate files, run shell, invoke workers/tasks/spawn, delegate recursively, or call unclassified MCP tools.",
  "Failures are visibly failed-open; cancellation stops descendants and primary dispatch, and late results cannot revive orchestration.",
  "Telemetry distinguishes provider-reported usage from immutable configured metadata. Configured pricing can estimate spend only from a complete, unambiguous provider token split; missing values remain unavailable."
] as const;

const PREFLIGHT_ROUTE_JSON_SCHEMA = {
  type: "object",
  required: ["model"],
  properties: {
    model: { type: "string", minLength: 1 },
    fallbackModels: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
    tools: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 128 }
  },
  additionalProperties: false
} as const;

export const PREFLIGHT_JSON_SCHEMA = {
  type: "object",
  description: "Optional hidden preflight routes. Model values reference keys in models; role permissions remain host-owned.",
  required: ["summary"],
  properties: {
    enabled: { type: "boolean" },
    summary: PREFLIGHT_ROUTE_JSON_SCHEMA,
    analysis: PREFLIGHT_ROUTE_JSON_SCHEMA,
    explorer: PREFLIGHT_ROUTE_JSON_SCHEMA
  },
  additionalProperties: false
} as const;
