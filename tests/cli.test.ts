import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterResult } from "../src/types.js";

let temp: string;
const cliPath = path.resolve("dist/cli.js");
const CLI_TEST_TIMEOUT_MS = 15_000;

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "flowdex-cli-"));
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe("Flowdex CLI native bridge", () => {
  it("prints help without loading SQLite-backed runtime state", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], { cwd: temp, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("flowdex preview <workflow.ts>");
  });

  it("runs the file-based native dispatch lifecycle", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    expect(started.status).toBe("needs-dispatch");
    const runId = String(started.runId);

    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    expect(dispatch?.childKey).toBe("agent:review");
    expect(dispatch?.instructionPath).toContain("instructions.md");
    expect(await readFile(dispatch!.taskPath, "utf8")).toContain("Review the subject file.");

    runText(["attach-agent", runId, dispatch!.childKey, "--lease-token", dispatch!.leaseToken, "--agent-ref", "agent-1"]);
    await writeFile(dispatch!.resultPath, JSON.stringify(adapterResult("reviewed")));

    const collected = runJson(["collect-results", runId, "--continue", "--json"]) as {
      continued: { status: string; report: unknown };
    };
    expect(collected.continued.status).toBe("completed");
    expect(collected.continued.report).toEqual({ result: adapterResult("reviewed") });

    const report = runJson(["report", runId]);
    expect(report).toEqual({ result: adapterResult("reviewed") });
  }, CLI_TEST_TIMEOUT_MS);

  it("treats the next limit as total active native dispatch capacity", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, fanoutWorkflowSource(8));

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    expect(started.status).toBe("needs-dispatch");
    const runId = String(started.runId);
    expect(await snapshotDirectoryCount(runId)).toBe(0);

    const firstBatch = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    expect(firstBatch.map((dispatch) => dispatch.taskId)).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6"]);
    expect(await snapshotDirectoryCount(runId)).toBe(6);
    expect(runJson(["next", runId, "--json", "--files"])).toEqual([]);

    for (const dispatch of firstBatch) {
      await writeFile(dispatch.resultPath, JSON.stringify(adapterResult(dispatch.taskId)));
    }
    const firstCollection = runJson(["collect-results", runId, "--continue", "--json"]) as {
      continued: { status: string; report: unknown };
    };
    expect(firstCollection.continued.status).toBe("needs-dispatch");
    expect(firstCollection.continued.report).toBeNull();

    const secondBatch = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    expect(secondBatch.map((dispatch) => dispatch.taskId)).toEqual(["task-7", "task-8"]);
    expect(await snapshotDirectoryCount(runId)).toBe(8);
    for (const dispatch of secondBatch) {
      await writeFile(dispatch.resultPath, JSON.stringify(adapterResult(dispatch.taskId)));
    }
    const completed = runJson(["collect-results", runId, "--continue", "--json"]) as {
      continued: { status: string; report: { results: AdapterResult[] } };
    };
    expect(completed.continued.status).toBe("completed");
    expect(completed.continued.report.results.map((result) => result.summary)).toEqual([
      "task-1",
      "task-2",
      "task-3",
      "task-4",
      "task-5",
      "task-6",
      "task-7",
      "task-8"
    ]);
  }, CLI_TEST_TIMEOUT_MS);

  it("keeps collect-results --continue open for missing native result files", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    runJson(["next", runId, "--json", "--files"]);

    const collected = runJson(["collect-results", runId, "--continue", "--json"]) as {
      results: Array<{ status: string }>;
      continued: { status: string; report: unknown };
    };
    expect(collected.results.map((result) => result.status)).toEqual(["missing"]);
    expect(collected.continued.status).toBe("needs-dispatch");
    expect(collected.continued.report).toBeNull();
  }, CLI_TEST_TIMEOUT_MS);

  it("keeps collect-results --continue open for invalid native result files", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    await writeFile(dispatch!.resultPath, JSON.stringify({ status: "completed", summary: "missing required fields" }));

    const collected = runJson(["collect-results", runId, "--continue", "--json"]) as {
      results: Array<{ status: string }>;
      continued: { status: string; report: unknown };
    };
    expect(collected.results.map((result) => result.status)).toEqual(["invalid"]);
    expect(collected.continued.status).toBe("needs-dispatch");
    expect(collected.continued.report).toBeNull();
  }, CLI_TEST_TIMEOUT_MS);

  it("returns blocked native worker results through fanout instead of stranding the run", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, fanoutWorkflowSource(1));

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    await writeFile(dispatch!.resultPath, JSON.stringify({ ...adapterResult("blocked"), status: "blocked", error: "needs user input" }));

    const collected = runJson(["collect-results", runId, "--continue", "--json"]) as {
      results: Array<{ status: string; adapterStatus?: string }>;
      continued: { status: string; report: { results: AdapterResult[] } };
    };
    expect(collected.results).toMatchObject([{ status: "collected", adapterStatus: "blocked" }]);
    expect(collected.continued.status).toBe("completed");
    expect(collected.continued.report.results[0]).toMatchObject({ status: "blocked", error: "needs user input" });
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects unsafe save names and existing init destinations", async () => {
    await mkdir(path.join(temp, ".flowdex", "runs", "run-1"), { recursive: true });
    await writeFile(path.join(temp, ".flowdex", "runs", "run-1", "workflow.ts"), workflowSource());
    expect(() => runText(["save", "../../escape", "copied"])).toThrow(/unsafe Flowdex run id/);
    expect(() => runText(["save", "run-1", "../../escape"])).toThrow(/safe id/);
    await mkdir(path.join(temp, ".flowdex", "workflows"), { recursive: true });
    await writeFile(path.join(temp, ".flowdex", "workflows", "existing.ts"), "existing");
    expect(() => runText(["save", "run-1", "existing"])).toThrow(/EEXIST|exist/i);
    await expect(readFile(path.join(temp, ".flowdex", "workflows", "existing.ts"), "utf8")).resolves.toBe("existing");

    const destination = path.join(temp, "workflow.ts");
    await writeFile(destination, "existing");
    expect(() => runText(["init", "code-audit", destination])).toThrow(/EEXIST|exist/i);
    await expect(readFile(destination, "utf8")).resolves.toBe("existing");
  }, CLI_TEST_TIMEOUT_MS);

  it("rejects unsafe run ids before writing a run package", async () => {
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    expect(() => runText(["run", workflowPath, "--run-id", "../../escape", "--yes"])).toThrow(/unsafe Flowdex run id/);
  }, CLI_TEST_TIMEOUT_MS);

  it("requeues a restarted native worker for the next lease", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, fanoutWorkflowSource(1));

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    await writeFile(dispatch!.resultPath, JSON.stringify(adapterResult(dispatch!.taskId)));
    expect((runJson(["collect-results", runId, "--continue", "--json"]) as { continued: { status: string } }).continued.status).toBe("completed");

    const restartOutput = runText(["restart-agent", runId, dispatch!.childKey]);
    expect(restartOutput).toContain("needs-dispatch");
    const [replacement] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    expect(replacement).toMatchObject({ childKey: dispatch!.childKey, taskId: dispatch!.taskId });
    expect(replacement!.leaseToken).not.toBe(dispatch!.leaseToken);
  }, CLI_TEST_TIMEOUT_MS);

  it("does not lease native dispatches for paused runs", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    runText(["pause", runId]);

    expect(() => runText(["next", runId, "--json", "--files"])).toThrow(/cannot lease native dispatches for paused run/);
  }, CLI_TEST_TIMEOUT_MS);

  it("supports the manual complete-agent bridge path", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    const manualResult = path.join(temp, "manual-result.json");
    await writeFile(manualResult, JSON.stringify(adapterResult("manual")));

    expect(() => runText(["complete-agent", runId, dispatch!.childKey, "--lease-token", "wrong", "--result", `@${manualResult}`])).toThrow(/lease token/);
    runText(["complete-agent", runId, dispatch!.childKey, "--lease-token", dispatch!.leaseToken, "--result", `@${manualResult}`]);
    const completed = runJson(["continue", runId]) as { status: string; report: { result: AdapterResult } };

    expect(completed.status).toBe("completed");
    expect(completed.report.result.summary).toBe("manual");
  }, CLI_TEST_TIMEOUT_MS);

  it("reports compact status and watch progress for native dispatches", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());

    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const before = runJson(["status", runId, "--json", "--compact"]) as { counts: Record<string, number> };
    expect(before.counts.dispatchable).toBe(1);

    runJson(["next", runId, "--json", "--files"]);
    const afterLease = runJson(["status", runId, "--json", "--compact"]) as { counts: Record<string, number>; tasks: Array<{ status: string; resultPath?: string }> };
    expect(afterLease.counts.leased).toBe(1);
    expect(afterLease.tasks[0]?.status).toBe("leased");
    expect(afterLease.tasks[0]?.resultPath).toContain("adapter-result.json");
    expect(runText(["watch", runId])).toContain("agents: total=1");
  }, CLI_TEST_TIMEOUT_MS);

  it("lists report paths for completed reports", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());
    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const runId = String(started.runId);
    const [dispatch] = runJson(["next", runId, "--json", "--files"]) as Array<Record<string, string>>;
    await writeFile(dispatch!.resultPath, JSON.stringify(adapterResult("reviewed")));
    runJson(["collect-results", runId, "--continue", "--json"]);

    const paths = runJson(["report", runId, "--paths"]) as string[];

    expect(paths).toContain("result.summary");
    expect(paths).toContain("result.data.value");
  }, CLI_TEST_TIMEOUT_MS);

  it("rebuilds the events.jsonl projection from SQLite", async () => {
    await mkdir(path.join(temp, "src"));
    await writeFile(path.join(temp, "src", "subject.txt"), "subject\n");
    const workflowPath = path.join(temp, "workflow.ts");
    await writeFile(workflowPath, workflowSource());
    const started = runJson(["run", workflowPath, "--yes"]) as { runId: string; status: string };
    const eventsPath = path.join(temp, ".flowdex", "runs", String(started.runId), "events.jsonl");
    await writeFile(eventsPath, "stale\n");

    const output = runText(["repair-events", String(started.runId)]);

    expect(output).toContain("rebuilt events.jsonl");
    await expect(readFile(eventsPath, "utf8")).resolves.toContain("run.created");
  }, CLI_TEST_TIMEOUT_MS);
});

function runJson(args: string[]): unknown {
  return JSON.parse(runText(args));
}

function runText(args: string[]): string {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: temp, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function workflowSource(): string {
  return `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "cli-flow",
  maxAgents: 1,
  maxConcurrency: 1,
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: 1 }]
}, async (ctx) => {
  const result = await ctx.agent({ id: "review", phase: "review", mode: "read-only", prompt: "Review the subject file." });
  return ctx.report({ result });
});`;
}

function fanoutWorkflowSource(taskCount: number): string {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const id = `task-${index + 1}`;
    return { id, phase: "review", mode: "read-only", prompt: id };
  });
  return `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "cli-fanout",
  maxAgents: ${taskCount},
  maxConcurrency: 8,
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "review", maxAgents: ${taskCount} }]
}, async (ctx) => {
  const results = await ctx.fanout({
    id: "review",
    phase: "review",
    tasks: ${JSON.stringify(tasks)}
  });
  return ctx.report({ results });
});`;
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

async function snapshotDirectoryCount(runId: string): Promise<number> {
  try {
    const entries = await readdir(path.join(temp, ".flowdex", "runs", runId, "snapshots"), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}
