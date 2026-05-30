import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterConfig, AdapterResult, AgentTask, CanonicalValue, ParsedWorkflow, RunStatus, ScheduledOperation, WorkflowManifest } from "../types.js";
import { parseWorkflowSource } from "../policy/manifest.js";
import { ArtifactStore } from "../store/artifacts.js";
import { FlowdexState } from "../store/state.js";
import { canonicalClone } from "../util/canonical.js";
import { stableStringify } from "../util/hash.js";
import { runHostCommand } from "./hostCommand.js";
import { operationKey, runSandboxTick } from "./sandbox.js";
import type { SnapshotManifest } from "./snapshot.js";
import { filterReportableClaims } from "./evidence.js";
import { applyPatches } from "./writeIntegration.js";
import { formatPreview } from "./preview.js";

export { formatPreview } from "./preview.js";

const SNAPSHOT_MANIFEST_FILE = ".flowdex-snapshot.json";

export interface RuntimeOptions {
  cwd: string;
  input?: CanonicalValue;
  runId?: string;
  autoApprove?: boolean;
  maxTicks?: number;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  report?: CanonicalValue | undefined;
  parsed: ParsedWorkflow;
}

export class FlowdexRuntime {
  constructor(readonly options: RuntimeOptions) {}

  async preview(workflowPath: string): Promise<ParsedWorkflow> {
    const source = await readFile(workflowPath, "utf8");
    return parseWorkflowSource(source, workflowPath);
  }

