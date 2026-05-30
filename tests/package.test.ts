import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("package runtime contract", () => {
  it("exports the workflow authoring helper used by workflow sources", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { workflow } from './dist/index.js'; const definition = workflow({ name: 'pkg', maxAgents: 1, maxConcurrency: 1, permissions: { read: [], write: [] }, phases: [{ id: 'test', maxAgents: 1 }] }, async () => null); console.log(definition.manifest.name);"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("pkg");
  });
});
