import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowSource } from "../src/policy/manifest.js";
import { templateFor } from "../src/runtime/templates.js";

describe("Flowdex templates and skill contract", () => {
  it.each(["code-audit", "parallel-review", "implementation-fanout"])("previews init template %s", (kind) => {
    const parsed = parseWorkflowSource(templateFor(kind), `${kind}.ts`);
    expect(parsed.manifest.name).toBe(kind);
  });

  it("previews the dogfood code audit example", async () => {
    const source = await readFile(path.resolve("examples/code-audit.ts"), "utf8");
    const parsed = parseWorkflowSource(source, "examples/code-audit.ts");
    expect(parsed.manifest.name).toBe("code-audit");
  });

  it("documents the parent-does-not-solve native bridge contract", async () => {
    const skill = await readFile(path.resolve("skills/flowdex/SKILL.md"), "utf8");
    expect(skill).toContain("parent Codex agent must not solve");
    expect(skill).toContain("flowdex next <run-id> --json");
    expect(skill).toContain("AdapterResult JSON");
  });
});
