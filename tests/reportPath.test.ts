import { describe, expect, it } from "vitest";
import { readReportPath } from "../src/runtime/reportPath.js";

describe("report path extraction", () => {
  const report = {
    synthesis: {
      data: {
        concise_japanese_answer: "答え",
        ranked_root_causes: [{ cause: "unclear ownership" }]
      }
    }
  };

  it("reads nested object fields and array indices", () => {
    expect(readReportPath(report, "synthesis.data.concise_japanese_answer")).toBe("答え");
    expect(readReportPath(report, "synthesis.data.ranked_root_causes.0.cause")).toBe("unclear ownership");
  });

  it("fails on missing paths", () => {
    expect(() => readReportPath(report, "synthesis.data.missing")).toThrow(/not found/);
    expect(() => readReportPath(report, "synthesis.data.ranked_root_causes.first")).toThrow(/array index/);
  });
});
