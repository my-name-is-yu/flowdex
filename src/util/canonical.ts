import type { CanonicalValue } from "../types.js";

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

export function toCanonical(value: unknown, path = "$", seen = new WeakSet<object>()): CanonicalValue {
  if (value === null) return null;

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value as CanonicalValue;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalError(`${path}: non-finite number is not canonical JSON`);
    }
    return value as number;
  }

  if (kind === "undefined" || kind === "bigint" || kind === "symbol" || kind === "function") {
    throw new CanonicalError(`${path}: ${kind} is not canonical JSON`);
  }

  if (!value || kind !== "object") {
    throw new CanonicalError(`${path}: unsupported value`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    throw new CanonicalError(`${path}: cyclic value is not canonical JSON`);
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    return value.map((item, index) => toCanonical(item, `${path}[${index}]`, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalError(`${path}: prototype-bearing object is not canonical JSON`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, CanonicalValue> = Object.create(null);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (!descriptor || "get" in descriptor || "set" in descriptor) {
      throw new CanonicalError(`${path}.${key}: accessor property is not canonical JSON`);
    }
    result[key] = toCanonical(descriptor.value, `${path}.${key}`, seen);
  }
  return result;
}

export function assertCanonical(value: unknown, path = "$"): asserts value is CanonicalValue {
  toCanonical(value, path);
}

export function canonicalClone(value: unknown): CanonicalValue {
  return toCanonical(value);
}
