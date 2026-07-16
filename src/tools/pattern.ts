import { z } from "zod";

export const toolPatternSchema = z.string()
  .min(1)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u, "Tool patterns must not contain whitespace or ASCII control characters");
