import { orderedProviders, providerDefaults } from "../src/models/registry";

describe("provider registry", () => {
  it("orders preferred providers first", () => {
    const ordered = orderedProviders(providerDefaults()).map(provider => provider.id);

    expect(ordered.slice(0, 4)).toEqual(["openai", "kimi", "anthropic", "grok"]);
    expect(ordered).toContain("custom");
  });
});
