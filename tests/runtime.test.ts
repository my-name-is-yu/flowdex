import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlowdexRuntime } from "../src/runtime/runtime.js";
import { FlowdexState } from "../src/store/state.js";
import type { AdapterResult } from "../src/types.js";
import { sha256Bytes } from "../src/util/hash.js";

let temp: string;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "flowdex-runtime-"));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("FlowdexRuntime", () => {
  it("runs a strict hostCommand workflow to completion", async () => {
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "runtime-flow",
  maxAgents: 2,
  maxConcurrency: 1,
  permissions: {
    read: ["**"],
    write: [],
    hostCommands: [{ id: "unit", argv: ["node", "-e", "console.log('ok')"], cwd: "project" }],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  const unit = await ctx.hostCommand({ id: "unit.run", phase: "test", commandId: "unit" });
  ctx.claim({
    id: "unit-passed",
    text: "The unit command completed successfully.",
    kind: "verification",
    confidence: "high",
    evidence: [{ type: "command", artifactId: unit.data.stdoutArtifactId, command: ["node", "-e", "console.log('ok')"], exitCode: unit.data.exitCode }]
  });
  return ctx.report({ title: "Runtime flow", claimIds: ["unit-passed"] });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("completed");
    expect(summary.report).toMatchObject({ title: "Runtime flow", claimIds: ["unit-passed"] });
  });

  it("requires approval before running", async () => {
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "approval-flow",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: { read: ["**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  return ctx.report({ ok: true });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 1 });
    await expect(runtime.run(workflowPath)).rejects.toThrow(/approval required/i);
  });

  it("rejects duplicate run ids before overwriting the run package", async () => {
    const firstWorkflow = path.join(temp, "first.ts");
    const secondWorkflow = path.join(temp, "second.ts");
    await writeFile(firstWorkflow, simpleWorkflow("first-flow"));
    await writeFile(secondWorkflow, simpleWorkflow("second-flow"));
    const runId = "fixed-run";

    await new FlowdexRuntime({ cwd: temp, runId, maxTicks: 2, autoApprove: true }).run(firstWorkflow);
    await expect(new FlowdexRuntime({ cwd: temp, runId, maxTicks: 2, autoApprove: true }).run(secondWorkflow)).rejects.toThrow(/already exists/);

    await expect(readFile(path.join(temp, ".flowdex", "runs", runId, "workflow.ts"), "utf8")).resolves.toContain("first-flow");
  });

  it("refuses to resume a modified approved run package", async () => {
    const workflowPath = path.join(temp, "workflow.ts");
    const runtime = new FlowdexRuntime({ cwd: temp, runId: "approved-run", maxTicks: 2, autoApprove: true });
    const summary = await runtime.run(await writeWorkflow(workflowPath, simpleWorkflow("approved-flow")));
    expect(summary.status).toBe("completed");
    await writeFile(path.join(temp, ".flowdex", "runs", "approved-run", "workflow.ts"), simpleWorkflow("tampered-flow"));

    const resumed = await runtime.resume("approved-run");

    expect(resumed.status).toBe("failed");
    const state = await FlowdexState.openRun(temp, "approved-run");
    expect(state.getRunStatus("approved-run")).toBe("failed");
    state.close();
  });

  it("does not resume paused native-dispatch runs", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = path.join(temp, "paused.ts");
    await writeFile(workflowPath, nativeSingleAgentWorkflow("paused-flow", "review"));
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("needs-dispatch");

    const state = await FlowdexState.openRun(temp, summary.runId);
    state.setRunStatus(summary.runId, "paused");
    state.close();

    const resumed = await runtime.resume(summary.runId);
    expect(resumed.status).toBe("paused");
    const pausedState = await FlowdexState.openRun(temp, summary.runId);
    expect(pausedState.getRunStatus(summary.runId)).toBe("paused");
    pausedState.close();
  });

  it("persists pending state when the tick budget is exhausted", async () => {
    const workflowPath = path.join(temp, "tick-budget.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "tick-budget",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: {
    read: ["**"],
    write: [],
    hostCommands: [{ id: "unit", argv: ["node", "-e", "console.log('ok')"], cwd: "project" }],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.hostCommand({ id: "unit.run", phase: "test", commandId: "unit" });
  return ctx.report({ ok: true });
});`
    );
    const summary = await new FlowdexRuntime({ cwd: temp, maxTicks: 1, autoApprove: true }).run(workflowPath);
    expect(summary.status).toBe("pending");
    const state = await FlowdexState.openRun(temp, summary.runId);
    expect(state.getRunStatus(summary.runId)).toBe("pending");
    state.close();
  });

  it("fails durably when final report claims are not host verified", async () => {
    const workflowPath = path.join(temp, "bad-evidence.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "bad-evidence",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: { read: ["**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  ctx.claim({ id: "unsupported", text: "unsupported", kind: "finding", confidence: "high", evidence: [] });
  return ctx.report({ claimIds: ["unsupported"] });
});`
    );
    const summary = await new FlowdexRuntime({ cwd: temp, maxTicks: 2, autoApprove: true }).run(workflowPath);
    expect(summary.status).toBe("failed");
    const state = await FlowdexState.openRun(temp, summary.runId);
    expect(state.getRunStatus(summary.runId)).toBe("failed");
    expect(state.getLatestCompletedReport(summary.runId)).toBeUndefined();
    state.close();
  });

  it("runs ctx.integrate as a durable workflow operation", async () => {
    initGitRepo(temp);
    await writeFile(path.join(temp, "a.txt"), "before\n");
    git(temp, ["add", "a.txt"]);
    git(temp, ["commit", "-m", "initial"]);
    await writeFile(path.join(temp, "a.txt"), "after\n");
    const patch = git(temp, ["diff"]);
    git(temp, ["checkout", "--", "a.txt"]);
    const workflowPath = path.join(temp, "integrate.ts");
    await writeFile(workflowPath, integrateWorkflow("integrate-ok", ["a.txt"], patch));

    const summary = await new FlowdexRuntime({ cwd: temp, maxTicks: 3, autoApprove: true }).run(workflowPath);

    expect(summary.status).toBe("completed");
    await expect(readFile(path.join(temp, "a.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("fails durably when ctx.integrate changes outside manifest.permissions.write", async () => {
    initGitRepo(temp);
    await writeFile(path.join(temp, "a.txt"), "before\n");
    git(temp, ["add", "a.txt"]);
    git(temp, ["commit", "-m", "initial"]);
    await writeFile(path.join(temp, "a.txt"), "after\n");
    const patch = git(temp, ["diff"]);
    git(temp, ["checkout", "--", "a.txt"]);
    const workflowPath = path.join(temp, "integrate-rejected.ts");
    await writeFile(workflowPath, integrateWorkflow("integrate-rejected", ["src/**"], patch));

    const summary = await new FlowdexRuntime({ cwd: temp, maxTicks: 3, autoApprove: true }).run(workflowPath);

    expect(summary.status).toBe("failed");
    const state = await FlowdexState.openRun(temp, summary.runId);
    expect(state.getRunStatus(summary.runId)).toBe("failed");
    state.close();
    await expect(readFile(path.join(temp, "a.txt"), "utf8")).resolves.toBe("before\n");
  });

  it("pauses codex-native fanout for leased dispatch and resumes after child completion", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = path.join(temp, "native-dispatch.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "native-dispatch",
  maxAgents: 4,
  maxConcurrency: 2,
  defaultAdapter: "codex-native",
  adapters: { "codex-native": { type: "codex-native" } },
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 2 }]
}, async (ctx) => {
  const results = await ctx.fanout({
    id: "review",
    phase: "review",
    tasks: [
      { id: "first", phase: "review", mode: "read-only", prompt: "first" },
      { id: "second", phase: "review", mode: "read-only", prompt: "second" }
    ]
  });
  return ctx.report({ results });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("needs-dispatch");

    const state = await FlowdexState.openRun(temp, summary.runId);
    const dispatches = state.leaseDispatches(summary.runId, 10);
    expect(dispatches.map((item) => item.childKey)).toEqual(["fanout:review#first", "fanout:review#second"]);
    expect(() => state.completeAgentTask(summary.runId, dispatches[0]!.childKey, "wrong", adapterResult("bad"))).toThrow(/lease token/i);
    for (const dispatch of dispatches) {
      state.completeAgentTask(summary.runId, dispatch.childKey, dispatch.leaseToken, adapterResult(dispatch.taskId));
    }
    state.close();

    const completed = await runtime.resume(summary.runId);
    expect(completed.status).toBe("completed");
    expect(completed.report).toEqual({
      results: [adapterResult("first"), adapterResult("second")]
    });
  });

  it("carries configured adapter model settings into native dispatches", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = path.join(temp, "adapter-config.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "adapter-config",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "reviewer",
  adapters: { reviewer: { type: "codex-native", model: "gpt-5.3-codex", reasoningEffort: "high" } },
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.agent({ id: "review", phase: "review", mode: "read-only", prompt: "review" });
  return ctx.report({ ok: true });
});`
    );
    const summary = await new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true }).run(workflowPath);
    const state = await FlowdexState.openRun(temp, summary.runId);
    const [dispatch] = state.leaseDispatches(summary.runId, 1);
    state.close();

    expect(dispatch).toMatchObject({
      adapter: "reviewer",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      network: "none"
    });
  });

  it("enforces manifest agent limits across sequential native operations", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "a.txt"), "a\n");
    const workflowPath = path.join(temp, "agent-budget.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "agent-budget",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.agent({ id: "first", phase: "review", mode: "read-only", prompt: "first" });
  await ctx.agent({ id: "second", phase: "review", mode: "read-only", prompt: "second" });
  return ctx.report({ ok: true });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    const state = await FlowdexState.openRun(temp, summary.runId);
    const [dispatch] = state.leaseDispatches(summary.runId, 1);
    state.completeAgentTask(summary.runId, dispatch!.childKey, dispatch!.leaseToken, adapterResult("first"));
    state.close();

    const resumed = await runtime.resume(summary.runId);
    expect(resumed.status).toBe("failed");
    const failedState = await FlowdexState.openRun(temp, summary.runId);
    expect(failedState.getRunStatus(summary.runId)).toBe("failed");
    failedState.close();
  });

  it("isolates snapshots for repeated task ids in different fanout operations", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "first\n");
    const workflowPath = path.join(temp, "snapshot-collision.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "snapshot-collision",
  maxAgents: 2,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 2 }]
}, async (ctx) => {
  await ctx.fanout({ id: "first", phase: "review", tasks: [{ id: "same", phase: "review", mode: "read-only", prompt: "first" }] });
  await ctx.fanout({ id: "second", phase: "review", tasks: [{ id: "same", phase: "review", mode: "read-only", prompt: "second" }] });
  return ctx.report({ ok: true });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    const state = await FlowdexState.openRun(temp, summary.runId);
    const [first] = state.leaseDispatches(summary.runId, 1);
    expect(await readFile(path.join(first!.cwd, "src", "subject.txt"), "utf8")).toBe("first\n");
    state.completeAgentTask(summary.runId, first!.childKey, first!.leaseToken, adapterResult("first"));
    state.close();

    await writeFile(path.join(temp, "src", "subject.txt"), "second\n");
    const secondSummary = await runtime.resume(summary.runId);
    expect(secondSummary.status).toBe("needs-dispatch");
    const secondState = await FlowdexState.openRun(temp, summary.runId);
    const [second] = secondState.leaseDispatches(summary.runId, 1);
    secondState.close();

    expect(second!.cwd).not.toBe(first!.cwd);
    await expect(readFile(path.join(first!.cwd, "src", "subject.txt"), "utf8")).resolves.toBe("first\n");
    await expect(readFile(path.join(second!.cwd, "src", "subject.txt"), "utf8")).resolves.toBe("second\n");
  });

  it("rebuilds restarted native task snapshots without stale files", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "stale.txt"), "stale\n");
    const workflowPath = path.join(temp, "restart-snapshot.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "restart-snapshot",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.agent({ id: "review", phase: "review", mode: "read-only", prompt: "review" });
  return ctx.report({ ok: true });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    const state = await FlowdexState.openRun(temp, summary.runId);
    const [first] = state.leaseDispatches(summary.runId, 1);
    expect(await readFile(path.join(first!.cwd, "src", "stale.txt"), "utf8")).toBe("stale\n");

    await rm(path.join(temp, "src", "stale.txt"));
    state.deleteTaskResult(summary.runId, first!.childKey);
    state.close();

    const resumed = await runtime.resume(summary.runId);
    expect(resumed.status).toBe("needs-dispatch");
    const restartedState = await FlowdexState.openRun(temp, summary.runId);
    const [second] = restartedState.leaseDispatches(summary.runId, 1);
    restartedState.close();
    await expect(readFile(path.join(second!.cwd, "src", "stale.txt"), "utf8")).rejects.toThrow();
  });

  it("accepts fileRange evidence from the native task snapshot", async () => {
    await mkdir(path.join(temp, "src"));
    const source = "subject\n";
    await writeFile(path.join(temp, "src", "subject.txt"), source);
    const workflowPath = path.join(temp, "file-evidence.ts");
    await writeFile(
      workflowPath,
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "file-evidence",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.agent({ id: "review", phase: "review", mode: "read-only", prompt: "review" });
  ctx.claim({
    id: "subject-reviewed",
    text: "The subject file was reviewed.",
    kind: "finding",
    confidence: "high",
    evidence: [{ type: "fileRange", path: "src/subject.txt", startLine: 1, endLine: 1, contentHash: "${sha256Bytes(source)}" }]
  });
  return ctx.report({ title: "File evidence", claimIds: ["subject-reviewed"] });
});`
    );
    const runtime = new FlowdexRuntime({ cwd: temp, maxTicks: 4, autoApprove: true });
    const summary = await runtime.run(workflowPath);
    expect(summary.status).toBe("needs-dispatch");

    const state = await FlowdexState.openRun(temp, summary.runId);
    const [dispatch] = state.leaseDispatches(summary.runId, 1);
    state.completeAgentTask(summary.runId, dispatch!.childKey, dispatch!.leaseToken, adapterResult("reviewed"));
    state.close();

    const completed = await runtime.resume(summary.runId);
    expect(completed.status).toBe("completed");
    expect(completed.report).toMatchObject({
      title: "File evidence",
      claimIds: ["subject-reviewed"],
      claims: [{ id: "subject-reviewed" }]
    });
  });
});

function simpleWorkflow(name: string): string {
  return `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "${name}",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: { read: ["**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  return ctx.report({ ok: true });
});`;
}

async function writeWorkflow(destination: string, source: string): Promise<string> {
  await writeFile(destination, source);
  return destination;
}

function nativeSingleAgentWorkflow(name: string, taskId: string): string {
  return `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "${name}",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.agent({ id: "${taskId}", phase: "review", mode: "read-only", prompt: "review" });
  return ctx.report({ ok: true });
});`;
}

function integrateWorkflow(name: string, writeGlobs: string[], patch: string): string {
  return `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "${name}",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: { read: ["**"], write: ${JSON.stringify(writeGlobs)}, hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  await ctx.integrate({ id: "apply", phase: "test", patches: [{ patch: ${JSON.stringify(patch)} }] });
  return ctx.report({ ok: true });
});`;
}

function initGitRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "flowdex@example.com"]);
  git(cwd, ["config", "user.name", "Flowdex Test"]);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
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
