export type CanonicalPrimitive = null | boolean | number | string;
export type CanonicalValue = CanonicalPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };

export interface WorkflowManifest {
  name: string;
  maxAgents: number;
  maxConcurrency: number;
  defaultAdapter?: string;
  adapters?: Record<string, AdapterConfig>;
  permissions: PermissionPolicy;
  phases: WorkflowPhase[];
}

export interface AdapterConfig {
  type: "codex-native";
  model?: string;
  reasoningEffort?: string;
}

export interface PermissionPolicy {
  read: string[];
  write: string[];
  hostCommands?: HostCommandSpec[];
  network?: "none" | "web";
  env?: {
    inherit: string[];
  };
}

export interface HostCommandSpec {
  id: string;
  argv: string[];
  cwd: "project";
  timeoutMs?: number;
}

export interface WorkflowPhase {
  id: string;
  maxAgents: number;
}

export interface ParsedWorkflow {
  manifest: WorkflowManifest;
  sourceHash: string;
  manifestHash: string;
  approvalHash: string;
  transformedJavaScript: string;
}

export interface TickInput {
  input: CanonicalValue;
  now: string;
  results: Record<string, CanonicalValue>;
  timeoutMs?: number;
}

export interface ScheduledOperation {
  kind: "agent" | "fanout" | "hostCommand" | "integrate";
  id: string;
  phase: string;
  args: CanonicalValue;
}

export type TickResult =
  | {
      status: "completed";
      value: CanonicalValue;
      staged: StagedEffects;
    }
  | {
      status: "pending";
      scheduled: ScheduledOperation[];
    }
  | {
      status: "failed" | "failed-timeout";
      error: string;
    };

export interface StagedEffects {
  claims: Claim[];
  artifacts: ArtifactProposal[];
  reports: CanonicalValue[];
}

export interface Claim {
  id: string;
  text: string;
  kind: "finding" | "change" | "verification" | "blocker" | "risk";
  confidence: "high" | "medium" | "low";
  evidence: EvidenceRef[];
}

export type EvidenceRef =
  | {
      type: "fileRange";
      path: string;
      startLine: number;
      endLine: number;
      contentHash: string;
    }
  | {
      type: "command";
      artifactId: string;
      command: string[];
      exitCode: number;
    }
  | {
      type: "test";
      artifactId: string;
      command: string[];
      exitCode: number;
      passed?: number;
      failed?: number;
    }
  | {
      type: "diffHunk";
      artifactId: string;
      file: string;
      hunkHash: string;
    }
  | {
      type: "agentResult";
      taskId: string;
      artifactId: string;
    }
  | {
      type: "schemaValidation";
      schema: string;
      artifactId: string;
      status: "passed" | "failed";
    };

export interface ArtifactProposal {
  name: string;
  mediaType: string;
  value: CanonicalValue;
}

export interface ArtifactRecord {
  id: string;
  sha256: string;
  mediaType: string;
  size: number;
  path: string;
  producer?: string;
  redactionStatus: "none" | "redacted";
}

export interface AdapterResult {
  status: "completed" | "failed" | "blocked" | "needs-approval";
  summary: string;
  data: CanonicalValue;
  claims: Claim[];
  artifacts: ArtifactRecord[];
  diff: null | CanonicalValue;
  usage: CanonicalValue;
  error: null | string;
}

export interface AgentTask {
  id: string;
  phase: string;
  mode: "read-only" | "write";
  prompt: string;
  schema?: string;
  adapter?: string;
  model?: string;
  reasoningEffort?: string;
  network?: "none" | "web";
  role?: string;
  nickname?: string;
  data?: CanonicalValue;
}

export type RunStatus = "completed" | "pending" | "failed" | "needs-dispatch" | "paused" | "stopped";

export type AgentTaskStatus = "pending" | "dispatchable" | "leased" | "dispatched" | "completed" | "failed" | "blocked";

export interface AgentTaskRecord {
  runId: string;
  childKey: string;
  parentOpKey: string;
  taskId: string;
  phase: string;
  adapter: string;
  mode: "read-only" | "write";
  orderIndex: number;
  status: AgentTaskStatus;
  task: CanonicalValue;
  contextCwd?: string | undefined;
  leaseToken?: string | undefined;
  leaseExpiresAt?: string | undefined;
  agentRef?: string | undefined;
  result?: AdapterResult | undefined;
  error?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface NativeDispatch {
  runId: string;
  childKey: string;
  parentOpKey: string;
  taskId: string;
  phase: string;
  adapter: string;
  mode: "read-only" | "write";
  prompt: string;
  schema?: string | undefined;
  data?: CanonicalValue | undefined;
  cwd: string;
  leaseToken: string;
  leaseExpiresAt: string;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  network?: "none" | "web" | undefined;
  role?: string | undefined;
  nickname?: string | undefined;
}
