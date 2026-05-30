import type { ArtifactRecord, Claim, EvidenceRef } from "../types.js";
import type { SnapshotManifest } from "./snapshot.js";

export interface EvidenceContext {
  snapshots: SnapshotManifest[];
  artifacts: ArtifactRecord[];
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
      return { ok: true };
    }
    case "command":
    case "test":
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
