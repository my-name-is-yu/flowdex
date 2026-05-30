import type { ArtifactRecord, Claim, EvidenceRef } from "../types.js";
import type { CanonicalValue } from "../types.js";
import type { SnapshotManifest } from "./snapshot.js";

export interface EvidenceContext {
  snapshots: SnapshotManifest[];
  artifacts: ArtifactRecord[];
  completedResults?: Record<string, CanonicalValue>;
}

export function verifyClaimEvidence(claim: Claim, context: EvidenceContext): { ok: true } | { ok: false; reason: string } {
  if (!claim.evidence.length) return { ok: false, reason: `claim ${claim.id} has no evidence` };
  for (const evidence of claim.evidence) {
    const result = verifyEvidence(evidence, context);
    if (!result.ok) return result;
  }
  return { ok: true };
}

export function filterReportableClaims(claims: Claim[], context: EvidenceContext): Claim[] {
  return claims.filter((claim) => verifyClaimEvidence(claim, context).ok);
}

function verifyEvidence(evidence: EvidenceRef, context: EvidenceContext): { ok: true } | { ok: false; reason: string } {
  switch (evidence.type) {
    case "fileRange": {
      const file = context.snapshots.flatMap((snapshot) => snapshot.files).find((candidate) => candidate.path === evidence.path);
      if (!file) return { ok: false, reason: `file evidence path not in snapshot: ${evidence.path}` };
      if (file.sha256 !== evidence.contentHash) return { ok: false, reason: `file evidence hash mismatch: ${evidence.path}` };
      if (evidence.startLine < 1 || evidence.endLine < evidence.startLine) return { ok: false, reason: `invalid line range: ${evidence.path}` };
      if (file.lineCount !== undefined && evidence.endLine > file.lineCount) return { ok: false, reason: `file evidence line range outside file: ${evidence.path}` };
      return { ok: true };
    }
    case "command":
    case "test": {
      const artifact = context.artifacts.find((candidate) => candidate.id === evidence.artifactId);
      if (!artifact) return { ok: false, reason: `artifact not found: ${evidence.artifactId}` };
      const commandResult = findHostCommandEvidence(evidence, context);
      if (!commandResult.ok) return commandResult;
      return { ok: true };
    }
    case "diffHunk":
    case "schemaValidation": {
      if (!context.artifacts.some((artifact) => artifact.id === evidence.artifactId)) {
        return { ok: false, reason: `artifact not found: ${evidence.artifactId}` };
      }
      return { ok: true };
    }
    case "agentResult": {
      if (!context.artifacts.some((artifact) => artifact.id === evidence.artifactId)) {
        return { ok: false, reason: `agent artifact not found: ${evidence.artifactId}` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: "unknown evidence type" };
  }
}

function findHostCommandEvidence(evidence: Extract<EvidenceRef, { type: "command" | "test" }>, context: EvidenceContext): { ok: true } | { ok: false; reason: string } {
  const results = Object.values(context.completedResults ?? {});
  for (const result of results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const record = result as Record<string, CanonicalValue>;
    const data = record.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const host = data as Record<string, CanonicalValue>;
    if (host.stdoutArtifactId !== evidence.artifactId && host.stderrArtifactId !== evidence.artifactId) continue;
    if (!Array.isArray(host.command) || !arraysEqual(host.command, evidence.command)) {
      return { ok: false, reason: `command evidence argv mismatch for artifact: ${evidence.artifactId}` };
    }
    if (host.exitCode !== evidence.exitCode) {
      return { ok: false, reason: `command evidence exitCode mismatch for artifact: ${evidence.artifactId}` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `command evidence does not match a host command result: ${evidence.artifactId}` };
}

function arraysEqual(left: CanonicalValue[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
