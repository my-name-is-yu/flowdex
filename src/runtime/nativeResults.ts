import { readdir, readFile, stat } from "node:fs/promises";
import { validateAdapterResult } from "./adapterResult.js";
import { FlowdexState } from "../store/state.js";
import { nativeDispatchResultPath, nativeDispatchTaskDirectory } from "./nativeDispatchFiles.js";

export type CollectResultStatus = "collected" | "missing" | "invalid" | "skipped" | "stale-result";

export interface CollectResult {
  childKey: string;
  taskId: string;
  status: CollectResultStatus;
  taskStatus: string;
  resultPath?: string | undefined;
  adapterStatus?: string | undefined;
  error?: string | undefined;
}

export async function collectNativeResultFiles(cwd: string, runId: string, state: FlowdexState): Promise<CollectResult[]> {
  const runRoot = FlowdexState.runDirectory(cwd, runId);
  const tasks = state.listAgentTasks(runId);
  const results: CollectResult[] = [];
  for (const task of tasks) {
    if (task.status !== "leased" && task.status !== "dispatched") {
      results.push({
        childKey: task.childKey,
        taskId: task.taskId,
        status: "skipped",
        taskStatus: task.status,
        ...(task.result ? { adapterStatus: task.result.status } : {})
      });
      continue;
    }
    if (!task.leaseToken) {
      results.push({
        childKey: task.childKey,
        taskId: task.taskId,
        status: "invalid",
        taskStatus: task.status,
        error: "leased task has no lease token"
      });
      continue;
    }
    const resultPath = nativeDispatchResultPath(runRoot, task.childKey, task.leaseToken);
    try {
      await stat(resultPath);
    } catch {
      const staleResultPath = await findStaleResultPath(runRoot, task.childKey, task.leaseToken);
      if (staleResultPath) {
        const error = "adapter-result.json exists for an older lease token";
        state.recordAgentTaskCollectionError(runId, task.childKey, error);
        results.push({
          childKey: task.childKey,
          taskId: task.taskId,
          status: "stale-result",
          taskStatus: task.status,
          resultPath: staleResultPath,
          error
        });
        continue;
      }
      state.recordAgentTaskCollectionError(runId, task.childKey, "adapter-result.json not found");
      results.push({
        childKey: task.childKey,
        taskId: task.taskId,
        status: "missing",
        taskStatus: task.status,
        resultPath,
        error: "adapter-result.json not found"
      });
      continue;
    }
    try {
      const result = validateAdapterResult(JSON.parse(await readFile(resultPath, "utf8")));
      state.completeAgentTask(runId, task.childKey, task.leaseToken, result);
      results.push({
        childKey: task.childKey,
        taskId: task.taskId,
        status: "collected",
        taskStatus: task.status,
        resultPath,
        adapterStatus: result.status
      });
    } catch (error) {
      state.recordAgentTaskCollectionError(runId, task.childKey, error instanceof Error ? error.message : String(error));
      results.push({
        childKey: task.childKey,
        taskId: task.taskId,
        status: "invalid",
        taskStatus: task.status,
        resultPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function findStaleResultPath(runRoot: string, childKey: string, currentLeaseToken: string | undefined): Promise<string | undefined> {
  const taskDirectory = nativeDispatchTaskDirectory(runRoot, childKey);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(taskDirectory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentLeaseToken) continue;
    const candidate = nativeDispatchResultPath(runRoot, childKey, entry.name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}
