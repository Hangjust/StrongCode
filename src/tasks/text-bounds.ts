export const TASK_ERROR_MESSAGE_MAX_UNITS = 4_096;

export function boundTaskText(value: string, maxUnits: number): string {
  let bounded = "";
  for (const character of value) {
    if (bounded.length + character.length > maxUnits) break;
    bounded += character;
  }
  return bounded;
}
