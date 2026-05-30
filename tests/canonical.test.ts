import { describe, expect, it } from "vitest";
import { canonicalClone } from "../src/util/canonical.js";

describe("canonical boundary", () => {
  it("sorts plain object keys", () => {
    expect(canonicalClone({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
  });

  it.each([NaN, Infinity, -Infinity, undefined, () => 1, Promise.resolve(1), new Date(), /x/])("rejects non-canonical values", (value) => {
    expect(() => canonicalClone(value)).toThrow();
  });
});
