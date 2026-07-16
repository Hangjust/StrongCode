import { discoverModelsForSetup, scanLocalProviders } from "../src/setup/discovery";

describe("setup model discovery", () => {
  it("cancels a streaming response as soon as it exceeds the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(discoverModelsForSetup({
      type: "openai-compatible",
      displayName: "Bounded Provider",
      baseUrl: "https://models.example.com/v1",
      modelsEndpoint: "/models",
      enabled: true
    }, "", {
      maxResponseBytes: 32,
      fetcher: async () => new Response(body, { status: 200 })
    })).rejects.toThrow("response is too large");

    expect(cancelled).toBe(true);
  });

  it("recognizes the key field returned by LM Studio's native model API", async () => {
    const found = await scanLocalProviders({
      fetcher: async url => {
        if (url === "http://127.0.0.1:1234/api/v1/models") {
          return new Response(JSON.stringify({
            models: [{ key: "publisher/lm-studio-model", display_name: "LM Studio Model" }]
          }), { status: 200 });
        }
        return new Response("unavailable", { status: 503 });
      }
    });

    expect(found).toEqual([expect.objectContaining({
      id: "lmstudio",
      models: [{ id: "publisher/lm-studio-model", displayName: "LM Studio Model" }]
    })]);
  });

  it("filters unsafe model IDs and sanitizes bounded display names", async () => {
    const longDisplayName = `Safe \u001b[31mname\n\u202e${"x".repeat(300)}`;
    const discovered = await discoverModelsForSetup({
      type: "openai-compatible",
      displayName: "Untrusted Catalog",
      baseUrl: "https://models.example.com/v1",
      modelsEndpoint: "/models",
      enabled: true
    }, "", {
      fetcher: async () => new Response(JSON.stringify({
        data: [
          { id: "safe-model", display_name: longDisplayName },
          { id: "bad\nmodel" },
          { id: "bad\u202emodel" },
          { id: "x".repeat(257) }
        ]
      }), { status: 200 })
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0].id).toBe("safe-model");
    expect(discovered[0].displayName).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u);
    expect(discovered[0].displayName).not.toContain("[31m");
    expect(Array.from(discovered[0].displayName)).toHaveLength(160);
  });
});
