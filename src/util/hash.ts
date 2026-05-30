import { createHash } from "node:crypto";
import type { CanonicalValue } from "../types.js";
import { toCanonical } from "./canonical.js";

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableStringify(value: unknown): string {
  return stringifyCanonical(toCanonical(value));
}

function stringifyCanonical(value: CanonicalValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key] as CanonicalValue)}`).join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Bytes(stableStringify(value));
}
