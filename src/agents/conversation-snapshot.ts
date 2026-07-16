import { StrongCodeError } from "../core/errors";
import { validateConversationItems, type ConversationItem } from "../core/types";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function invalidJsonInput(detail: string): StrongCodeError {
  return new StrongCodeError("VALIDATION_ERROR", `Tool input must be JSON-compatible: ${detail}`);
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidJsonInput("numbers must be finite");
    return value;
  }
  if (typeof value !== "object") throw invalidJsonInput(`${typeof value} values are not supported`);
  if (ancestors.has(value)) throw invalidJsonInput("cyclic values are not supported");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(entry => cloneJsonValue(entry, ancestors)));
    }
    if (!isPlainRecord(value)) throw invalidJsonInput("objects must use a plain prototype");
    if (Object.getOwnPropertySymbols(value).length > 0) throw invalidJsonInput("symbol keys are not supported");
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      throw invalidJsonInput("non-enumerable properties are not supported");
    }
    const clone: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw invalidJsonInput("accessor properties are not supported");
      }
      Object.defineProperty(clone, key, {
        value: cloneJsonValue(value[key], ancestors),
        enumerable: true,
        configurable: false,
        writable: false
      });
    }
    return Object.freeze(clone);
  } finally {
    ancestors.delete(value);
  }
}

export function immutableConversationItems(items: readonly ConversationItem[]): readonly ConversationItem[] {
  const validated = validateConversationItems(items);
  return Object.freeze(validated.map(item => {
    switch (item.type) {
      case "text":
        return Object.freeze({ ...item });
      case "tool_call":
        return Object.freeze({ ...item, input: cloneJsonValue(item.input, new Set()) });
      case "tool_result":
        return Object.freeze({ ...item });
      default: {
        const exhaustiveItem: never = item;
        return exhaustiveItem;
      }
    }
  }));
}
