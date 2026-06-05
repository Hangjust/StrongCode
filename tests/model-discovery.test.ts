import { discoverOpenAICompatibleModels, DiscoveryFetcher } from "../src/models/discovery";

describe("model discovery", () => {
  it("discovers OpenAI-compatible model ids with an injected fetcher", async () => {
    const calls: string[] = [];
    const fetcher: DiscoveryFetcher = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "custom-a" }, { id: "custom-b" }] };
        }
      };
    };

    const result = await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      enabled: true,
      id: "custom"
    }, fetcher);

    expect(calls).toEqual(["https://example.com/v1/models"]);
    expect(result.map(model => model.id)).toEqual(["custom-a", "custom-b"]);
    expect(result[0].enabled).toBe(false);
  });

  it("sends authorization for model discovery when apiKeyEnv is configured", async () => {
    const originalApiKey = process.env.CUSTOM_PROVIDER_API_KEY;
    process.env.CUSTOM_PROVIDER_API_KEY = "discovery-key";

    try {
      const result = await discoverOpenAICompatibleModels({
        type: "openai-compatible",
        displayName: "Custom Provider",
        apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
        baseUrl: "https://example.com/v1",
        modelsEndpoint: "/models",
        id: "custom"
      }, async (_url, init) => {
        expect(init.headers).toEqual({ Authorization: "Bearer discovery-key" });
        return {
          ok: true,
          status: 200,
          async json() {
            return { data: [{ id: "custom-auth" }] };
          }
        };
      });

      expect(result[0].id).toBe("custom-auth");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.CUSTOM_PROVIDER_API_KEY;
      } else {
        process.env.CUSTOM_PROVIDER_API_KEY = originalApiKey;
      }
    }
  });

  it("rejects unsafe model endpoint values", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "http://localhost:11434/v1",
      modelsEndpoint: "//example.com/models",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("stay relative");

    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models?api_key=secret",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("query string");
  });

  it("rejects non-local http provider URLs", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      apiKeyEnv: "CUSTOM_PROVIDER_API_KEY",
      baseUrl: "http://example.com/v1",
      modelsEndpoint: "/models",
      enabled: true,
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    }))).rejects.toThrow("https");
  });

  it("allows localhost http provider URLs", async () => {
    const calls: string[] = [];

    await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Local Provider",
      baseUrl: "http://localhost:11434/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async url => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "local-model" }] };
        }
      };
    });

    expect(calls).toEqual(["http://localhost:11434/v1/models"]);
  });

  it("allows IPv6 localhost http provider URLs", async () => {
    const calls: string[] = [];

    await discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Local Provider",
      baseUrl: "http://[::1]:11434/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async url => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: [{ id: "local-model" }] };
        }
      };
    });

    expect(calls).toEqual(["http://[::1]:11434/v1/models"]);
  });

  it("rejects malformed discovery payloads", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async () => ({
      ok: true,
      status: 200,
      async json() {
        return { object: "list" };
      }
    }))).rejects.toThrow("data array");
  });

  it("reports HTTP discovery failures", async () => {
    await expect(discoverOpenAICompatibleModels({
      type: "openai-compatible",
      displayName: "Custom Provider",
      baseUrl: "https://example.com/v1",
      modelsEndpoint: "/models",
      id: "custom"
    }, async () => ({
      ok: false,
      status: 500,
      async json() {
        return {};
      }
    }))).rejects.toThrow("HTTP 500");
  });
});
