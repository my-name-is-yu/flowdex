export { parseWorkflowSource } from "./policy/manifest.js";
export { validateWorkflowBody } from "./policy/bodyPolicy.js";
export { runSandboxTick } from "./runtime/sandbox.js";
export { buildSnapshot } from "./runtime/snapshot.js";
export { formatPreview } from "./runtime/preview.js";
export { verifyClaimEvidence, filterReportableClaims } from "./runtime/evidence.js";
export { canonicalClone, assertCanonical, CanonicalError } from "./util/canonical.js";
export type * from "./types.js";

import type { AgentTask, CanonicalValue, Claim, WorkflowManifest } from "./types.js";

export interface WorkflowAuthoringContext {
  input: CanonicalValue;
  pendingSignal: "FlowdexPending";
  now(): string;
  isFlowdexPending(error: unknown): boolean;
  agent(args: AgentTask): Promise<CanonicalValue>;
  fanout(args: { id: string; phase: string; tasks: AgentTask[] }): Promise<CanonicalValue>;
  hostCommand(args: { id: string; phase: string; commandId: string }): Promise<CanonicalValue>;
  integrate(args: { id: string; phase: string; patches: Array<{ patch: string }> }): Promise<CanonicalValue>;
  claim(claim: Claim): void;
  report(report: CanonicalValue): CanonicalValue;
}

export interface WorkflowDefinition {
  manifest: WorkflowManifest;
  callback: (ctx: WorkflowAuthoringContext) => Promise<CanonicalValue | void>;
}

export function workflow(manifest: WorkflowManifest, callback: WorkflowDefinition["callback"]): WorkflowDefinition {
  return { manifest, callback };
}
