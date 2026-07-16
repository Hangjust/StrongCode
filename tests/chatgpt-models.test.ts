import { builtInChatGptModels, listChatGptModels } from "../src/models/chatgpt-models";

describe("ChatGPT model discovery", () => {
  it("filters the public catalog to ChatGPT-supported current and future models", async () => {
    const models = await listChatGptModels({
      fetcher: async () => new Response(JSON.stringify({
        openai: {
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" },
            "gpt-5.6-codex": { id: "gpt-5.6-codex", name: "GPT-5.6 Codex" },
            "gpt-4.1": { id: "gpt-4.1", name: "Unsupported" },
            hostile: { id: "bad model\nname", name: "Bad" }
          }
        }
      }), { status: 200 })
    });

    expect(models.map(model => model.id)).toContain("gpt-5.5");
    expect(models.map(model => model.id)).toContain("gpt-5.6-codex");
    expect(models.map(model => model.id)).not.toContain("gpt-4.1");
    expect(models.map(model => model.id)).not.toContain("bad model\nname");
    expect(models[0]?.id).toBe("gpt-5.5");
  });

  it("uses a built-in model list when remote discovery is unavailable", async () => {
    const models = await listChatGptModels({ fetcher: async () => { throw new Error("offline"); } });
    expect(models).toEqual(builtInChatGptModels());
  });
});
