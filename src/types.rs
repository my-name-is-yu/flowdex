use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type CanonicalValue = Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowManifest {
    pub name: String,
    pub max_agents: u64,
    pub max_concurrency: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapters: Option<BTreeMap<String, AdapterConfig>>,
    pub permissions: PermissionPolicy,
    pub phases: Vec<WorkflowPhase>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterConfig {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicy {
    pub read: Vec<String>,
    pub write: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub host_commands: Vec<HostCommandSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<EnvPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvPolicy {
    pub inherit: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostCommandSpec {
    pub id: String,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPhase {
    pub id: String,
    pub max_agents: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDocument {
    pub version: String,
    pub manifest: WorkflowManifest,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowStep {
    HostCommand {
        id: String,
        phase: String,
        command_id: String,
    },
    Agent {
        id: String,
        phase: String,
        mode: String,
        prompt: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        adapter: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        network: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        nickname: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<CanonicalValue>,
    },
    Fanout {
        id: String,
        phase: String,
        tasks: Vec<AgentTask>,
    },
    Integrate {
        id: String,
        phase: String,
        patches: Vec<PatchSpec>,
    },
    Claim {
        id: String,
        claim: CanonicalValue,
    },
    Report {
        id: String,
        value: CanonicalValue,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchSpec {
    pub patch: CanonicalValue,
}

#[derive(Debug, Clone)]
pub struct ParsedWorkflow {
    pub manifest: WorkflowManifest,
    pub source_hash: String,
    pub manifest_hash: String,
    pub approval_hash: String,
    pub document: WorkflowDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledOperation {
    pub kind: String,
    pub id: String,
    pub phase: String,
    pub args: CanonicalValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum TickResult {
    #[serde(rename_all = "camelCase")]
    Completed {
        value: CanonicalValue,
        staged: StagedEffects,
    },
    #[serde(rename_all = "camelCase")]
    Pending { scheduled: Vec<ScheduledOperation> },
    #[serde(rename_all = "camelCase")]
    Failed { error: String },
    #[serde(rename = "failed-timeout", rename_all = "camelCase")]
    FailedTimeout { error: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StagedEffects {
    #[serde(default)]
    pub claims: Vec<Claim>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactProposal>,
    #[serde(default)]
    pub reports: Vec<CanonicalValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Claim {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub confidence: String,
    #[serde(default)]
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum EvidenceRef {
    #[serde(rename = "fileRange", rename_all = "camelCase")]
    FileRange {
        path: String,
        start_line: u64,
        end_line: u64,
        content_hash: String,
    },
    #[serde(rename = "command", rename_all = "camelCase")]
    Command {
        artifact_id: String,
        command: Vec<String>,
        exit_code: i64,
    },
    #[serde(rename = "test", rename_all = "camelCase")]
    Test {
        artifact_id: String,
        command: Vec<String>,
        exit_code: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        passed: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        failed: Option<u64>,
    },
    #[serde(rename = "diffHunk", rename_all = "camelCase")]
    DiffHunk {
        artifact_id: String,
        file: String,
        hunk_hash: String,
    },
    #[serde(rename = "agentResult", rename_all = "camelCase")]
    AgentResult {
        task_id: String,
        artifact_id: String,
    },
    #[serde(rename = "schemaValidation", rename_all = "camelCase")]
    SchemaValidation {
        schema: String,
        artifact_id: String,
        status: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProposal {
    pub name: String,
    pub media_type: String,
    pub value: CanonicalValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub sha256: String,
    pub media_type: String,
    pub size: u64,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    pub redaction_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AdapterResult {
    pub status: String,
    pub summary: String,
    pub data: CanonicalValue,
    pub claims: Vec<Claim>,
    pub artifacts: Vec<ArtifactRecord>,
    pub diff: CanonicalValue,
    pub usage: CanonicalValue,
    pub error: CanonicalValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub phase: String,
    pub mode: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<CanonicalValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskRecord {
    pub run_id: String,
    pub child_key: String,
    pub parent_op_key: String,
    pub task_id: String,
    pub phase: String,
    pub adapter: String,
    pub mode: String,
    pub order_index: i64,
    pub status: String,
    pub task: CanonicalValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<AdapterResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeDispatch {
    pub run_id: String,
    pub child_key: String,
    pub parent_op_key: String,
    pub task_id: String,
    pub phase: String,
    pub adapter: String,
    pub mode: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<CanonicalValue>,
    pub cwd: String,
    pub lease_token: String,
    pub lease_expires_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotFile {
    pub path: String,
    pub mode: u32,
    pub sha256: String,
    #[serde(rename = "sourceKind")]
    pub source_kind: String,
    pub size: u64,
    #[serde(rename = "lineCount")]
    pub line_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotManifest {
    pub root: String,
    pub files: Vec<SnapshotFile>,
    pub hash: String,
}
