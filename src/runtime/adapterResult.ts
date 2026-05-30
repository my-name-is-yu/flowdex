import type { AdapterResult, AgentTaskStatus } from "../types.js";
import { canonicalClone } from "../util/canonical.js";

const adapterResultFields = new Set(["status", "summary", "data", "claims", "artifacts", "diff", "usage", "error"]);

export function validateAdapterResult(value: unknown): AdapterResult {
  const canonical = canonicalClone(value) as unknown as AdapterResult;
  if (!canonical || typeof canonical !== "object") throw new Error("adapter result must be an object");
  for (const key of Object.keys(canonical)) {
    if (!adapterResultFields.has(key)) throw new Error(`unexpected adapter result field: ${key}`);
  }
  if (!["completed", "failed", "blocked", "needs-approval"].includes(canonical.status)) throw new Error("invalid adapter status");
  if (typeof canonical.summary !== "string") throw new Error("adapter summary must be string");
  if (!("data" in canonical)) throw new Error("adapter data is required");
  if (!Array.isArray(canonical.claims) || !Array.isArray(canonical.artifacts)) throw new Error("adapter claims/artifacts must be arrays");
  if (!("diff" in canonical)) throw new Error("adapter diff is required");
  if (!("usage" in canonical)) throw new Error("adapter usage is required");
  if (!("error" in canonical) || (canonical.error !== null && typeof canonical.error !== "string")) throw new Error("adapter error must be string or null");
  return canonical;
}

export function agentTaskStatusForResult(result: AdapterResult): AgentTaskStatus {
  if (result.status === "completed") return "completed";
  if (result.status === "blocked" || result.status === "needs-approval") return "blocked";
  return "failed";
}
