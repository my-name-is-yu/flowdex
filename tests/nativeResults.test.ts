import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectNativeResultFiles } from "../src/runtime/nativeResults.js";
import { FlowdexRuntime } from "../src/runtime/runtime.js";
import { writeNativeDispatchFilePackage } from "../src/runtime/nativeDispatchFiles.js";
import { FlowdexState } from "../src/store/state.js";
import type { AdapterResult } from "../src/types.js";

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "flowdex-codex-results-"));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("native result collection", () => {
  it("collects result files for leased and dispatched tasks without touching invalid or missing tasks", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = await writeFanoutWorkflow(3);
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("needs-dispatch");

    const state = await FlowdexState.openRun(temp, summary.runId);
    const dispatches = state.leaseDispatches(summary.runId, 10);
    expect(dispatches).toHaveLength(3);
    state.attachAgent(summary.runId, dispatches[1]!.childKey, dispatches[1]!.leaseToken, "agent-invalid");

    const firstPackage = await writeNativeDispatchFilePackage(FlowdexState.runDirectory(temp, summary.runId), dispatches[0]!);
    const secondPackage = await writeNativeDispatchFilePackage(FlowdexState.runDirectory(temp, summary.runId), dispatches[1]!);
    await writeFile(firstPackage.resultPath, JSON.stringify(adapterResult("first")));
    await writeFile(secondPackage.resultPath, JSON.stringify({ status: "completed", summary: "missing fields" }));

    const results = await collectNativeResultFiles(temp, summary.runId, state);
    expect(results.map((result) => [result.taskId, result.status])).toEqual([
      ["first", "collected"],
      ["second", "invalid"],
      ["third", "missing"]
    ]);
    expect(state.getAgentTask(summary.runId, dispatches[0]!.childKey)?.status).toBe("completed");
    expect(state.getAgentTask(summary.runId, dispatches[1]!.childKey)?.status).toBe("dispatched");
    expect(state.getAgentTask(summary.runId, dispatches[2]!.childKey)?.status).toBe("leased");

    const secondPass = await collectNativeResultFiles(temp, summary.runId, state);
    expect(secondPass.map((result) => [result.taskId, result.status])).toEqual([
      ["first", "skipped"],
      ["second", "invalid"],
      ["third", "missing"]
    ]);
    state.close();
  });

  it("enables resume after native result files are collected", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = await writeFanoutWorkflow(1);
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("needs-dispatch");

    const state = await FlowdexState.openRun(temp, summary.runId);
    const [dispatch] = state.leaseDispatches(summary.runId, 1);
    const filePackage = await writeNativeDispatchFilePackage(FlowdexState.runDirectory(temp, summary.runId), dispatch!);
    await writeFile(filePackage.resultPath, JSON.stringify(adapterResult("first")));
    const results = await collectNativeResultFiles(temp, summary.runId, state);
    expect(results.map((result) => result.status)).toEqual(["collected"]);
    state.close();

    const completed = await runtime.resume(summary.runId);
    expect(completed.status).toBe("completed");
    expect(completed.report).toEqual({ results: [adapterResult("first")] });
  });

  it("rejects AdapterResult files with extra top-level fields", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = await writeFanoutWorkflow(1);
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    const state = await FlowdexState.openRun(temp, summary.runId);
    const [dispatch] = state.leaseDispatches(summary.runId, 1);
    const filePackage = await writeNativeDispatchFilePackage(FlowdexState.runDirectory(temp, summary.runId), dispatch!);
    await writeFile(filePackage.resultPath, JSON.stringify({ ...adapterResult("first"), extra: true }));

    const results = await collectNativeResultFiles(temp, summary.runId, state);

    expect(results.map((result) => result.status)).toEqual(["invalid"]);
    expect(results[0]?.error).toMatch(/unexpected adapter result field/);
    state.close();
  });
});

async function writeFanoutWorkflow(taskCount: number): Promise<string> {
  const taskIds = ["first", "second", "third"].slice(0, taskCount);
  const workflowPath = path.join(temp, "workflow.ts");
  await writeFile(
    workflowPath,
    `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "native-results",
  maxAgents: 4,
  maxConcurrency: 2,
  defaultAdapter: "codex-native",
  adapters: { "codex-native": { type: "codex-native" } },
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 3 }]
}, async (ctx) => {
  const results = await ctx.fanout({
    id: "review",
    phase: "review",
    tasks: ${JSON.stringify(taskIds.map((id) => ({ id, phase: "review", mode: "read-only", prompt: id })))}
  });
  return ctx.report({ results });
});`
  );
  return workflowPath;
}

function adapterResult(value: string): AdapterResult {
  return {
    status: "completed",
    summary: value,
    data: { value },
    claims: [],
    artifacts: [],
    diff: null,
    usage: {},
    error: null
  };
}
