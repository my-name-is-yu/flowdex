#!/usr/bin/env node
import { constants } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateAdapterResult } from "./runtime/adapterResult.js";
import { templateFor } from "./runtime/templates.js";
import { nativeDispatchResultPath, writeNativeDispatchFilePackage } from "./runtime/nativeDispatchFiles.js";
import { readReportPath } from "./runtime/reportPath.js";
import type { AgentTaskRecord, CanonicalValue, NativeDispatch } from "./types.js";
import type { NativeDispatchFilePackage } from "./runtime/nativeDispatchFiles.js";
import type { WorkflowManifest } from "./types.js";
import { sha256Bytes, stableStringify } from "./util/hash.js";

const CODEX_DESKTOP_ACTIVE_AGENT_LIMIT = 6;
const SNAPSHOT_MANIFEST_FILE = ".flowdex-snapshot.json";

interface CommandContext {
  command: string;
  target: string | undefined;
  rest: string[];
  cwd: string;
}

type CommandHandler = (context: CommandContext) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  preview: previewCommand,
  run: runCommand,
  list: listCommand,
  resume: resumeCommand,
  continue: resumeCommand,
  inspect: inspectCommand,
  next: nextCommand,
  "attach-agent": attachAgentCommand,
  "complete-agent": completeAgentCommand,
  "collect-results": collectResultsCommand,
  report: reportCommand,
  watch: watchCommand,
  status: statusCommand,
  pause: lifecycleCommand,
  stop: lifecycleCommand,
  "repair-events": repairEventsCommand,
  "restart-agent": restartAgentCommand,
  save: saveCommand,
  workflow: workflowCommand,
  init: initCommand
};

async function main(argv: string[]): Promise<void> {
  const [command, target, ...rest] = argv;
  const cwd = process.cwd();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) throw new Error(`unknown command: ${command}`);
  await handler({ command, target, rest, cwd });
}

async function previewCommand({ cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex preview requires a workflow path");
  const [{ parseWorkflowSource }, { formatPreview }] = await Promise.all([import("./policy/manifest.js"), import("./runtime/preview.js")]);
  const workflowPath = await resolveWorkflowPath(cwd, target);
  const parsed = parseWorkflowSource(await readFile(workflowPath, "utf8"), workflowPath);
  process.stdout.write(`${formatPreview(parsed)}\n`);
}

async function runCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex run requires a workflow path");
  const { FlowdexRuntime } = await import("./runtime/runtime.js");
  const inputFlag = rest.findIndex((item) => item === "--input");
  const input = inputFlag >= 0 && rest[inputFlag + 1] ? JSON.parse(await readInput(rest[inputFlag + 1]!)) : {};
  const runIdFlag = rest.findIndex((item) => item === "--run-id");
  const runId = runIdFlag >= 0 ? rest[runIdFlag + 1] : undefined;
  const runtime = new FlowdexRuntime({
    cwd,
    input,
    autoApprove: rest.includes("--yes"),
    ...(runId ? { runId } : {})
  });
  const summary = await runtime.run(await resolveWorkflowPath(cwd, target));
  writeRunSummary(summary);
}

async function listCommand({ cwd }: CommandContext): Promise<void> {
  const { FlowdexState } = await import("./store/state.js");
  const runIds = await FlowdexState.listRunIds(cwd);
  for (const runId of runIds) {
    const state = await FlowdexState.openExistingRun(cwd, runId);
    if (!state) {
      process.stdout.write(`${runId}\tunknown\n`);
      continue;
    }
    const run = state.getRun(runId);
    state.close();
    process.stdout.write(`${runId}\t${String(run?.status ?? "unknown")}\n`);
  }
}