  async run(workflowPath: string): Promise<RunSummary> {
    const source = await readFile(workflowPath, "utf8");
    const parsed = parseWorkflowSource(source, workflowPath);
    if (!this.options.autoApprove) {
      throw new Error(`Flowdex approval required. Re-run with --yes after reviewing:\n${formatPreview(parsed)}`);
    }
    const input = this.options.input ?? {};
    const runId = this.options.runId ?? createRunId(parsed.manifest.name);
    if (await FlowdexState.runDirectoryExists(this.options.cwd, runId)) {
      throw new Error(`Flowdex run already exists: ${runId}`);
    }
    const runRoot = path.join(this.options.cwd, ".flowdex", "runs", runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(path.join(runRoot, "workflow.ts"), source);
    await writeFile(path.join(runRoot, "input.json"), stableStringify(input));
    const artifactStore = new ArtifactStore(path.join(runRoot, "artifacts"));
    const state = await FlowdexState.openRun(this.options.cwd, runId);
    state.createRun({
      id: runId,
      manifest: parsed.manifest,
      sourceHash: parsed.sourceHash,
      manifestHash: parsed.manifestHash,
      approvalHash: parsed.approvalHash
    });
    try {
      return await this.driveRun(runId, runRoot, parsed, input, artifactStore, state);
    } finally {
      state.close();
    }
  }

  async resume(runId: string): Promise<RunSummary> {
    const runRoot = FlowdexState.runDirectory(this.options.cwd, runId);
    const source = await readFile(path.join(runRoot, "workflow.ts"), "utf8");
    const parsed = parseWorkflowSource(source, path.join(runRoot, "workflow.ts"));
    const input = JSON.parse(await readFile(path.join(runRoot, "input.json"), "utf8")) as CanonicalValue;
    const artifactStore = new ArtifactStore(path.join(runRoot, "artifacts"));
    const state = await FlowdexState.openRun(this.options.cwd, runId);
    try {
      const run = state.getRun(runId);
      if (!run) throw new Error(`unknown Flowdex run: ${runId}`);
      const hashMismatch =
        String(run.source_hash) !== parsed.sourceHash ||
        String(run.manifest_hash) !== parsed.manifestHash ||
        String(run.approval_hash) !== parsed.approvalHash;
      if (hashMismatch) {
        state.setRunStatus(runId, "failed");
        state.addEvent(runId, "workflow.failed", { error: "run package hash mismatch; refusing to resume modified workflow" });
        return { runId, status: "failed", parsed };
      }
      const currentStatus = state.getRunStatus(runId);
      if (currentStatus === "paused" || currentStatus === "stopped") {
        state.addEvent(runId, "workflow.suspended", { status: currentStatus });
        return { runId, status: currentStatus, parsed };
      }
      if (currentStatus === "completed") {
        return { runId, status: "completed", report: state.getLatestCompletedReport(runId) as CanonicalValue | undefined, parsed };
      }
      if (currentStatus === "failed" || currentStatus === "failed-timeout") {
        return { runId, status: "failed", parsed };
      }
      state.setRunStatus(runId, "running");
      return await this.driveRun(runId, runRoot, parsed, input, artifactStore, state);
    } finally {
      state.close();
    }
  }

  private async driveRun(
    runId: string,
    runRoot: string,
    parsed: ParsedWorkflow,
    input: CanonicalValue,
    artifactStore: ArtifactStore,
    state: FlowdexState
  ): Promise<RunSummary> {
    let status: RunStatus = "pending";
    let report: CanonicalValue | undefined;
    try {
      for (let tick = 0; tick < (this.options.maxTicks ?? 20); tick++) {
        const currentStatus = state.getRunStatus(runId);
        if (currentStatus === "paused" || currentStatus === "stopped") {
          state.addEvent(runId, "workflow.suspended", { status: currentStatus });
          status = currentStatus;
          break;
        }
        state.heartbeat(runId);
        const tickResult = await runSandboxTick(parsed.transformedJavaScript, {
          input,
          now: new Date().toISOString(),
          results: state.getCompletedResults(runId)
        });
        if (tickResult.status === "completed") {
          report = await this.buildVerifiedReport(tickResult.staged.claims, tickResult.staged.reports.at(-1) ?? tickResult.value, state, runId, runRoot);
          state.setRunStatus(runId, "completed");
          state.addEvent(runId, "workflow.completed", report);
          status = "completed";
          break;
        } else if (tickResult.status === "failed" || tickResult.status === "failed-timeout") {
          state.setRunStatus(runId, tickResult.status);
          state.addEvent(runId, "workflow.failed", { error: tickResult.error });
          status = "failed";
          break;
        } else if (tickResult.status === "pending") {
          state.addEvent(runId, "workflow.pending", tickResult.scheduled);
          let needsDispatch = false;
          for (const operation of tickResult.scheduled) {
            const result = await this.completeOperation(runId, runRoot, parsed.manifest, operation, artifactStore, state);
            if (result === "needs-dispatch") needsDispatch = true;
          }
          if (needsDispatch) {
            state.setRunStatus(runId, "needs-dispatch");
            status = "needs-dispatch";
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      state.setRunStatus(runId, "failed");
      state.addEvent(runId, "workflow.failed", { error: message });
      return { runId, status: "failed", report, parsed };
    }
    if (status === "pending") {
      state.setRunStatus(runId, "pending");
      state.addEvent(runId, "workflow.pending", { reason: "tick-budget-exhausted", maxTicks: this.options.maxTicks ?? 20 });
    }
    return { runId, status, report, parsed };
  }

  private async completeOperation(
    runId: string,
    runRoot: string,
    manifest: WorkflowManifest,
    operation: ScheduledOperation,
    artifactStore: ArtifactStore,
    state: FlowdexState
  ): Promise<"completed" | "needs-dispatch"> {
    const key = operationKey(operation);
    if (operation.kind === "hostCommand") {
      const args = operation.args as { commandId?: string };
      const spec = manifest.permissions.hostCommands?.find((candidate) => candidate.id === args.commandId);
      if (!spec) {
        state.saveTaskResult(runId, key, "completed", { status: "needs-approval", error: `host command not allowlisted: ${args.commandId ?? ""}` });
        return "completed";
      }
      const result = await runHostCommand(spec, this.options.cwd, artifactStore, manifest.permissions.env?.inherit ?? []);
      for (const artifact of result.artifacts) state.saveArtifact(runId, artifact);
      state.saveTaskResult(runId, key, "completed", { status: result.status, data: result.data });
      return "completed";
    }

    if (operation.kind === "agent") {
      const task = this.validateTask(operation.args, manifest);
      return await this.completeAgentChild(runId, runRoot, manifest, state, key, key, task, 0);
    }

    if (operation.kind === "fanout") {
      const args = operation.args as { tasks?: unknown };
      const tasks = this.validateFanoutTasks(args.tasks ?? [], manifest, key);
      const completions = await runWithConcurrency(
        tasks.map((task, index) => async () => await this.completeAgentChild(runId, runRoot, manifest, state, key, fanoutChildKey(operation.id, task.id), task, index)),
        manifest.maxConcurrency
      );
      if (completions.includes("needs-dispatch")) return "needs-dispatch";
      const records = state.listAgentTasks(runId, key);
      if (records.length !== tasks.length || records.some((record) => !record.result)) return "needs-dispatch";
      const ordered = records.sort((a, b) => a.orderIndex - b.orderIndex).map((record) => record.result as AdapterResult);
      state.saveTaskResult(runId, key, "completed", ordered);
      return "completed";
    }

    if (operation.kind === "integrate") {
      const args = operation.args as unknown as { patches?: Array<{ patch?: string }> };
      const patches = args.patches ?? [];
      applyPatches(
        this.options.cwd,
        patches.map((patch) => {
          if (!patch.patch) throw new Error("integrate patch entry is missing patch text");
          return patch.patch;
        }),
        manifest.permissions.write
      );
      state.saveTaskResult(runId, key, "completed", { status: "completed", applied: patches.length });
      return "completed";
    }

    throw new Error(`unsupported scheduled operation: ${(operation as { kind?: string }).kind ?? "unknown"}`);
  }

  private async completeAgentChild(
    runId: string,
    runRoot: string,
    manifest: WorkflowManifest,
    state: FlowdexState,
    parentOpKey: string,
    childKey: string,
    task: AgentTask,
    orderIndex: number
  ): Promise<"completed" | "needs-dispatch"> {
    const adapterConfig = this.resolveAdapterConfig(task.adapter, manifest);
    enforceAgentBudget(runId, childKey, task.phase, manifest, state);
    const existing = state.ensureAgentTask({
      runId,
      childKey,
      parentOpKey,
      taskId: task.id,
      phase: task.phase,
      adapter: adapterConfig.name,
      mode: task.mode,
      orderIndex,
      task: taskWithDispatchDefaults(task, adapterConfig, manifest)
    });
    if (existing.result || existing.status === "completed" || existing.status === "failed" || existing.status === "blocked") {
      state.ensureSingleAgentTaskResult(runId, childKey);
      return "completed";
    }
    if (existing.status === "dispatchable" || existing.status === "leased" || existing.status === "dispatched") return "needs-dispatch";
    if (task.mode === "write") {
      const result = blockedResult(task, "codex-native write tasks are disabled; use read-only native workers and explicit ctx.integrate patches");
      state.updateAgentTaskStatus(runId, childKey, "blocked", { result });
      if (parentOpKey === childKey) state.saveTaskResult(runId, parentOpKey, "completed", result);
      return "completed";
    }
    state.markAgentDispatchable(runId, childKey);
    return "needs-dispatch";
  }

  private resolveAdapterConfig(name: string | undefined, manifest: WorkflowManifest): AdapterConfig & { name: string } {
    const requested = name ?? manifest.defaultAdapter ?? "codex-native";
    const configured = manifest.adapters?.[requested];
    if (configured) return { ...configured, name: requested };
    if (isBuiltInAdapter(requested)) return { type: requested, name: requested };
    throw new Error(`unknown adapter: ${requested}`);
  }

  private validateTask(value: CanonicalValue, manifest: WorkflowManifest): AgentTask {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent task must be an object");
    const task = value as unknown as AgentTask;
    if (!isSafeId(task.id)) throw new Error(`agent task id is unsafe: ${String(task.id ?? "")}`);
    if (typeof task.phase !== "string" || !manifest.phases.some((phase) => phase.id === task.phase)) throw new Error(`unknown task phase: ${String(task.phase ?? "")}`);
    if (task.mode !== "read-only" && task.mode !== "write") throw new Error(`invalid task mode for ${task.id}`);
    if (typeof task.prompt !== "string" || task.prompt.length === 0) throw new Error(`agent task prompt is required: ${task.id}`);
    if (task.model !== undefined && typeof task.model !== "string") throw new Error(`agent task model must be a string: ${task.id}`);
    if (task.reasoningEffort !== undefined && typeof task.reasoningEffort !== "string") throw new Error(`agent task reasoningEffort must be a string: ${task.id}`);
    if (task.adapter) this.resolveAdapterConfig(task.adapter, manifest);
    return task;
  }

  private validateFanoutTasks(values: unknown, manifest: WorkflowManifest, parentOpKey: string): AgentTask[] {
    if (!Array.isArray(values)) throw new Error("fanout.tasks must be an array");
    if (values.length > manifest.maxAgents) throw new Error(`fanout task count exceeds manifest.maxAgents for ${parentOpKey}`);
    const seen = new Set<string>();
    const perPhase = new Map<string, number>();
    const tasks = values.map((value) => this.validateTask(value, manifest));
    for (const task of tasks) {
      if (seen.has(task.id)) throw new Error(`duplicate fanout task id: ${task.id}`);
      seen.add(task.id);
      perPhase.set(task.phase, (perPhase.get(task.phase) ?? 0) + 1);
    }
    for (const phase of manifest.phases) {
      const count = perPhase.get(phase.id) ?? 0;
      if (count > phase.maxAgents) throw new Error(`fanout phase ${phase.id} exceeds maxAgents`);
    }
    return tasks;
  }

  private async buildVerifiedReport(
    claims: import("../types.js").Claim[],
    rawReport: CanonicalValue,
    state: FlowdexState,
    runId: string,
    runRoot: string
  ): Promise<CanonicalValue> {
    if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport) || !("claimIds" in rawReport)) {
      return canonicalClone(rawReport);
    }
    const claimIds = (rawReport as { claimIds?: unknown }).claimIds;
    if (!Array.isArray(claimIds) || !claimIds.every((id) => typeof id === "string")) {
      throw new Error("report.claimIds must be an array of strings");
    }
    const reportable = filterReportableClaims(claims, {
      snapshots: await readSnapshotManifests(runRoot),
      artifacts: state.listArtifacts(runId),
      completedResults: state.getCompletedResults(runId)
    });
    const byId = new Map(reportable.map((claim) => [claim.id, claim]));
    const selected = claimIds.map((id) => byId.get(id)).filter((claim): claim is import("../types.js").Claim => !!claim);
    if (selected.length !== claimIds.length) {
      throw new Error("report references claims that are not host-verified");
    }
    return canonicalClone({ ...(rawReport as Record<string, CanonicalValue>), claims: selected });
  }

}

export function createRunId(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}`;
}

function fanoutChildKey(fanoutId: string, taskId: string): string {
  return `fanout:${fanoutId}#${taskId}`;
}

function isBuiltInAdapter(value: string): value is AdapterConfig["type"] {
  return value === "codex-native";
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(value);
}

function blockedResult(task: AgentTask, reason: string): AdapterResult {
  return {
    status: "blocked",
    summary: `Blocked ${task.id}`,
    data: {},
    claims: [],
    artifacts: [],
    diff: null,
    usage: {},
    error: reason
  };
}

function taskWithDispatchDefaults(task: AgentTask, adapterConfig: AdapterConfig & { name: string }, manifest: WorkflowManifest): AgentTask {
  return {
    ...task,
    ...(task.model === undefined && adapterConfig.model !== undefined ? { model: adapterConfig.model } : {}),
    ...(task.reasoningEffort === undefined && adapterConfig.reasoningEffort !== undefined ? { reasoningEffort: adapterConfig.reasoningEffort } : {}),
    network: manifest.permissions.network ?? "none"
  };
}

function enforceAgentBudget(runId: string, childKey: string, phaseId: string, manifest: WorkflowManifest, state: FlowdexState): void {
  const existing = state.listAgentTasks(runId).filter((task) => task.childKey !== childKey);
  if (existing.length >= manifest.maxAgents) {
    throw new Error(`agent task count exceeds manifest.maxAgents for run ${runId}`);
  }
  const phase = manifest.phases.find((candidate) => candidate.id === phaseId);
  const phaseLimit = phase?.maxAgents ?? 0;
  if (existing.filter((task) => task.phase === phaseId).length >= phaseLimit) {
    throw new Error(`agent task count exceeds phase maxAgents for phase ${phaseId}`);
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

async function readSnapshotManifests(runRoot: string): Promise<SnapshotManifest[]> {
  const snapshotsRoot = path.join(runRoot, "snapshots");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(snapshotsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests: SnapshotManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(snapshotsRoot, entry.name, SNAPSHOT_MANIFEST_FILE);
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
      if (!Array.isArray(manifest.files)) throw new Error("snapshot manifest files must be an array");
      manifests.push(manifest);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return manifests;
}
