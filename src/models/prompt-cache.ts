import { createHash } from "node:crypto";

const PROMPT_CACHE_KEY_LENGTH = 64;
const PROMPT_CACHE_KEY_PREFIX = "strongcode-";

export function promptCacheKey(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return `${PROMPT_CACHE_KEY_PREFIX}${digest.slice(0, PROMPT_CACHE_KEY_LENGTH - PROMPT_CACHE_KEY_PREFIX.length)}`;
}