async function resumeCommand({ command, cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error(`flowdex ${command} requires a run id`);
  const { FlowdexRuntime } = await import("./runtime/runtime.js");
  const runtime = new FlowdexRuntime({ cwd, autoApprove: true });
  const summary = await runtime.resume(target);
  writeRunSummary(summary);
}

async function inspectCommand({ cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex inspect requires a run id");
  const state = await openExistingState(cwd, target);
  const run = state.getRun(target);
  const events = state.listEvents(target).map((event) => ({
    ...event,
    payload_json: JSON.parse(String(event.payload_json))
  }));
  state.close();
  process.stdout.write(JSON.stringify({ run, events }, null, 2));
  process.stdout.write("\n");
}

async function nextCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex next requires a run id");
  const limit = Number(readFlag(rest, "--limit") ?? String(CODEX_DESKTOP_ACTIVE_AGENT_LIMIT));
  const state = await openExistingState(cwd, target);
  const dispatches = state.leaseDispatches(target, Number.isFinite(limit) && limit > 0 ? limit : CODEX_DESKTOP_ACTIVE_AGENT_LIMIT);
  state.close();
  const { FlowdexState } = await import("./store/state.js");
  const runRoot = FlowdexState.runDirectory(cwd, target);
  const materialized: NativeDispatch[] = [];
  for (const dispatch of dispatches) {
    try {
      materialized.push(await materializeDispatchSnapshot(cwd, target, runRoot, dispatch));
    } catch (error) {
      const releaseState = await openExistingState(cwd, target);
      try {
        releaseState.releaseLease(target, dispatch.childKey, dispatch.leaseToken, error instanceof Error ? error.message : String(error));
      } finally {
        releaseState.close();
      }
      throw error;
    }
  }
  const output: Array<NativeDispatch | NativeDispatchFilePackage> = rest.includes("--files") ? [] : materialized;
  if (rest.includes("--files")) {
    for (const dispatch of materialized) {
      try {
        output.push(await writeNativeDispatchFilePackage(runRoot, dispatch));
      } catch (error) {
        const releaseState = await openExistingState(cwd, target);
        try {
          releaseState.releaseLease(target, dispatch.childKey, dispatch.leaseToken, error instanceof Error ? error.message : String(error));
        } finally {
          releaseState.close();
        }
        throw error;
      }
    }
  }
  if (rest.includes("--json")) {
    process.stdout.write(JSON.stringify(output, null, 2));
    process.stdout.write("\n");
    return;
  }
  for (const item of output) {
    const filePackage = item as NativeDispatchFilePackage;
    process.stdout.write(
      "instructionPath" in item
        ? `${filePackage.childKey}\t${filePackage.phase}\t${filePackage.mode}\t${filePackage.cwd}\t${filePackage.instructionPath}\t${filePackage.resultPath}\n`
        : `${item.childKey}\t${item.phase}\t${item.mode}\t${item.cwd}\n`
    );
  }
}

async function materializeDispatchSnapshot(cwd: string, runId: string, runRoot: string, dispatch: NativeDispatch): Promise<NativeDispatch> {
  if (dispatch.cwd) return dispatch;
  const state = await openExistingState(cwd, runId);
  try {
    const run = state.getRun(runId);
    if (!run) throw new Error(`unknown Flowdex run: ${runId}`);
    const manifest = JSON.parse(String(run.manifest_json)) as WorkflowManifest;
    const snapshotRoot = path.join(runRoot, "snapshots", collisionResistantSegment(dispatch.childKey));
    await rm(snapshotRoot, { recursive: true, force: true });
    const { buildSnapshot } = await import("./runtime/snapshot.js");
    const snapshot = await buildSnapshot({
      root: cwd,
      globs: manifest.permissions.read,
      outDir: snapshotRoot
    });
    await writeFile(path.join(snapshotRoot, SNAPSHOT_MANIFEST_FILE), stableStringify(snapshot));
    state.setAgentTaskContextCwd(runId, dispatch.childKey, snapshotRoot);
    return { ...dispatch, cwd: snapshotRoot };
  } finally {
    state.close();
  }
}

async function attachAgentCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target || !rest[0]) throw new Error("flowdex attach-agent requires a run id and child key");
  const leaseToken = readFlag(rest, "--lease-token");
  const agentRef = readFlag(rest, "--agent-ref");
  if (!leaseToken || !agentRef) throw new Error("flowdex attach-agent requires --lease-token and --agent-ref");
  const state = await openExistingState(cwd, target);
  state.attachAgent(target, rest[0], leaseToken, agentRef);
  state.close();
  process.stdout.write(`${target}\tattached ${rest[0]}\t${agentRef}\n`);
}

