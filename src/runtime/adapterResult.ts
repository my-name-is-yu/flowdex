import type { AdapterResult, AgentTaskStatus, ArtifactRecord, CanonicalValue, Claim, EvidenceRef } from "../types.js";
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
  for (const claim of canonical.claims) validateClaim(claim);
  for (const artifact of canonical.artifacts) validateArtifactRecord(artifact);
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

export function sanitizeAdapterResultForStorage(result: AdapterResult): AdapterResult {
  if (result.claims.length === 0 && result.artifacts.length === 0) return result;
  const data: Record<string, CanonicalValue> = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? { ...(result.data as Record<string, CanonicalValue>) }
    : { value: result.data };
  if (result.claims.length > 0) data.flowdexUntrustedClaims = result.claims as unknown as CanonicalValue;
  if (result.artifacts.length > 0) data.flowdexUntrustedArtifacts = result.artifacts as unknown as CanonicalValue;
  return {
    ...result,
    data,
    claims: [],
    artifacts: []
  };
}

function validateClaim(value: Claim): void {
  if (!value || typeof value !== "object") throw new Error("adapter claim must be an object");
  if (typeof value.id !== "string" || typeof value.text !== "string") throw new Error("adapter claim id/text must be strings");
  if (!["finding", "change", "verification", "blocker", "risk"].includes(value.kind)) throw new Error("adapter claim kind is invalid");
  if (!["high", "medium", "low"].includes(value.confidence)) throw new Error("adapter claim confidence is invalid");
  if (!Array.isArray(value.evidence)) throw new Error("adapter claim evidence must be an array");
  for (const evidence of value.evidence) validateEvidenceRef(evidence);
}

function validateEvidenceRef(value: EvidenceRef): void {
  if (!value || typeof value !== "object") throw new Error("adapter claim evidence must be an object");
  if (value.type === "fileRange") {
    if (typeof value.path !== "string" || !Number.isInteger(value.startLine) || !Number.isInteger(value.endLine) || typeof value.contentHash !== "string") {
      throw new Error("adapter fileRange evidence is invalid");
    }
    return;
  }
  if (value.type === "command" || value.type === "test") {
    if (typeof value.artifactId !== "string" || !Array.isArray(value.command) || !value.command.every((item) => typeof item === "string") || !Number.isInteger(value.exitCode)) {
      throw new Error("adapter command/test evidence is invalid");
    }
    return;
  }
  if (value.type === "diffHunk") {
    if (typeof value.artifactId !== "string" || typeof value.file !== "string" || typeof value.hunkHash !== "string") throw new Error("adapter diffHunk evidence is invalid");
    return;
  }
  if (value.type === "agentResult") {
    if (typeof value.taskId !== "string" || typeof value.artifactId !== "string") throw new Error("adapter agentResult evidence is invalid");
    return;
  }
  if (value.type === "schemaValidation") {
    if (typeof value.schema !== "string" || typeof value.artifactId !== "string" || (value.status !== "passed" && value.status !== "failed")) {
      throw new Error("adapter schemaValidation evidence is invalid");
    }
    return;
  }
  throw new Error("adapter evidence type is invalid");
}

function validateArtifactRecord(value: ArtifactRecord): void {
  if (!value || typeof value !== "object") throw new Error("adapter artifact must be an object");
  if (typeof value.id !== "string" || typeof value.sha256 !== "string" || typeof value.mediaType !== "string" || typeof value.size !== "number" || typeof value.path !== "string") {
    throw new Error("adapter artifact record is invalid");
  }
  if (value.redactionStatus !== "none" && value.redactionStatus !== "redacted") throw new Error("adapter artifact redactionStatus is invalid");
}
