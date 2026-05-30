import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NativeDispatch } from "../types.js";
import { stableStringify } from "../util/hash.js";

export interface NativeDispatchFilePackage {
  runId: string;
  childKey: string;
  parentOpKey: string;
  taskId: string;
  phase: string;
  adapter: string;
  mode: "read-only" | "write";
  cwd: string;
  leaseToken: string;
  leaseExpiresAt: string;
  instructionPath: string;
  taskPath: string;
  resultPath: string;
  agentPrompt: string;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  network?: "none" | "web" | undefined;
  role?: string | undefined;
  nickname?: string | undefined;
}

export async function writeNativeDispatchFilePackage(runRoot: string, dispatch: NativeDispatch): Promise<NativeDispatchFilePackage> {
  const dispatchRoot = nativeDispatchDirectory(runRoot, dispatch.childKey, dispatch.leaseToken);
  const taskPath = path.join(dispatchRoot, "task.json");
  const instructionPath = path.join(dispatchRoot, "instructions.md");
  const resultPath = path.join(dispatchRoot, "adapter-result.json");
  await mkdir(dispatchRoot, { recursive: true });
  await writeFile(taskPath, stableStringify(dispatch));
  await writeFile(instructionPath, buildNativeDispatchInstructions(dispatch, taskPath, resultPath));
  return {
    runId: dispatch.runId,
    childKey: dispatch.childKey,
    parentOpKey: dispatch.parentOpKey,
    taskId: dispatch.taskId,
    phase: dispatch.phase,
    adapter: dispatch.adapter,
    mode: dispatch.mode,
    cwd: dispatch.cwd,
    leaseToken: dispatch.leaseToken,
    leaseExpiresAt: dispatch.leaseExpiresAt,
    instructionPath,
    taskPath,
    resultPath,
    agentPrompt: `Read ${instructionPath} and complete that Flowdex worker task. Write only the AdapterResult JSON file requested there.`,
    ...(dispatch.model ? { model: dispatch.model } : {}),
    ...(dispatch.reasoningEffort ? { reasoningEffort: dispatch.reasoningEffort } : {}),
    ...(dispatch.network ? { network: dispatch.network } : {}),
    ...(dispatch.role ? { role: dispatch.role } : {}),
    ...(dispatch.nickname ? { nickname: dispatch.nickname } : {})
  };
}

export function nativeDispatchDirectory(runRoot: string, childKey: string, leaseToken: string): string {
  return path.join(nativeDispatchTaskDirectory(runRoot, childKey), safePathSegment(leaseToken));
}

export function nativeDispatchTaskDirectory(runRoot: string, childKey: string): string {
  return path.join(runRoot, "dispatches", safePathSegment(childKey));
}

export function nativeDispatchResultPath(runRoot: string, childKey: string, leaseToken: string): string {
  return path.join(nativeDispatchDirectory(runRoot, childKey, leaseToken), "adapter-result.json");
}

function buildNativeDispatchInstructions(dispatch: NativeDispatch, taskPath: string, resultPath: string): string {
  return [
    "# Flowdex Native Worker",
    "",
    "Read the task package JSON at:",
    "",
    `- ${taskPath}`,
    "",
    "Use the package fields as authoritative, especially `cwd`, `prompt`, and optional `data`.",
    "",
    `Child key: ${dispatch.childKey}`,
    `Task id: ${dispatch.taskId}`,
    `Role: ${dispatch.role ?? "unspecified"}`,
    `Mode: ${dispatch.mode}`,
    `Work in the package \`cwd\`: ${dispatch.cwd}`,
    `Network policy for this task: ${dispatch.network ?? "none"}.`,
    "",
    "Prompt:",
    "",
    dispatch.prompt,
    "",
    `Optional data keys: ${dispatch.data && typeof dispatch.data === "object" && !Array.isArray(dispatch.data) ? Object.keys(dispatch.data).join(", ") || "(none)" : "(none)"}`,
    "",
    "Do only that assigned task. Do not orchestrate unrelated work or spawn other agents.",
    "",
    "When finished, write a single AdapterResult JSON object to:",
    "",
    `- ${resultPath}`,
    "",
    "The JSON object must have exactly these top-level fields:",
    "",
    "```json",
    "{\"status\":\"completed\",\"summary\":\"...\",\"data\":{},\"claims\":[],\"artifacts\":[],\"diff\":null,\"usage\":{},\"error\":null}",
    "```",
    "",
    "`status` must be one of `completed`, `failed`, `blocked`, or `needs-approval`.",
    "Set `claims` and `artifacts` to empty arrays and `diff` to null unless you can provide valid Flowdex records.",
    "After writing the file, reply only with the result path and status."
  ].join("\n");
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 120) || "dispatch";
}
