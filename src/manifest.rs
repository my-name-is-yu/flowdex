use crate::canonical::{
    canonicalize, hash_canonical, sha256_bytes, stable_stringify, to_canonical_value,
};
use crate::sandbox::operation_key_for_parts;
use crate::types::{AgentTask, ParsedWorkflow, WorkflowDocument, WorkflowManifest, WorkflowStep};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub const WORKFLOW_FORMAT_VERSION: &str = "flowdex.workflow.v1";
pub const WORKFLOW_FILE_SUFFIX: &str = ".flowdex.json";

const SNAPSHOT_POLICY_VERSION: &str = "flowdex-snapshot-policy-v0.5.0-rust";
const EVIDENCE_POLICY_VERSION: &str = "flowdex-evidence-policy-v0.5.0-rust";
const RUNTIME_VERSION: &str = "flowdex-runtime-v0.1.0-rust";
const STATIC_PARSER_VERSION: &str = "flowdex-static-parser-v1";
const STATIC_EVALUATOR_VERSION: &str = "flowdex-static-evaluator-v1";

pub fn parse_workflow_document(source: &str, file_name: &str) -> Result<ParsedWorkflow> {
    if !has_workflow_source_file_name(file_name) {
        bail!("{file_name}: workflow source file name must end in {WORKFLOW_FILE_SUFFIX}");
    }
    if source.trim_start().starts_with("import ") {
        bail!("{file_name}: workflow source must be a static {WORKFLOW_FILE_SUFFIX} document");
    }
    let document_value = canonicalize(&json5::from_str::<Value>(source)?)?;
    let document: WorkflowDocument = serde_json::from_value(document_value.clone())?;
    validate_workflow_document(&document, file_name)?;
    parsed_workflow_from_document(source.as_bytes(), document)
}

fn has_workflow_source_file_name(file_name: &str) -> bool {
    file_name.ends_with(WORKFLOW_FILE_SUFFIX)
}

pub fn parse_run_workflow_source(source: &str, file_name: &str) -> Result<ParsedWorkflow> {
    parse_workflow_document(source, file_name)
}

pub fn parse_workflow_source(source: &str, file_name: &str) -> Result<ParsedWorkflow> {
    parse_workflow_document(source, file_name)
}

fn parsed_workflow_from_document(
    source_bytes: &[u8],
    document: WorkflowDocument,
) -> Result<ParsedWorkflow> {
    let manifest_value = to_canonical_value(&document.manifest)?;
    let steps_value = to_canonical_value(&document.steps)?;
    let source_hash = sha256_bytes(source_bytes);
    let manifest_hash = hash_canonical(&manifest_value)?;
    let approval_payload = json!({
        "sourceHash": source_hash,
        "manifestHash": manifest_hash,
        "stepsHash": hash_canonical(&steps_value)?,
        "workflowFormatVersion": WORKFLOW_FORMAT_VERSION,
        "parserVersion": STATIC_PARSER_VERSION,
        "evaluatorVersion": STATIC_EVALUATOR_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "snapshotPolicyVersion": SNAPSHOT_POLICY_VERSION,
        "evidencePolicyVersion": EVIDENCE_POLICY_VERSION,
        "permissionCapabilityPolicyHash": hash_canonical(&to_canonical_value(&document.manifest.permissions)?)?,
        "adapterPolicyHash": hash_canonical(&to_canonical_value(&document.manifest.adapters)?)?
    });
    let approval_hash = sha256_bytes(stable_stringify(&approval_payload)?);
    Ok(ParsedWorkflow {
        manifest: document.manifest.clone(),
        source_hash,
        manifest_hash,
        approval_hash,
        document,
    })
}

pub fn format_preview(parsed: &ParsedWorkflow) -> Result<String> {
    let manifest = &parsed.manifest;
    let default_adapter = manifest
        .default_adapter
        .clone()
        .unwrap_or_else(|| "codex-native".to_string());
    let network = manifest
        .permissions
        .network
        .clone()
        .unwrap_or_else(|| "none".to_string());
    let phases = manifest
        .phases
        .iter()
        .map(|phase| format!("{}({})", phase.id, phase.max_agents))
        .collect::<Vec<_>>()
        .join(", ");
    let steps = parsed
        .document
        .steps
        .iter()
        .map(step_summary)
        .collect::<Vec<_>>()
        .join(", ");
    let manifest_json = stable_stringify(&to_canonical_value(manifest)?)?;
    Ok(format!(
        "Flowdex preview\nworkflow: {}\nformat: {}\nsourceHash: {}\nmanifestHash: {}\napprovalHash: {}\nmaxAgents: {}\nmaxConcurrency: {}\ndefaultAdapter: {}\nnetwork: {}\nread: {}\nwrite: {}\nphases: {}\nsteps: {}\nmanifest: {}",
        manifest.name,
        parsed.document.version,
        parsed.source_hash,
        parsed.manifest_hash,
        parsed.approval_hash,
        manifest.max_agents,
        manifest.max_concurrency,
        default_adapter,
        network,
        manifest.permissions.read.join(", "),
        manifest.permissions.write.join(", "),
        phases,
        steps,
        manifest_json
    ))
}

