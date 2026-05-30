import { readFile, stat } from "node:fs/promises";
import { validateAdapterResult } from "./adapterResult.js";
import { FlowdexState } from "../store/state.js";
import { nativeDispatchResultPath } from "./nativeDispatchFiles.js";

export type CollectResultStatus = "collected" | "missing" | "invalid" | "skipped";

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
