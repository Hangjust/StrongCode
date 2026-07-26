import { promptCacheKey } from "../src/models/prompt-cache";

describe("provider prompt cache keys", () => {
  it("creates stable bounded keys without normalization collisions", () => {
    const slashKey = promptCacheKey("session/one");
    const dashKey = promptCacheKey("session-one");

    expect(slashKey).toMatch(/^strongcode-[a-f0-9]{53}$/);
    expect(slashKey).toHaveLength(64);
    expect(promptCacheKey("session/one")).toBe(slashKey);
    expect(dashKey).not.toBe(slashKey);
  });
});
