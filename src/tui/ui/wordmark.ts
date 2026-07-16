export const STRONGCODE_WORDMARK = {
  left: [
    "                             ",
    "█▀▀▀ ▀█▀▀ █▀▀▄ █▀▀█ █▀▀▄ █▀▀▀",
    "▀▀▀█ _█__ █^^^ █__█ █__█ █_▀█",
    "▀▀▀▀ _▀__ ▀__▀ ▀▀▀▀ ▀__▀ ▀▀▀▀"
  ],
  right: [
    "             ▄     ",
    "█▀▀▀ █▀▀█ █▀▀▄ █▀▀▀",
    "█___ █__█ █__█ █▀▀_",
    "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"
  ]
} as const;

export const STRONGCODE_WORDMARK_GAP = 1;
export const STRONGCODE_WORDMARK_HEIGHT = STRONGCODE_WORDMARK.left.length;
export const STRONGCODE_WORDMARK_LEFT_WIDTH = STRONGCODE_WORDMARK.left[0].length;
export const STRONGCODE_WORDMARK_RIGHT_WIDTH = STRONGCODE_WORDMARK.right[0].length;
export const STRONGCODE_WORDMARK_WIDTH = STRONGCODE_WORDMARK_LEFT_WIDTH + STRONGCODE_WORDMARK_GAP + STRONGCODE_WORDMARK_RIGHT_WIDTH;
export const STRONGCODE_WORDMARK_MIN_VIEWPORT = STRONGCODE_WORDMARK_WIDTH + 4;

export function decodeWordmarkLine(line: string): string {
  return line
    .replaceAll("_", " ")
    .replaceAll("^", "▀")
    .replaceAll("~", "▀")
    .replaceAll(",", "▄");
}

export function strongCodeWordmarkRows(): string[] {
  return STRONGCODE_WORDMARK.left.map((left, index) => {
    const right = STRONGCODE_WORDMARK.right[index] ?? "";
    return `${decodeWordmarkLine(left)}${" ".repeat(STRONGCODE_WORDMARK_GAP)}${decodeWordmarkLine(right)}`;
  });
}
