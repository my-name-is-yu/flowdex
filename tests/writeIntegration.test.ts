import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/runtime/writeIntegration.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "flowdex-integrate-"));
  git(["init"]);
  git(["config", "user.email", "flowdex@example.com"]);
  git(["config", "user.name", "Flowdex Test"]);
  await writeFile(path.join(repo, "a.txt"), "before\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "initial"]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("explicit patch integration", () => {
  it("applies a worker-provided patch", async () => {
    await writeFile(path.join(repo, "a.txt"), "after\n");
    const patch = git(["diff"]);
    git(["checkout", "--", "a.txt"]);

    applyPatch(repo, patch, ["a.txt"]);

    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("rejects patches outside the manifest write allowlist", async () => {
    await writeFile(path.join(repo, "a.txt"), "after\n");
    const patch = git(["diff"]);
    git(["checkout", "--", "a.txt"]);

    expect(() => applyPatch(repo, patch, ["src/**"])).toThrow(/outside manifest\.permissions\.write/);
  });
});

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