fn step_summary(step: &WorkflowStep) -> String {
    match step {
        WorkflowStep::HostCommand { id, .. } => format!("hostCommand:{id}"),
        WorkflowStep::Agent { id, .. } => format!("agent:{id}"),
        WorkflowStep::Fanout { id, tasks, .. } => format!("fanout:{id}[{}]", tasks.len()),
        WorkflowStep::Integrate { id, .. } => format!("integrate:{id}"),
        WorkflowStep::Claim { id, .. } => format!("claim:{id}"),
        WorkflowStep::Report { id, .. } => format!("report:{id}"),
    }
}

pub fn validate_manifest_shape(manifest: &WorkflowManifest) -> Result<()> {
    if manifest.name.is_empty() {
        bail!("manifest.name must be a non-empty string");
    }
    if manifest.max_agents == 0 || manifest.max_agents > 1000 {
        bail!("manifest.maxAgents must be 1..1000");
    }
    if manifest.max_concurrency == 0 || manifest.max_concurrency > 16 {
        bail!("manifest.maxConcurrency must be 1..16");
    }
    if manifest.permissions.read.is_empty() && manifest.permissions.write.is_empty() {
        bail!("manifest.permissions.read/write arrays are required");
    }
    for item in manifest
        .permissions
        .read
        .iter()
        .chain(manifest.permissions.write.iter())
    {
        if item.is_empty() || item.contains('\0') {
            bail!("manifest permission entries must be non-empty strings");
        }
    }
    if let Some(network) = &manifest.permissions.network
        && network != "none"
        && network != "web"
    {
        bail!("manifest.permissions.network must be none or web");
    }
    let mut command_ids = HashSet::new();
    for command in &manifest.permissions.host_commands {
        if !is_safe_id(&command.id) || !command_ids.insert(command.id.clone()) {
            bail!("host command id must be safe and unique");
        }
        if command.argv.is_empty() || command.argv.iter().any(String::is_empty) {
            bail!("host command argv must be a non-empty string array");
        }
        if command.cwd != "project" {
            bail!("host command cwd must be project");
        }
    }
    let mut phases = HashSet::new();
    if manifest.phases.is_empty() {
        bail!("manifest.phases must be a non-empty array");
    }
    for phase in &manifest.phases {
        if !is_safe_id(&phase.id) || phase.max_agents == 0 || !phases.insert(phase.id.clone()) {
            bail!("each manifest phase needs a unique safe id and maxAgents");
        }
    }
    if let Some(adapters) = &manifest.adapters {
        for (name, adapter) in adapters {
            if !is_safe_id(name) || adapter.kind != "codex-native" {
                bail!("only codex-native adapters are supported");
            }
        }
    }
    if let Some(default_adapter) = &manifest.default_adapter {
        let known = default_adapter == "codex-native"
            || manifest
                .adapters
                .as_ref()
                .is_some_and(|adapters| adapters.contains_key(default_adapter));
        if !known {
            bail!("manifest.defaultAdapter references unknown adapter: {default_adapter}");
        }
    }
    Ok(())
}

fn validate_workflow_document(document: &WorkflowDocument, file_name: &str) -> Result<()> {
    if document.version != WORKFLOW_FORMAT_VERSION {
        bail!("{file_name}: version must be {WORKFLOW_FORMAT_VERSION}");
    }
    validate_manifest_shape(&document.manifest)?;
    let phases = document
        .manifest
        .phases
        .iter()
        .map(|phase| phase.id.as_str())
        .collect::<HashSet<_>>();
    let command_ids = document
        .manifest
        .permissions
        .host_commands
        .iter()
        .map(|command| command.id.as_str())
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    let mut prior_operations = HashSet::new();
    for step in &document.steps {
        let step_id = step_id(step);
        if !is_safe_id(step_id) || !seen_ids.insert(step_id.to_string()) {
            bail!("{file_name}: step ids must be unique safe ids");
        }
        match step {
            WorkflowStep::HostCommand {
                id,
                phase,
                command_id,
            } => {
                ensure_phase(&phases, phase)?;
                if !command_ids.contains(command_id.as_str()) {
                    bail!("{file_name}: unknown host command id: {command_id}");
                }
                prior_operations.insert(operation_key_for_parts("hostCommand", id));
            }
            WorkflowStep::Agent {
                id,
                phase,
                mode,
                prompt,
                schema,
                adapter,
                model,
                reasoning_effort,
                network,
                role,
                nickname,
                data,
            } => {
                ensure_phase(&phases, phase)?;
                validate_agent_task(
                    &AgentTask {
                        id: id.clone(),
                        phase: phase.clone(),
                        mode: mode.clone(),
                        prompt: prompt.clone(),
                        schema: schema.clone(),
                        adapter: adapter.clone(),
                        model: model.clone(),
                        reasoning_effort: reasoning_effort.clone(),
                        network: network.clone(),
                        role: role.clone(),
                        nickname: nickname.clone(),
                        data: data.clone(),
                    },
                    &document.manifest,
                )?;
                if let Some(data) = data {
                    validate_references(data, &prior_operations)?;
                }
                prior_operations.insert(operation_key_for_parts("agent", id));
            }
            WorkflowStep::Fanout { id, phase, tasks } => {
                ensure_phase(&phases, phase)?;
                validate_fanout_tasks(tasks, &document.manifest)?;
                for task in tasks {
                    if let Some(data) = &task.data {
                        validate_references(data, &prior_operations)?;
                    }
                }
                prior_operations.insert(operation_key_for_parts("fanout", id));
            }
            WorkflowStep::Integrate { id, phase, patches } => {
                ensure_phase(&phases, phase)?;
                for entry in patches {
                    validate_references(&entry.patch, &prior_operations)?;
                }
                prior_operations.insert(operation_key_for_parts("integrate", id));
            }
            WorkflowStep::Claim { claim, .. } => {
                validate_references(claim, &prior_operations)?;
            }
            WorkflowStep::Report { value, .. } => {
                validate_references(value, &prior_operations)?;
            }
        }
    }
    Ok(())
}

