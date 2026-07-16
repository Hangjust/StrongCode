const BEL = 0x07;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const ESC = 0x1b;
const DEL = 0x7f;
const DCS = 0x90;
const SOS = 0x98;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const PM = 0x9e;
const APC = 0x9f;

function consumeCsi(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) {
      index += 1;
      continue;
    }
    return value.length;
  }
  return value.length;
}

function consumeControlString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === BEL || code === ST) return index + 1;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return value.length;
}

function consumeEscape(value: string, start: number): number {
  const next = value.charCodeAt(start + 1);
  if (next === 0x5b) return consumeCsi(value, start + 2);
  if (next === 0x50 || next === 0x58 || next === 0x5d || next === 0x5e || next === 0x5f) {
    return consumeControlString(value, start + 2);
  }

  let index = start + 1;
  while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2f) {
    index += 1;
  }
  const final = value.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : value.length;
}

function isControlStringIntroducer(code: number): boolean {
  return code === DCS || code === SOS || code === OSC || code === PM || code === APC;
}

function isBidiSpoofingControl(code: number): boolean {
  return code === 0x061c
    || code === 0x200e
    || code === 0x200f
    || code === 0x2028
    || code === 0x2029
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
}

function sanitizeTerminalText(value: string, preserveMultilineControls: boolean): string {
  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === ESC) {
      index = consumeEscape(value, index);
      continue;
    }
    if (code === CSI) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (isControlStringIntroducer(code)) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (code <= 0x1f || (code >= DEL && code <= APC)) {
      if (preserveMultilineControls && (code === TAB || code === LF || code === CR)) {
        output.push(value[index]);
      }
      index += 1;
      continue;
    }
    if (!isBidiSpoofingControl(code)) output.push(value[index]);
    index += 1;
  }
  return output.join("");
}

export function sanitizeTerminalLine(value: string): string {
  return sanitizeTerminalText(value, false);
}

export function sanitizeTerminalMultiline(value: string): string {
  return sanitizeTerminalText(value, true);
}