async function completeAgentCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target || !rest[0]) throw new Error("flowdex complete-agent requires a run id and child key");
  const leaseToken = readFlag(rest, "--lease-token");
  const resultPath = readFlag(rest, "--result");
  if (!leaseToken || !resultPath) throw new Error("flowdex complete-agent requires --lease-token and --result");
  const result = validateAdapterResult(JSON.parse(await readInput(resultPath)));
  const state = await openExistingState(cwd, target);
  state.completeAgentTask(target, rest[0], leaseToken, result);
  state.close();
  process.stdout.write(`${target}\tcompleted ${rest[0]}\t${result.status}\n`);
}

async function collectResultsCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex collect-results requires a run id");
  const { collectNativeResultFiles } = await import("./runtime/nativeResults.js");
  const state = await openExistingState(cwd, target);
  const results = await collectNativeResultFiles(cwd, target, state);
  state.close();
  let continued: { runId: string; status: string; report: CanonicalValue | null } | undefined;
  if (rest.includes("--continue")) {
    const { FlowdexRuntime } = await import("./runtime/runtime.js");
    const runtime = new FlowdexRuntime({ cwd, autoApprove: true });
    const summary = await runtime.resume(target);
    continued = { runId: summary.runId, status: summary.status, report: summary.report ?? null };
  }
  if (rest.includes("--json")) {
    process.stdout.write(JSON.stringify({ runId: target, results, continued: continued ?? null }, null, 2));
    process.stdout.write("\n");
    return;
  }
  for (const result of results) {
    process.stdout.write(`${result.childKey}\t${result.status}${result.error ? `\t${result.error}` : ""}\n`);
  }
  if (continued) process.stdout.write(`${continued.runId}\tcontinued\t${continued.status}\n`);
}

async function reportCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex report requires a run id");
  const state = await openExistingState(cwd, target);
  const report = state.getLatestCompletedReport(target);
  state.close();
  if (rest.includes("--paths")) {
    process.stdout.write(JSON.stringify(listReportPaths(report), null, 2));
    process.stdout.write("\n");
    return;
  }
  const pathExpression = readFlag(rest, "--path");
  const value = pathExpression ? readReportPath(report, pathExpression) : (report ?? null);
  if (rest.includes("--raw") && typeof value === "string") {
    process.stdout.write(value);
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2));
  process.stdout.write("\n");
}

async function watchCommand({ cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex watch requires a run id");
  const state = await openExistingState(cwd, target);
  const { run, tasks } = state.getRunSummary(target);
  state.close();
  process.stdout.write(formatWatch(target, run, tasks));
}

async function statusCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex status requires a run id");
  const state = await openExistingState(cwd, target);
  const { run, tasks } = state.getRunSummary(target);
  state.close();
  if (rest.includes("--json")) {
    const outputTasks = rest.includes("--compact") ? tasks.map((task) => compactStatusTask(cwd, target, task)) : tasks;
    process.stdout.write(JSON.stringify({ runId: target, run, counts: countTasks(tasks), tasks: outputTasks }, null, 2));
    process.stdout.write("\n");
    return;
  }
  process.stdout.write(formatWatch(target, run, tasks));
}

