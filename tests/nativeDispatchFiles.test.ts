import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNativeDispatchFilePackage } from "../src/runtime/nativeDispatchFiles.js";
import type { NativeDispatch } from "../src/types.js";

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "flowdex-codex-dispatch-"));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("native dispatch file packages", () => {
  it("writes full task data to files and returns compact spawn metadata", async () => {
    const dispatch: NativeDispatch = {
      runId: "run-1",
      childKey: "fanout:ideas#idea-01",
      parentOpKey: "fanout:ideas",
      taskId: "idea-01",
      phase: "ideate",
      adapter: "codex-native",
      mode: "read-only",
      network: "web",
      prompt: "Produce ideas.",
      data: { large: "x".repeat(1000) },
      cwd: path.join(temp, "snapshot"),
      leaseToken: "lease-token",
      leaseExpiresAt: "2026-05-30T00:00:00.000Z"
    };

    const compact = await writeNativeDispatchFilePackage(temp, dispatch);
    const task = JSON.parse(await readFile(compact.taskPath, "utf8")) as NativeDispatch;
    const instructions = await readFile(compact.instructionPath, "utf8");

    expect(compact).not.toHaveProperty("prompt");
    expect(compact).not.toHaveProperty("data");
    expect(compact.resultPath).toContain("adapter-result.json");
    expect(compact.agentPrompt).toContain(compact.instructionPath);
    expect(task.data).toEqual(dispatch.data);
    expect(task.prompt).toBe(dispatch.prompt);
    expect(task.network).toBe("web");
    expect(compact.network).toBe("web");
    expect(instructions).toContain(compact.taskPath);
    expect(instructions).toContain(compact.resultPath);
    expect(instructions).toContain("Network policy for this task: web");
  });
});
