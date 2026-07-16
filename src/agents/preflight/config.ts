import { z } from "zod";
import { toolPatternSchema } from "../../tools/pattern";
import { modelReferenceSchema } from "./text";

export const preflightModelRouteSchema = z.object({
  model: modelReferenceSchema,
  fallbackModels: z.array(modelReferenceSchema).max(16).readonly().default([]),
  tools: z.array(toolPatternSchema).max(128).readonly().optional()
}).strict().readonly();

export const preflightConfigSchema = z.object({
  enabled: z.boolean().default(true),
  summary: preflightModelRouteSchema,
  analysis: preflightModelRouteSchema.optional(),
  explorer: preflightModelRouteSchema.optional()
}).strict().readonly();

export type PreflightModelRoute = z.infer<typeof preflightModelRouteSchema>;
export type PreflightConfig = z.infer<typeof preflightConfigSchema>;
