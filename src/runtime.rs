use crate::artifacts::ArtifactStore;
use crate::canonical::{stable_stringify, to_canonical_value};
use crate::host_command::{command_result_for_storage, env_inherit_list, run_host_command};
use crate::manifest::{format_preview, is_safe_id, parse_workflow_source};
use crate::sandbox::{operation_key, run_sandbox_tick};
use crate::state::{EnsureAgentTask, FlowdexState};
use crate::types::{
    AdapterConfig, AdapterResult, AgentTask, CanonicalValue, Claim, EvidenceRef, ParsedWorkflow,
    ScheduledOperation, TickResult, WorkflowManifest,
};
use crate::write_integration::apply_patches;
use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct RuntimeOptions {
    pub cwd: PathBuf,
    pub input: CanonicalValue,
    pub run_id: Option<String>,
    pub auto_approve: bool,
    pub max_ticks: usize,
}

impl RuntimeOptions {
    pub fn new(cwd: PathBuf) -> Self {
        Self {
            cwd,
            input: json!({}),
            run_id: None,
            auto_approve: false,
            max_ticks: 20,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunSummary {
    pub run_id: String,
    pub status: String,
    pub report: Option<CanonicalValue>,
    pub parsed: ParsedWorkflow,
}

pub struct FlowdexRuntime {
    options: RuntimeOptions,
}

impl FlowdexRuntime {
    pub fn new(options: RuntimeOptions) -> Self {
        Self { options }
    }

    pub fn preview(&self, workflow_path: &Path) -> Result<ParsedWorkflow> {
        let source = fs::read_to_string(workflow_path)?;
        parse_workflow_source(&source, &workflow_path.to_string_lossy())
    }

    pub fn run(&self, workflow_path: &Path) -> Result<RunSummary> {
        let source = fs::read_to_string(workflow_path)?;
        let parsed = parse_workflow_source(&source, &workflow_path.to_string_lossy())?;
        if !self.options.auto_approve {
            bail!(
                "Flowdex approval required. Re-run with --yes after reviewing:\n{}",
                format_preview(&parsed)?
            );
        }
        let run_id = self
            .options
            .run_id
            .clone()
            .unwrap_or_else(|| create_run_id(&parsed.manifest.name));
        if FlowdexState::run_directory_exists(&self.options.cwd, &run_id)? {
            bail!("Flowdex run already exists: {run_id}");
        }
        let run_root = FlowdexState::run_directory(&self.options.cwd, &run_id)?;
        fs::create_dir_all(&run_root)?;
        fs::write(run_root.join("workflow.ts"), source)?;
        fs::write(
            run_root.join("input.json"),
            stable_stringify(&self.options.input)?,
        )?;
        let artifact_store = ArtifactStore::new(run_root.join("artifacts"));
        let state = FlowdexState::open_run(&self.options.cwd, &run_id)?;
        state.create_run(
            &run_id,
            &parsed.manifest,
            &parsed.source_hash,
            &parsed.manifest_hash,
            &parsed.approval_hash,
        )?;
        self.drive_run(
            &run_id,
            &parsed,
            &self.options.input,
            &artifact_store,
            &state,
        )
    }

    pub fn resume(&self, run_id: &str) -> Result<RunSummary> {
        let run_root = FlowdexState::run_directory(&self.options.cwd, run_id)?;
        let source_path = run_root.join("workflow.ts");
        let source = fs::read_to_string(&source_path)?;
        let parsed = parse_workflow_source(&source, &source_path.to_string_lossy())?;
        let input =
            serde_json::from_str::<Value>(&fs::read_to_string(run_root.join("input.json"))?)?;
        let artifact_store = ArtifactStore::new(run_root.join("artifacts"));
        let state = FlowdexState::open_run(&self.options.cwd, run_id)?;
        let run = state
            .get_run(run_id)?
            .ok_or_else(|| anyhow!("unknown Flowdex run: {run_id}"))?;
        let hash_mismatch = run["source_hash"] != parsed.source_hash
            || run["manifest_hash"] != parsed.manifest_hash
            || run["approval_hash"] != parsed.approval_hash;
        if hash_mismatch {
            state.set_run_status(run_id, "failed")?;
            state.add_event(
                run_id,
                "workflow.failed",
                &json!({ "error": "run package hash mismatch; refusing to resume modified workflow" }),
            )?;
            return Ok(RunSummary {
                run_id: run_id.to_string(),
                status: "failed".to_string(),
                report: None,
                parsed,
            });
        }
        let current_status = state.get_run_status(run_id)?.unwrap_or_default();
        if current_status == "paused" || current_status == "stopped" {
            state.add_event(
                run_id,
                "workflow.suspended",
                &json!({ "status": current_status }),
            )?;
            return Ok(RunSummary {
                run_id: run_id.to_string(),
                status: current_status,
                report: None,
                parsed,
            });
        }
        if current_status == "completed" {
            return Ok(RunSummary {
                run_id: run_id.to_string(),
                status: "completed".to_string(),
                report: state.latest_completed_report(run_id)?,
                parsed,
            });
        }
        if current_status == "failed" || current_status == "failed-timeout" {
            return Ok(RunSummary {
                run_id: run_id.to_string(),
                status: "failed".to_string(),
                report: None,
                parsed,
            });
        }
        state.set_run_status(run_id, "running")?;
        self.drive_run(run_id, &parsed, &input, &artifact_store, &state)
    }

    fn drive_run(
        &self,
        run_id: &str,
        parsed: &ParsedWorkflow,
        input: &CanonicalValue,
        artifact_store: &ArtifactStore,
        state: &FlowdexState,
    ) -> Result<RunSummary> {
        let mut status = "pending".to_string();
        let mut report = None;
        for _tick in 0..self.options.max_ticks {
            let current_status = state.get_run_status(run_id)?.unwrap_or_default();
            if current_status == "paused" || current_status == "stopped" {
                state.add_event(
                    run_id,
                    "workflow.suspended",
                    &json!({ "status": current_status }),
                )?;
                status = current_status;
                break;
            }
            state.heartbeat(run_id)?;
            let completed_results = state.get_completed_results(run_id)?;
            let tick_result = run_sandbox_tick(
                &parsed.workflow_body,
                input,
                &Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                &completed_results,
            );
            match tick_result {
                TickResult::Completed { value, staged } => {
                    let raw_report = staged.reports.last().cloned().unwrap_or(value);
                    let verified =
                        self.build_verified_report(&staged.claims, raw_report, state, run_id)?;
                    state.set_run_status(run_id, "completed")?;
                    state.add_event(run_id, "workflow.completed", &verified)?;
                    status = "completed".to_string();
                    report = Some(verified);
                    break;
                }
                TickResult::Failed { error } | TickResult::FailedTimeout { error } => {
                    state.set_run_status(run_id, "failed")?;
                    state.add_event(run_id, "workflow.failed", &json!({ "error": error }))?;
                    status = "failed".to_string();
                    break;
                }
                TickResult::Pending { scheduled } => {
                    state.add_event(
                        run_id,
                        "workflow.pending",
                        &serde_json::to_value(&scheduled)?,
                    )?;
                    let mut needs_dispatch = false;
                    for operation in scheduled {
                        if self.complete_operation(
                            run_id,
                            &parsed.manifest,
                            &operation,
                            artifact_store,
                            state,
                        )? == OperationCompletion::NeedsDispatch
                        {
                            needs_dispatch = true;
                        }
                    }
                    if needs_dispatch {
                        state.set_run_status(run_id, "needs-dispatch")?;
                        status = "needs-dispatch".to_string();
                        break;
                    }
                }
            }
        }
        if status == "pending" {
            state.set_run_status(run_id, "pending")?;
            state.add_event(
                run_id,
                "workflow.pending",
                &json!({ "reason": "tick-budget-exhausted", "maxTicks": self.options.max_ticks }),
            )?;
        }
        Ok(RunSummary {
            run_id: run_id.to_string(),
            status,
            report,
            parsed: parsed.clone(),
        })
    }

    fn complete_operation(
        &self,
        run_id: &str,
        manifest: &WorkflowManifest,
        operation: &ScheduledOperation,
        artifact_store: &ArtifactStore,
        state: &FlowdexState,
    ) -> Result<OperationCompletion> {
        let key = operation_key(operation);
        match operation.kind.as_str() {
            "hostCommand" => {
                let command_id = operation
                    .args
                    .get("commandId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let Some(spec) = manifest
                    .permissions
                    .host_commands
                    .iter()
                    .find(|candidate| candidate.id == command_id)
                else {
                    state.save_task_result(
                        run_id,
                        &key,
                        "completed",
                        &json!({
                            "status": "needs-approval",
                            "error": format!("host command not allowlisted: {command_id}")
                        }),
                    )?;
                    return Ok(OperationCompletion::Completed);
                };
                let result = run_host_command(
                    spec,
                    &self.options.cwd,
                    artifact_store,
                    &env_inherit_list(&manifest.permissions.env),
                )?;
                for artifact in &result.artifacts {
                    state.save_artifact(run_id, artifact)?;
                }
                state.save_task_result(
                    run_id,
                    &key,
                    "completed",
                    &command_result_for_storage(&result.status, result.data),
                )?;
                Ok(OperationCompletion::Completed)
            }
            "agent" => {
                let task = validate_task(&operation.args, manifest)?;
                self.complete_agent_child(
                    run_id,
                    manifest,
                    state,
                    AgentChild {
                        parent_op_key: &key,
                        child_key: &key,
                        task: &task,
                        order_index: 0,
                    },
                )
            }
            "fanout" => {
                let tasks = validate_fanout_tasks(
                    operation.args.get("tasks").unwrap_or(&Value::Array(vec![])),
                    manifest,
                    &key,
                )?;
                let mut needs_dispatch = false;
                for (index, task) in tasks.iter().enumerate() {
                    let child_key = fanout_child_key(&operation.id, &task.id);
                    if self.complete_agent_child(
                        run_id,
                        manifest,
                        state,
                        AgentChild {
                            parent_op_key: &key,
                            child_key: &child_key,
                            task,
                            order_index: index as i64,
                        },
                    )? == OperationCompletion::NeedsDispatch
                    {
                        needs_dispatch = true;
                    }
                }
                if needs_dispatch {
                    return Ok(OperationCompletion::NeedsDispatch);
                }
                let records = state.list_agent_tasks(run_id, Some(&key))?;
                if records.len() != tasks.len()
                    || records.iter().any(|record| record.result.is_none())
                {
                    return Ok(OperationCompletion::NeedsDispatch);
                }
                let ordered = records
                    .into_iter()
                    .map(|record| serde_json::to_value(record.result.unwrap()))
                    .collect::<serde_json::Result<Vec<_>>>()?;
                state.save_task_result(run_id, &key, "completed", &Value::Array(ordered))?;
                Ok(OperationCompletion::Completed)
            }
            "integrate" => {
                let patches = operation
                    .args
                    .get("patches")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|entry| {
                        entry
                            .get("patch")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .ok_or_else(|| anyhow!("integrate patch entry is missing patch text"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                apply_patches(&self.options.cwd, &patches, &manifest.permissions.write)?;
                state.save_task_result(
                    run_id,
                    &key,
                    "completed",
                    &json!({ "status": "completed", "applied": patches.len() }),
                )?;
                Ok(OperationCompletion::Completed)
            }
            _ => bail!("unsupported scheduled operation: {}", operation.kind),
        }
    }

    fn complete_agent_child(
        &self,
        run_id: &str,
        manifest: &WorkflowManifest,
        state: &FlowdexState,
        child: AgentChild<'_>,
    ) -> Result<OperationCompletion> {
        let parent_op_key = child.parent_op_key;
        let child_key = child.child_key;
        let task = child.task;
        let adapter = resolve_adapter_config(task.adapter.as_deref(), manifest)?;
        enforce_agent_budget(run_id, child_key, &task.phase, manifest, state)?;
        let task_with_defaults = task_with_dispatch_defaults(task, &adapter, manifest)?;
        let task_value = to_canonical_value(&task_with_defaults)?;
        let existing = state.ensure_agent_task(EnsureAgentTask {
            run_id,
            child_key,
            parent_op_key,
            task_id: &task.id,
            phase: &task.phase,
            adapter: adapter.0.as_str(),
            mode: &task.mode,
            order_index: child.order_index,
            task: &task_value,
            context_cwd: None,
            status: None,
        })?;
        if existing.result.is_some()
            || matches!(existing.status.as_str(), "completed" | "failed" | "blocked")
        {
            state.ensure_single_agent_task_result(run_id, child_key)?;
            return Ok(OperationCompletion::Completed);
        }
        if matches!(
            existing.status.as_str(),
            "dispatchable" | "leased" | "dispatched"
        ) {
            return Ok(OperationCompletion::NeedsDispatch);
        }
        if task.mode == "write" {
            let result = blocked_result(
                task,
                "codex-native write tasks are disabled; use read-only native workers and explicit ctx.integrate patches",
            );
            state.update_agent_task_status(
                run_id,
                child_key,
                "blocked",
                Some(&result),
                result.error.as_str(),
            )?;
            if parent_op_key == child_key {
                state.save_task_result(
                    run_id,
                    parent_op_key,
                    "completed",
                    &serde_json::to_value(result)?,
                )?;
            }
            return Ok(OperationCompletion::Completed);
        }
        state.mark_agent_dispatchable(run_id, child_key, None)?;
        Ok(OperationCompletion::NeedsDispatch)
    }

    fn build_verified_report(
        &self,
        claims: &[Claim],
        raw_report: CanonicalValue,
        state: &FlowdexState,
        run_id: &str,
    ) -> Result<CanonicalValue> {
        let Some(report_object) = raw_report.as_object() else {
            return Ok(raw_report);
        };
        let Some(claim_ids_value) = report_object.get("claimIds") else {
            return Ok(raw_report);
        };
        let claim_ids = claim_ids_value
            .as_array()
            .ok_or_else(|| anyhow!("report.claimIds must be an array of strings"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| anyhow!("report.claimIds must be an array of strings"))
            })
            .collect::<Result<Vec<_>>>()?;
        let artifacts = state.list_artifacts(run_id)?;
        let artifact_ids = artifacts
            .iter()
            .map(|artifact| artifact.id.as_str())
            .collect::<HashSet<_>>();
        let completed_results = state.get_completed_results(run_id)?;
        let verified_claims = claim_ids
            .iter()
            .map(|claim_id| {
                claims
                    .iter()
                    .find(|claim| {
                        &claim.id == claim_id
                            && claim_is_verified(claim, &artifact_ids, &completed_results)
                    })
                    .cloned()
                    .ok_or_else(|| anyhow!("report references claims that are not host-verified"))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut report = report_object.clone();
        report.insert("claims".to_string(), serde_json::to_value(verified_claims)?);
        Ok(Value::Object(report))
    }
}

fn claim_is_verified(
    claim: &Claim,
    artifact_ids: &HashSet<&str>,
    completed_results: &BTreeMap<String, CanonicalValue>,
) -> bool {
    !claim.evidence.is_empty()
        && claim
            .evidence
            .iter()
            .all(|evidence| evidence_is_verified(evidence, artifact_ids, completed_results))
}

fn evidence_is_verified(
    evidence: &EvidenceRef,
    artifact_ids: &HashSet<&str>,
    completed_results: &BTreeMap<String, CanonicalValue>,
) -> bool {
    match evidence {
        EvidenceRef::Command {
            artifact_id,
            command,
            exit_code,
        }
        | EvidenceRef::Test {
            artifact_id,
            command,
            exit_code,
            ..
        } => {
            artifact_ids.contains(artifact_id.as_str())
                && completed_results.values().any(|result| {
                    let Some(data) = result.get("data") else {
                        return false;
                    };
                    data.get("command")
                        .and_then(Value::as_array)
                        .is_some_and(|items| {
                            items
                                .iter()
                                .map(Value::as_str)
                                .collect::<Option<Vec<_>>>()
                                .is_some_and(|items| {
                                    items == command.iter().map(String::as_str).collect::<Vec<_>>()
                                })
                        })
                        && data.get("exitCode").and_then(Value::as_i64) == Some(*exit_code)
                        && (data.get("stdoutArtifactId").and_then(Value::as_str)
                            == Some(artifact_id.as_str())
                            || data.get("stderrArtifactId").and_then(Value::as_str)
                                == Some(artifact_id.as_str()))
                })
        }
        EvidenceRef::DiffHunk { artifact_id, .. }
        | EvidenceRef::AgentResult { artifact_id, .. }
        | EvidenceRef::SchemaValidation { artifact_id, .. } => {
            artifact_ids.contains(artifact_id.as_str())
        }
        EvidenceRef::FileRange { .. } => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationCompletion {
    Completed,
    NeedsDispatch,
}

struct AgentChild<'a> {
    parent_op_key: &'a str,
    child_key: &'a str,
    task: &'a AgentTask,
    order_index: i64,
}

pub fn create_run_id(name: &str) -> String {
    let safe = name
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let safe = if safe.is_empty() {
        "workflow".to_string()
    } else {
        safe
    };
    format!(
        "{}-{safe}",
        Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .replace([':', '.'], "-")
    )
}

fn validate_task(value: &Value, manifest: &WorkflowManifest) -> Result<AgentTask> {
    let task: AgentTask = serde_json::from_value(value.clone())?;
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
        resolve_adapter_config(Some(adapter), manifest)?;
    }
    Ok(task)
}

fn validate_fanout_tasks(
    value: &Value,
    manifest: &WorkflowManifest,
    parent_op_key: &str,
) -> Result<Vec<AgentTask>> {
    let Some(values) = value.as_array() else {
        bail!("fanout.tasks must be an array");
    };
    if values.len() as u64 > manifest.max_agents {
        bail!("fanout task count exceeds manifest.maxAgents for {parent_op_key}");
    }
    let mut seen = HashSet::new();
    let mut per_phase = BTreeMap::<String, u64>::new();
    let mut tasks = Vec::new();
    for value in values {
        let task = validate_task(value, manifest)?;
        if !seen.insert(task.id.clone()) {
            bail!("duplicate fanout task id: {}", task.id);
        }
        *per_phase.entry(task.phase.clone()).or_default() += 1;
        tasks.push(task);
    }
    for phase in &manifest.phases {
        if per_phase.get(&phase.id).copied().unwrap_or(0) > phase.max_agents {
            bail!("fanout phase {} exceeds maxAgents", phase.id);
        }
    }
    Ok(tasks)
}

fn resolve_adapter_config(
    requested: Option<&str>,
    manifest: &WorkflowManifest,
) -> Result<(String, AdapterConfig)> {
    let name = requested
        .or(manifest.default_adapter.as_deref())
        .unwrap_or("codex-native");
    if let Some(adapter) = manifest
        .adapters
        .as_ref()
        .and_then(|adapters| adapters.get(name))
    {
        return Ok((name.to_string(), adapter.clone()));
    }
    if name == "codex-native" {
        return Ok((
            "codex-native".to_string(),
            AdapterConfig {
                kind: "codex-native".to_string(),
                model: None,
                reasoning_effort: None,
            },
        ));
    }
    bail!("unknown adapter: {name}");
}

fn task_with_dispatch_defaults(
    task: &AgentTask,
    adapter: &(String, AdapterConfig),
    manifest: &WorkflowManifest,
) -> Result<AgentTask> {
    let mut output = task.clone();
    if output.model.is_none() {
        output.model = adapter.1.model.clone();
    }
    if output.reasoning_effort.is_none() {
        output.reasoning_effort = adapter.1.reasoning_effort.clone();
    }
    output.network = Some(
        manifest
            .permissions
            .network
            .clone()
            .unwrap_or_else(|| "none".to_string()),
    );
    Ok(output)
}

fn enforce_agent_budget(
    run_id: &str,
    child_key: &str,
    phase_id: &str,
    manifest: &WorkflowManifest,
    state: &FlowdexState,
) -> Result<()> {
    let existing = state
        .list_agent_tasks(run_id, None)?
        .into_iter()
        .filter(|task| task.child_key != child_key)
        .collect::<Vec<_>>();
    if existing.len() as u64 >= manifest.max_agents {
        bail!("agent task count exceeds manifest.maxAgents for run {run_id}");
    }
    let phase_limit = manifest
        .phases
        .iter()
        .find(|phase| phase.id == phase_id)
        .map(|phase| phase.max_agents)
        .unwrap_or(0);
    if existing
        .iter()
        .filter(|task| task.phase == phase_id)
        .count() as u64
        >= phase_limit
    {
        bail!("agent task count exceeds phase maxAgents for phase {phase_id}");
    }
    Ok(())
}

fn fanout_child_key(fanout_id: &str, task_id: &str) -> String {
    format!("fanout:{fanout_id}#{task_id}")
}

fn blocked_result(task: &AgentTask, reason: &str) -> AdapterResult {
    AdapterResult {
        status: "blocked".to_string(),
        summary: format!("Blocked {}", task.id),
        data: json!({}),
        claims: vec![],
        artifacts: vec![],
        diff: Value::Null,
        usage: json!({}),
        error: Value::String(reason.to_string()),
    }
}