async function lifecycleCommand({ command, cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error(`flowdex ${command} requires a run id`);
  const state = await openExistingState(cwd, target);
  const run = state.getRun(target);
  state.setRunStatus(target, command === "pause" ? "paused" : "stopped");
  if (command === "stop" && typeof run?.pid === "number" && isFreshHeartbeat(run.heartbeat_at)) {
    try {
      process.kill(-run.pid, "SIGTERM");
    } catch {
      try {
        process.kill(run.pid, "SIGTERM");
      } catch {
        // The process may have already exited; the stopped state remains authoritative.
      }
    }
  }
  state.close();
  process.stdout.write(`${target}\t${command === "pause" ? "paused" : "stopped"}\n`);
}

async function repairEventsCommand({ cwd, target }: CommandContext): Promise<void> {
  if (!target) throw new Error("flowdex repair-events requires a run id");
  const state = await openExistingState(cwd, target);
  const count = state.rebuildEventProjection(target);
  state.close();
  process.stdout.write(`${target}\trebuilt events.jsonl\t${count}\n`);
}

async function restartAgentCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target || !rest[0]) throw new Error("flowdex restart-agent requires a run id and op key");
  const state = await openExistingState(cwd, target);
  state.deleteTaskResult(target, rest[0]);
  state.close();
  const { FlowdexRuntime } = await import("./runtime/runtime.js");
  const runtime = new FlowdexRuntime({ cwd, autoApprove: true });
  const summary = await runtime.resume(target);
  process.stdout.write(`${target}\tinvalidated ${rest[0]}\t${summary.status}\n`);
}

async function saveCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  if (!target || !rest[0]) throw new Error("flowdex save requires a run id and workflow name");
  if (!isSafeWorkflowName(rest[0])) throw new Error("flowdex save workflow name must be a safe id");
  const { FlowdexState } = await import("./store/state.js");
  const runWorkflow = path.join(FlowdexState.runDirectory(cwd, target), "workflow.ts");
  const destination = path.join(cwd, ".flowdex", "workflows", `${rest[0]}.ts`);
  const { mkdir, copyFile } = await import("node:fs/promises");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(runWorkflow, destination, constants.COPYFILE_EXCL);
  process.stdout.write(`${destination}\n`);
}

async function workflowCommand({ cwd, target }: CommandContext): Promise<void> {
  if (target === "list") {
    const directory = path.join(cwd, ".flowdex", "workflows");
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".ts")).sort((a, b) => a.name.localeCompare(b.name))) {
        process.stdout.write(`${entry.name.slice(0, -3)}\n`);
      }
    } catch {}
    return;
  }
  throw new Error("flowdex workflow supports: list");
}

async function initCommand({ cwd, target, rest }: CommandContext): Promise<void> {
  const kind = target;
  const destination = rest[0];
  if (!kind || !destination) throw new Error("flowdex init requires a template kind and destination path");
  const source = templateFor(kind);
  const outputPath = path.resolve(cwd, destination);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, { flag: "wx" });
  process.stdout.write(`${outputPath}\n`);
}

function isSafeWorkflowName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,120}$/.test(value) && value !== "." && value !== "..";
}

function writeRunSummary(summary: { runId: string; status: string; report?: CanonicalValue | undefined }): void {
  process.stdout.write(JSON.stringify({ runId: summary.runId, status: summary.status, report: summary.report ?? null }, null, 2));
  process.stdout.write("\n");
}

async function readInput(value: string): Promise<string> {
  if (value.startsWith("@")) return await readFile(value.slice(1), "utf8");
  return value;
}

