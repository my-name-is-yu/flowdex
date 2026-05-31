use crate::adapter_result::validate_adapter_result;
use crate::canonical::stable_stringify;
use crate::state::FlowdexState;
use crate::types::NativeDispatch;
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDispatchFilePackage {
    pub run_id: String,
    pub child_key: String,
    pub parent_op_key: String,
    pub task_id: String,
    pub phase: String,
    pub adapter: String,
    pub mode: String,
    pub cwd: String,
    pub lease_token: String,
    pub lease_expires_at: String,
    pub instruction_path: String,
    pub task_path: String,
    pub result_path: String,
    pub agent_prompt: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectResult {
    pub child_key: String,
    pub task_id: String,
    pub status: String,
    pub task_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn write_native_dispatch_file_package(
    run_root: &Path,
    dispatch: &NativeDispatch,
) -> Result<NativeDispatchFilePackage> {
    let dispatch_root =
        native_dispatch_directory(run_root, &dispatch.child_key, &dispatch.lease_token);
    let task_path = dispatch_root.join("task.json");
    let instruction_path = dispatch_root.join("instructions.md");
    let result_path = dispatch_root.join("adapter-result.json");
    fs::create_dir_all(&dispatch_root)?;
    fs::write(
        &task_path,
        stable_stringify(&serde_json::to_value(dispatch)?)?,
    )?;
    fs::write(
        &instruction_path,
        build_native_dispatch_instructions(dispatch, &task_path, &result_path),
    )?;
    Ok(NativeDispatchFilePackage {
        run_id: dispatch.run_id.clone(),
        child_key: dispatch.child_key.clone(),
        parent_op_key: dispatch.parent_op_key.clone(),
        task_id: dispatch.task_id.clone(),
        phase: dispatch.phase.clone(),
        adapter: dispatch.adapter.clone(),
        mode: dispatch.mode.clone(),
        cwd: dispatch.cwd.clone(),
        lease_token: dispatch.lease_token.clone(),
        lease_expires_at: dispatch.lease_expires_at.clone(),
        instruction_path: instruction_path.to_string_lossy().into_owned(),
        task_path: task_path.to_string_lossy().into_owned(),
        result_path: result_path.to_string_lossy().into_owned(),
        agent_prompt: format!(
            "Read {} and complete that Flowdex worker task. Write only the AdapterResult JSON file requested there.",
            instruction_path.to_string_lossy()
        ),
        model: dispatch.model.clone(),
        reasoning_effort: dispatch.reasoning_effort.clone(),
        network: dispatch.network.clone(),
        role: dispatch.role.clone(),
        nickname: dispatch.nickname.clone(),
    })
}

pub fn native_dispatch_directory(run_root: &Path, child_key: &str, lease_token: &str) -> PathBuf {
    native_dispatch_task_directory(run_root, child_key).join(safe_path_segment(lease_token))
}

pub fn native_dispatch_task_directory(run_root: &Path, child_key: &str) -> PathBuf {
    run_root
        .join("dispatches")
        .join(safe_path_segment(child_key))
}

pub fn native_dispatch_result_path(run_root: &Path, child_key: &str, lease_token: &str) -> PathBuf {
    native_dispatch_directory(run_root, child_key, lease_token).join("adapter-result.json")
}

pub fn collect_native_result_files(
    cwd: &Path,
    run_id: &str,
    state: &FlowdexState,
) -> Result<Vec<CollectResult>> {
    let run_root = FlowdexState::run_directory(cwd, run_id)?;
    let tasks = state.list_agent_tasks(run_id, None)?;
    let mut results = Vec::new();
    for task in tasks {
        if task.status != "leased" && task.status != "dispatched" {
            results.push(CollectResult {
                child_key: task.child_key,
                task_id: task.task_id,
                status: "skipped".to_string(),
                task_status: task.status,
                result_path: None,
                adapter_status: task.result.map(|result| result.status),
                error: None,
            });
            continue;
        }
        let Some(lease_token) = task.lease_token.clone() else {
            results.push(CollectResult {
                child_key: task.child_key,
                task_id: task.task_id,
                status: "invalid".to_string(),
                task_status: task.status,
                result_path: None,
                adapter_status: None,
                error: Some("leased task has no lease token".to_string()),
            });
            continue;
        };
        let result_path = native_dispatch_result_path(&run_root, &task.child_key, &lease_token);
        if !result_path.is_file() {
            if let Some(stale_path) =
                find_stale_result_path(&run_root, &task.child_key, &lease_token)?
            {
                let error = "adapter-result.json exists for an older lease token".to_string();
                state.record_agent_task_collection_error(run_id, &task.child_key, &error)?;
                results.push(CollectResult {
                    child_key: task.child_key,
                    task_id: task.task_id,
                    status: "stale-result".to_string(),
                    task_status: task.status,
                    result_path: Some(stale_path.to_string_lossy().into_owned()),
                    adapter_status: None,
                    error: Some(error),
                });
                continue;
            }
            let error = "adapter-result.json not found".to_string();
            state.record_agent_task_collection_error(run_id, &task.child_key, &error)?;
            results.push(CollectResult {
                child_key: task.child_key,
                task_id: task.task_id,
                status: "missing".to_string(),
                task_status: task.status,
                result_path: Some(result_path.to_string_lossy().into_owned()),
                adapter_status: None,
                error: Some(error),
            });
            continue;
        }
        match read_adapter_result_file(&result_path) {
            Ok(result) => {
                let adapter_status = result.status.clone();
                state.complete_agent_task(run_id, &task.child_key, &lease_token, &result)?;
                results.push(CollectResult {
                    child_key: task.child_key,
                    task_id: task.task_id,
                    status: "collected".to_string(),
                    task_status: task.status,
                    result_path: Some(result_path.to_string_lossy().into_owned()),
                    adapter_status: Some(adapter_status),
                    error: None,
                });
            }
            Err(error) => {
                let error = format!("{error:#}");
                state.record_agent_task_collection_error(run_id, &task.child_key, &error)?;
                results.push(CollectResult {
                    child_key: task.child_key,
                    task_id: task.task_id,
                    status: "invalid".to_string(),
                    task_status: task.status,
                    result_path: Some(result_path.to_string_lossy().into_owned()),
                    adapter_status: None,
                    error: Some(error),
                });
            }
        }
    }
    Ok(results)
}

fn read_adapter_result_file(path: &Path) -> Result<crate::types::AdapterResult> {
    let value = serde_json::from_str::<Value>(&fs::read_to_string(path)?)?;
    validate_adapter_result(value)
}

fn find_stale_result_path(
    run_root: &Path,
    child_key: &str,
    current_lease_token: &str,
) -> Result<Option<PathBuf>> {
    let task_directory = native_dispatch_task_directory(run_root, child_key);
    if !task_directory.is_dir() {
        return Ok(None);
    }
    for entry in fs::read_dir(task_directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_name() == current_lease_token {
            continue;
        }
        let candidate =
            native_dispatch_result_path(run_root, child_key, &entry.file_name().to_string_lossy());
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn build_native_dispatch_instructions(
    dispatch: &NativeDispatch,
    task_path: &Path,
    result_path: &Path,
) -> String {
    let optional_keys = dispatch
        .data
        .as_ref()
        .and_then(Value::as_object)
        .map(|object| {
            if object.is_empty() {
                "(none)".to_string()
            } else {
                object.keys().cloned().collect::<Vec<_>>().join(", ")
            }
        })
        .unwrap_or_else(|| "(none)".to_string());
    [
        "# Flowdex Native Worker".to_string(),
        String::new(),
        "Read the task package JSON at:".to_string(),
        String::new(),
        format!("- {}", task_path.to_string_lossy()),
        String::new(),
        "Use the package fields as authoritative, especially `cwd`, `prompt`, and optional `data`.".to_string(),
        String::new(),
        format!("Child key: {}", dispatch.child_key),
        format!("Task id: {}", dispatch.task_id),
        format!("Role: {}", dispatch.role.as_deref().unwrap_or("unspecified")),
        format!("Mode: {}", dispatch.mode),
        format!("Work in the package `cwd`: {}", dispatch.cwd),
        format!(
            "Network policy for this task: {}.",
            dispatch.network.as_deref().unwrap_or("none")
        ),
        String::new(),
        "Prompt:".to_string(),
        String::new(),
        dispatch.prompt.clone(),
        String::new(),
        format!("Optional data keys: {optional_keys}"),
        String::new(),
        "Do only that assigned task. Do not orchestrate unrelated work or spawn other agents.".to_string(),
        String::new(),
        "When finished, write a single AdapterResult JSON object to:".to_string(),
        String::new(),
        format!("- {}", result_path.to_string_lossy()),
        String::new(),
        "The JSON object must have exactly these top-level fields:".to_string(),
        String::new(),
        "```json".to_string(),
        "{\"status\":\"completed\",\"summary\":\"...\",\"data\":{},\"claims\":[],\"artifacts\":[],\"diff\":null,\"usage\":{},\"error\":null}".to_string(),
        "```".to_string(),
        String::new(),
        "`status` must be one of `completed`, `failed`, `blocked`, or `needs-approval`.".to_string(),
        "Set `claims` and `artifacts` to empty arrays and `diff` to null unless you can provide valid Flowdex records.".to_string(),
        "After writing the file, reply only with the result path and status.".to_string(),
    ]
    .join("\n")
}

fn safe_path_segment(value: &str) -> String {
    let output = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(120)
        .collect::<String>();
    if output.is_empty() {
        "dispatch".to_string()
    } else {
        output
    }
}