fn ensure_phase(phases: &HashSet<&str>, phase: &str) -> Result<()> {
    if !phases.contains(phase) {
        bail!("unknown workflow phase: {phase}");
    }
    Ok(())
}

fn validate_agent_task(task: &AgentTask, manifest: &WorkflowManifest) -> Result<()> {
    if !is_safe_id(&task.id) {
        bail!("agent task id is unsafe: {}", task.id);
    }
    if !manifest.phases.iter().any(|phase| phase.id == task.phase) {
        bail!("unknown task phase: {}", task.phase);
    }
    if task.mode != "read-only" && task.mode != "write" {
        bail!("invalid task mode for {}", task.id);
    }
    if task.prompt.is_empty() {
        bail!("agent task prompt is required: {}", task.id);
    }
    if let Some(adapter) = &task.adapter {
        validate_adapter_name(adapter, manifest)?;
    }
    Ok(())
}

fn validate_fanout_tasks(tasks: &[AgentTask], manifest: &WorkflowManifest) -> Result<()> {
    if tasks.len() as u64 > manifest.max_agents {
        bail!("fanout task count exceeds manifest.maxAgents");
    }
    let mut seen = HashSet::new();
    let mut per_phase = BTreeMap::<String, u64>::new();
    for task in tasks {
        validate_agent_task(task, manifest)?;
        if !seen.insert(task.id.clone()) {
            bail!("duplicate fanout task id: {}", task.id);
        }
        *per_phase.entry(task.phase.clone()).or_default() += 1;
    }
    for phase in &manifest.phases {
        if per_phase.get(&phase.id).copied().unwrap_or(0) > phase.max_agents {
            bail!("fanout phase {} exceeds maxAgents", phase.id);
        }
    }
    Ok(())
}

fn validate_adapter_name(name: &str, manifest: &WorkflowManifest) -> Result<()> {
    let known = name == "codex-native"
        || manifest
            .adapters
            .as_ref()
            .is_some_and(|adapters| adapters.contains_key(name));
    if !known {
        bail!("unknown adapter: {name}");
    }
    Ok(())
}

fn validate_references(value: &Value, prior_operations: &HashSet<String>) -> Result<()> {
    match value {
        Value::Array(items) => {
            for item in items {
                validate_references(item, prior_operations)?;
            }
        }
        Value::Object(object) => {
            if let Some(result) = object.get("$result") {
                let key = result
                    .as_str()
                    .ok_or_else(|| anyhow!("$result must be an operation key string"))?;
                if !prior_operations.contains(key) {
                    bail!("reference points to an undeclared or later operation: {key}");
                }
                if let Some(path) = object.get("path") {
                    validate_reference_path(path)?;
                }
                if object.len() > 2 {
                    bail!("$result reference may only contain path");
                }
                return Ok(());
            }
            if let Some(input) = object.get("$input") {
                if input != &Value::Bool(true) {
                    validate_reference_path(input)?;
                }
                if object.len() != 1 {
                    bail!("$input reference may not include other fields");
                }
                return Ok(());
            }
            if object.contains_key("$now") {
                if object.len() != 1 || object.get("$now") != Some(&Value::Bool(true)) {
                    bail!("$now reference must be true");
                }
                return Ok(());
            }
            for item in object.values() {
                validate_references(item, prior_operations)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn validate_reference_path(path: &Value) -> Result<()> {
    let Some(items) = path.as_array() else {
        bail!("reference path must be an array");
    };
    for item in items {
        if !item.is_string() && !item.as_u64().is_some() {
            bail!("reference path entries must be strings or array indexes");
        }
    }
    Ok(())
}

fn step_id(step: &WorkflowStep) -> &str {
    match step {
        WorkflowStep::HostCommand { id, .. }
        | WorkflowStep::Agent { id, .. }
        | WorkflowStep::Fanout { id, .. }
        | WorkflowStep::Integrate { id, .. }
        | WorkflowStep::Claim { id, .. }
        | WorkflowStep::Report { id, .. } => id,
    }
}

pub fn is_safe_id(value: &str) -> bool {
    !matches!(value, "." | "..")
        && value.len() <= 120
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}
