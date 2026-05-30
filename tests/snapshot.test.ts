import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/runtime/snapshot.js";

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "flowdex-snapshot-"));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("snapshot builder", () => {
  it("materializes regular files", async () => {
    await writeFile(path.join(temp, "a.txt"), "hello");
    const snapshot = await buildSnapshot({ root: temp, globs: ["**"], outDir: path.join(os.tmpdir(), `flowdex-out-${Date.now()}`) });
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(snapshot.files[0]?.sha256).toHaveLength(64);
  });

  it("does not create sidecars that can overwrite real .mode files", async () => {
    await writeFile(path.join(temp, "a.txt"), "hello");
    await writeFile(path.join(temp, "a.txt.mode"), "real mode file");
    const outDir = path.join(os.tmpdir(), `flowdex-out-${Date.now()}-mode`);
    const snapshot = await buildSnapshot({ root: temp, globs: ["**"], outDir });

    expect(snapshot.files.map((file) => file.path)).toEqual(["a.txt", "a.txt.mode"]);
    await expect(readFile(path.join(outDir, "a.txt.mode"), "utf8")).resolves.toBe("real mode file");
  });

  it("rejects symlinks", async () => {
    await writeFile(path.join(temp, "target.txt"), "hello");
    await symlink(path.join(temp, "target.txt"), path.join(temp, "link.txt"));
    await expect(buildSnapshot({ root: temp, globs: ["**"], outDir: path.join(temp, "out") })).rejects.toThrow(/symlink/);
  });
});
