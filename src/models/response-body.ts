import { StrongCodeError } from "../core/errors";

export const MAX_COMPLETION_RESPONSE_BYTES = 10 * 1024 * 1024;

export class BoundedResponseBodyError extends StrongCodeError {
  constructor(message: string) {
    super("MODEL_ERROR", message);
    this.name = "BoundedResponseBodyError";
  }
}

export interface ProviderResponseBody {
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface BoundedResponseBodyOptions {
  maxBytes?: number;
  tooLargeMessage?: string;
}

/**
 * Read an HTTP body without allowing a streaming response to grow without bound.
 * The text-only fallback keeps injected/mock transports source-compatible.
 */
export async function readBoundedResponseText(
  response: ProviderResponseBody,
  options: BoundedResponseBodyOptions = {}
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_COMPLETION_RESPONSE_BYTES;
  const tooLargeMessage = options.tooLargeMessage ?? "Model completion response exceeded 10 MB";
  const declaredBytes = Number.parseInt(response.headers?.get("content-length") ?? "0", 10);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new BoundedResponseBodyError(tooLargeMessage);
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new BoundedResponseBodyError(tooLargeMessage);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedResponseBodyError(tooLargeMessage);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
