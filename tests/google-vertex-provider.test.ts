import { createModelProvider } from "../src/models/factory";

vi.mock("../src/models/gcloud-delegated", () => ({
  getGoogleAdcAccessToken: vi.fn(async () => "vertex-access-token")
}));

describe("Google Vertex provider", () => {
  it("sends StrongCode tool declarations in generateContent requests", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createModelProvider({
      providerId: "google-vertex",
      providerConfig: {
        type: "google-vertex",
        displayName: "Google Vertex AI",
        baseUrl: "https://europe-west4-aiplatform.googleapis.com",
        enabled: true,
        projectId: "example-project",
        location: "europe-west4"
      },
      modelId: "gemini-test",
      modelConfig: {
        provider: "google-vertex",
        model: "gemini-test",
        displayName: "Gemini Test",
        enabled: true,
        source: "configured"
      },
      fetcher: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ candidates: [{ content: { parts: [{ text: "Vertex response" }] } }] });
          }
        };
      }
    });

    await expect(provider.complete({
      prompt: "Inspect the workspace",
      sessionId: "vertex-test",
      messages: [],
      tools: ["list_files", "read_file"]
    })).resolves.toMatchObject({ message: "Vertex response" });

    expect(calls[0].url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/example-project/locations/europe-west4/publishers/google/models/gemini-test:generateContent");
    expect(calls[0].body).toMatchObject({
      tools: [{
        functionDeclarations: [
          { name: "list_files", parametersJsonSchema: { type: "OBJECT", properties: {} } },
          { name: "read_file", parametersJsonSchema: { type: "OBJECT", properties: {} } }
        ]
      }]
    });
    expect((calls[0].body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]
      .functionDeclarations.every(declaration => !("parameters" in declaration))).toBe(true);
  });
});
