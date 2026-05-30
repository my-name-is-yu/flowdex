import type { ParsedWorkflow } from "../types.js";
import { stableStringify } from "../util/hash.js";

export function formatPreview(parsed: ParsedWorkflow): string {
  return [
    `workflow: ${parsed.manifest.name}`,
    `sourceHash: ${parsed.sourceHash}`,
    `manifestHash: ${parsed.manifestHash}`,
    `approvalHash: ${parsed.approvalHash}`,
    `maxAgents: ${parsed.manifest.maxAgents}`,
    `maxConcurrency: ${parsed.manifest.maxConcurrency}`,
    `defaultAdapter: ${parsed.manifest.defaultAdapter ?? "codex-native"}`,
    `network: ${parsed.manifest.permissions.network ?? "none"}`,
    `read: ${parsed.manifest.permissions.read.join(", ")}`,
    `write: ${parsed.manifest.permissions.write.join(", ")}`,
    `phases: ${parsed.manifest.phases.map((phase) => `${phase.id}:${phase.maxAgents}`).join(", ")}`,
    `manifest: ${stableStringify(parsed.manifest)}`
  ].join("\n");
}