async function openExistingState(cwd: string, runId: string): Promise<import("./store/state.js").FlowdexState> {
  const { FlowdexState } = await import("./store/state.js");
  const state = await FlowdexState.openExistingRun(cwd, runId);
  if (!state) throw new Error(`unknown Flowdex run: ${runId}`);
  return state;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.findIndex((item) => item === flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function resolveWorkflowPath(cwd: string, target: string): Promise<string> {
  const direct = path.resolve(cwd, target);
  try {
    if ((await stat(direct)).isFile()) return direct;
  } catch {}
  const saved = path.join(cwd, ".flowdex", "workflows", `${target}.ts`);
  try {
    if ((await stat(saved)).isFile()) return saved;
  } catch {}
  return direct;
}

function printHelp(): void {
  process.stdout.write(`flowdex

Usage:
  flowdex preview <workflow.ts>
  flowdex run <workflow.ts> [--input JSON|@file] [--yes]
  flowdex init <code-audit|parallel-review|implementation-fanout> <workflow.ts>
  flowdex list
  flowdex resume <run-id>
  flowdex continue <run-id>
  flowdex inspect <run-id>
  flowdex report <run-id> [--path json.path] [--raw] [--paths]
  flowdex next <run-id> --json [--files] [--limit N]
  flowdex attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <id>
  flowdex complete-agent <run-id> <child-key> --lease-token <token> --result @file
  flowdex collect-results <run-id> [--continue] [--json]
  flowdex status <run-id> [--json] [--compact]
  flowdex watch <run-id>
  flowdex pause <run-id>
  flowdex stop <run-id>
  flowdex repair-events <run-id>
  flowdex restart-agent <run-id> <op-key>
  flowdex save <run-id> <name>
  flowdex workflow list
`);
}

function isFreshHeartbeat(value: unknown, maxAgeMs = 60_000): boolean {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
}

function collisionResistantSegment(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 72) || "task";
  return `${readable}-${sha256Bytes(value).slice(0, 16)}`;
}

function countTasks(tasks: AgentTaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function compactStatusTask(cwd: string, runId: string, task: AgentTaskRecord): Record<string, unknown> {
  const runRoot = path.join(cwd, ".flowdex", "runs", runId);
  return {
    childKey: task.childKey,
    taskId: task.taskId,
    phase: task.phase,
    adapter: task.adapter,
    mode: task.mode,
    status: task.status,
    cwd: task.contextCwd,
    leaseToken: task.leaseToken,
    leaseExpiresAt: task.leaseExpiresAt,
    agentRef: task.agentRef,
    resultPath: task.leaseToken ? nativeDispatchResultPath(runRoot, task.childKey, task.leaseToken) : undefined,
    adapterStatus: task.result?.status,
    summary: task.result?.summary,
    error: task.error ?? task.result?.error
  };
}

function listReportPaths(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined || typeof value !== "object") return prefix ? [prefix] : [];
  if (Array.isArray(value)) {
    const paths = prefix ? [prefix] : [];
    value.forEach((item, index) => paths.push(...listReportPaths(item, prefix ? `${prefix}.${index}` : String(index))));
    return paths;
  }
  const paths = prefix ? [prefix] : [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const escaped = key.includes(".") ? JSON.stringify(key) : key;
    paths.push(...listReportPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${escaped}` : escaped));
  }
  return paths;
}

function formatWatch(runId: string, run: Record<string, unknown> | undefined, tasks: AgentTaskRecord[]): string {
  const counts = countTasks(tasks);
  const lines = [
    `run: ${runId}`,
    `status: ${String(run?.status ?? "unknown")}`,
    `agents: total=${tasks.length} dispatchable=${counts.dispatchable ?? 0} leased=${counts.leased ?? 0} dispatched=${counts.dispatched ?? 0} completed=${counts.completed ?? 0} failed=${counts.failed ?? 0} blocked=${counts.blocked ?? 0}`
  ];
  const byPhase = new Map<string, AgentTaskRecord[]>();
  for (const task of tasks) {
    const items = byPhase.get(task.phase) ?? [];
    items.push(task);
    byPhase.set(task.phase, items);
  }
  for (const [phase, phaseTasks] of byPhase) {
    lines.push(`phase ${phase}: ${phaseTasks.length} task(s)`);
    for (const task of phaseTasks) {
      lines.push(`  ${task.childKey}\t${task.status}\t${task.adapter}\t${task.result?.summary ?? task.error ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
