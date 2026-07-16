import { describe, expect, it } from "vitest";
import { fastModeLabel, modelUiControls, reasoningLabel } from "../src/tui/ui/session-chrome";

describe("model UI controls", () => {
  it("fails closed when capability support metadata is absent", () => {
    const openai = modelUiControls({ reasoning: true, fastMode: true, serviceTier: "priority" }, "openai");
    const custom = modelUiControls({ reasoning: true, fastMode: true, serviceTier: "priority" }, "custom");

    for (const controls of [openai, custom]) {
      expect(controls.reasoningAvailable).toBe(false);
      expect(controls.reasoningEnabled).toBe(false);
      expect(controls.fastModeAvailable).toBe(false);
      expect(controls.fastMode).toBe(false);
      expect(reasoningLabel(controls)).toBe("🧠 Reasoning unavailable");
      expect(fastModeLabel(controls)).toBe("⚡ Fast unavailable");
    }
  });

  it("requires explicit support before enabled flags or priority can activate controls", () => {
    const unsupported = modelUiControls({
      supportsReasoning: false,
      supportsFastMode: false,
      reasoning: true,
      fastMode: true,
      serviceTier: "priority"
    });
    const supported = modelUiControls({
      capabilities: {
        supports_reasoning: true,
        supports_fast_mode: true,
        reasoning: true,
        serviceTier: "priority"
      }
    });

    expect(unsupported).toMatchObject({
      reasoningAvailable: false,
      reasoningEnabled: false,
      fastModeAvailable: false,
      fastMode: false
    });
    expect(supported).toMatchObject({
      reasoningAvailable: true,
      reasoningEnabled: true,
      fastModeAvailable: true,
      fastMode: true
    });
  });

  it("preserves explicit aliases, labels, efforts, and multiplier", () => {
    const controls = modelUiControls({
      supportsReasoning: false,
      supports_reasoning: true,
      supportsFastMode: false,
      supports_fast_mode: true,
      reasoningEnabled: false,
      reasoning: true,
      fastMode: false,
      fast_mode: true,
      reasoning_effort: "high",
      reasoning_efforts: ["low", "high"],
      fast_mode_multiplier: 2
    });

    expect(controls).toMatchObject({
      reasoningAvailable: false,
      reasoningEnabled: false,
      effort: "high",
      availableEfforts: ["low", "high"],
      fastModeAvailable: false,
      fastMode: false,
      fastModeMultiplier: 2
    });
    expect(reasoningLabel(controls)).toBe("🧠 Reasoning unavailable");
    expect(fastModeLabel(controls)).toBe("⚡ Fast unavailable");
  });
});
