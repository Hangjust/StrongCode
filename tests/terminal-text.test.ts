import { describe, expect, it } from "vitest";
import { sanitizeTerminalLine, sanitizeTerminalMultiline } from "../src/core/terminal-text";
import { sanitizeDisplayValue, sanitizeMultilineDisplayValue } from "../src/tui/render";
import { sanitizeChromeText } from "../src/tui/ui/session-chrome";

const SAFE_UNICODE = "עברית العربية e\u0301 👩‍💻 ✈️";
const BIDI_CONTROLS = [
  "\u061C",
  "\u200E",
  "\u200F",
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069"
] as const;

const OSC_CASES = [
  { name: "7-bit OSC terminated by BEL", input: "left\u001B]2;spoof\u0007right" },
  { name: "7-bit OSC terminated by ESC-ST", input: "left\u001B]2;spoof\u001B\\right" },
  { name: "7-bit OSC terminated by C1-ST", input: "left\u001B]2;spoof\u009Cright" },
  { name: "8-bit OSC terminated by BEL", input: "left\u009D2;spoof\u0007right" },
  { name: "8-bit OSC terminated by ESC-ST", input: "left\u009D2;spoof\u001B\\right" },
  { name: "8-bit OSC terminated by C1-ST", input: "left\u009D2;spoof\u009Cright" }
] as const;

const CONTROL_STRING_CASES = [
  { name: "DCS", sevenBit: "\u001BP", eightBit: "\u0090" },
  { name: "SOS", sevenBit: "\u001BX", eightBit: "\u0098" },
  { name: "PM", sevenBit: "\u001B^", eightBit: "\u009E" },
  { name: "APC", sevenBit: "\u001B_", eightBit: "\u009F" }
].flatMap(({ name, sevenBit, eightBit }) => [
  { name: `7-bit ${name} terminated by BEL`, input: `left${sevenBit}spoof\u0007right` },
  { name: `7-bit ${name} terminated by ESC-ST`, input: `left${sevenBit}spoof\u001B\\right` },
  { name: `7-bit ${name} terminated by C1-ST`, input: `left${sevenBit}spoof\u009Cright` },
  { name: `8-bit ${name} terminated by BEL`, input: `left${eightBit}spoof\u0007right` },
  { name: `8-bit ${name} terminated by ESC-ST`, input: `left${eightBit}spoof\u001B\\right` },
  { name: `8-bit ${name} terminated by C1-ST`, input: `left${eightBit}spoof\u009Cright` }
]);

const TRUNCATED_ESCAPE_CASES = [
  { name: "incomplete CSI", input: "left\u001B[31" },
  { name: "incomplete OSC", input: "left\u001B]2;spoof" },
  { name: "incomplete DCS", input: "left\u001BPspoof" },
  { name: "incomplete SOS", input: "left\u001BXspoof" },
  { name: "isolated ESC", input: "left\u001B" }
] as const;

describe("terminal text sanitization", () => {
  it.each(OSC_CASES)("removes $name", ({ input }) => {
    // Given
    const untrusted = input;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe("leftright");
  });

  it.each([
    { name: "7-bit CSI", input: "left\u001B[2Jright" },
    { name: "8-bit CSI", input: "left\u009B2Jright" }
  ])("removes $name", ({ input }) => {
    // Given
    const untrusted = input;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe("leftright");
  });

  it.each(CONTROL_STRING_CASES)("removes $name", ({ input }) => {
    // Given
    const untrusted = input;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe("leftright");
  });

  it.each([
    { name: "two-byte ESC", input: "left\u001Bcright" },
    { name: "numeric ESC final", input: "left\u001B7right" },
    { name: "ESC with an intermediate byte", input: "left\u001B(0right" }
  ])("removes $name", ({ input }) => {
    // Given
    const untrusted = input;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe("leftright");
  });

  it.each(TRUNCATED_ESCAPE_CASES)("removes the tail for $name", ({ input }) => {
    // Given
    const untrusted = input;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe("left");
  });

  it("removes BEL, C0, C1, and DEL control bytes", () => {
    // Given
    const controls = String.fromCharCode(
      ...Array.from({ length: 0x20 }, (_, code) => code),
      0x7f,
      ...Array.from({ length: 0x20 }, (_, offset) => 0x80 + offset)
    );

    // When
    const sanitized = sanitizeTerminalLine(controls);

    // Then
    expect(sanitized).toBe("");
  });

  it("removes required bidi controls and Unicode line separators", () => {
    // Given
    const untrusted = `${SAFE_UNICODE}${BIDI_CONTROLS.join("")}\u2028\u2029${SAFE_UNICODE}`;

    // When
    const sanitized = sanitizeTerminalLine(untrusted);

    // Then
    expect(sanitized).toBe(`${SAFE_UNICODE}${SAFE_UNICODE}`);
  });

  it("strips CR, LF, and tab in line mode while preserving them exactly in multiline mode", () => {
    // Given
    const untrusted = "first\r\nsecond\rthird\tcolumn";

    // When
    const singleLine = sanitizeTerminalLine(untrusted);
    const multiline = sanitizeTerminalMultiline(untrusted);

    // Then
    expect(singleLine).toBe("firstsecondthirdcolumn");
    expect(multiline).toBe(untrusted);
  });

  it("keeps existing TUI multiline normalization around the shared line sanitizer", () => {
    // Given
    const untrusted = "first\r\nsecond\rthird\tcolumn";

    // When
    const singleLine = sanitizeDisplayValue(untrusted);
    const multiline = sanitizeMultilineDisplayValue(untrusted);

    // Then
    expect(singleLine).toBe("firstsecondthirdcolumn");
    expect(multiline).toBe("first\nsecond\nthirdcolumn");
  });

  it("preserves safe Arabic, Hebrew, combining marks, and ZWJ text exactly", () => {
    // Given
    const trusted = SAFE_UNICODE;

    // When
    const singleLine = sanitizeTerminalLine(trusted);
    const multiline = sanitizeTerminalMultiline(trusted);

    // Then
    expect(singleLine).toBe(trusted);
    expect(multiline).toBe(trusted);
  });

  it("keeps sanitizeChromeText delegated to shared line mode", () => {
    // Given
    const untrusted = `safe\u009B2J${SAFE_UNICODE}`;

    // When
    const chromeText = sanitizeChromeText(untrusted);

    // Then
    expect(chromeText).toBe(sanitizeTerminalLine(untrusted));
  });

  it.each([...OSC_CASES, ...CONTROL_STRING_CASES, ...TRUNCATED_ESCAPE_CASES])(
    "is idempotent for $name",
    ({ input }) => {
      // Given
      const once = sanitizeTerminalLine(input);

      // When
      const twice = sanitizeTerminalLine(once);

      // Then
      expect(twice).toBe(once);
    }
  );
});
