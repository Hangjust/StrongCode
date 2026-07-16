export function canonicalJsonString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonString).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonString(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
