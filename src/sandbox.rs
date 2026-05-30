use crate::canonical::{canonicalize, to_canonical_value};
use crate::types::{
    AgentTask, CanonicalValue, Claim, PatchSpec, ScheduledOperation, StagedEffects, TickResult,
    WorkflowDocument, WorkflowStep,
};
use anyhow::{Result, anyhow, bail};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub fn operation_key(operation: &ScheduledOperation) -> String {
    operation_key_for_parts(&operation.kind, &operation.id)
}

pub fn operation_key_for_parts(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

pub fn evaluate_static_workflow_tick(
    document: &WorkflowDocument,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> TickResult {
    evaluate_static_workflow_tick_inner(document, input, now, results).unwrap_or_else(|error| {
        TickResult::Failed {
            error: format!("{error:#}"),
        }
    })
}

fn evaluate_static_workflow_tick_inner(
    document: &WorkflowDocument,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<TickResult> {
    let mut staged = StagedEffects {
        claims: vec![],
        artifacts: vec![],
        reports: vec![],
    };

    for step in &document.steps {
        match step {
            WorkflowStep::Claim { claim, .. } => {
                let resolved = resolve_value(claim, input, now, results)?;
                staged
                    .claims
                    .push(serde_json::from_value::<Claim>(resolved)?);
            }
            WorkflowStep::Report { value, .. } => {
                let resolved = resolve_value(value, input, now, results)?;
                let resolved = canonicalize(&resolved)?;
                staged.reports.push(resolved.clone());
                return Ok(TickResult::Completed {
                    value: resolved,
                    staged,
                });
            }
            _ => {
                let operation = scheduled_operation_from_step(step, input, now, results)?;
                let key = operation_key(&operation);
                if !results.contains_key(&key) {
                    return Ok(TickResult::Pending {
                        scheduled: vec![operation],
                    });
                }
            }
        }
    }

    Ok(TickResult::Completed {
        value: Value::Null,
        staged,
    })
}

fn scheduled_operation_from_step(
    step: &WorkflowStep,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<ScheduledOperation> {
    match step {
        WorkflowStep::HostCommand {
            id,
            phase,
            command_id,
        } => Ok(ScheduledOperation {
            kind: "hostCommand".to_string(),
            id: id.clone(),
            phase: phase.clone(),
            args: json!({ "id": id, "phase": phase, "commandId": command_id }),
        }),
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
            let data = data
                .as_ref()
                .map(|value| resolve_value(value, input, now, results))
                .transpose()?;
            let task = AgentTask {
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
                data,
            };
            Ok(ScheduledOperation {
                kind: "agent".to_string(),
                id: id.clone(),
                phase: phase.clone(),
                args: to_canonical_value(&task)?,
            })
        }
        WorkflowStep::Fanout { id, phase, tasks } => {
            let tasks = tasks
                .iter()
                .map(|task| {
                    let mut task = task.clone();
                    task.data = task
                        .data
                        .as_ref()
                        .map(|value| resolve_value(value, input, now, results))
                        .transpose()?;
                    Ok(task)
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ScheduledOperation {
                kind: "fanout".to_string(),
                id: id.clone(),
                phase: phase.clone(),
                args: json!({ "id": id, "phase": phase, "tasks": tasks }),
            })
        }
        WorkflowStep::Integrate { id, phase, patches } => {
            let patches = patches
                .iter()
                .map(|entry| resolve_patch_entry(entry, input, now, results))
                .collect::<Result<Vec<_>>>()?;
            Ok(ScheduledOperation {
                kind: "integrate".to_string(),
                id: id.clone(),
                phase: phase.clone(),
                args: json!({ "id": id, "phase": phase, "patches": patches }),
            })
        }
        WorkflowStep::Claim { .. } | WorkflowStep::Report { .. } => {
            bail!("claim and report steps are not schedulable")
        }
    }
}

fn resolve_patch_entry(
    entry: &PatchSpec,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<Value> {
    let patch = resolve_value(&entry.patch, input, now, results)?;
    let Some(patch) = patch.as_str() else {
        bail!("integrate patch entry must resolve to a string");
    };
    Ok(json!({ "patch": patch }))
}

fn resolve_value(
    value: &Value,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => canonicalize(value),
        Value::Array(items) => items
            .iter()
            .map(|item| resolve_value(item, input, now, results))
            .collect::<Result<Vec<_>>>()
            .and_then(|items| canonicalize(&Value::Array(items))),
        Value::Object(object) => {
            if object.contains_key("$result") {
                return resolve_result_reference(object, results);
            }
            if object.contains_key("$input") {
                return resolve_input_reference(object, input);
            }
            if object.contains_key("$now") {
                if object.len() != 1 || object.get("$now") != Some(&Value::Bool(true)) {
                    bail!("$now reference must be {{\"$now\":true}}");
                }
                return Ok(Value::String(now.to_string()));
            }
            let mut output = Map::new();
            for (key, item) in object {
                output.insert(key.clone(), resolve_value(item, input, now, results)?);
            }
            canonicalize(&Value::Object(output))
        }
    }
}

fn resolve_result_reference(
    object: &Map<String, Value>,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<Value> {
    if object.len() > 2 {
        bail!("$result reference may only contain path");
    }
    let key = object
        .get("$result")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("$result reference requires an operation key"))?;
    let value = results
        .get(key)
        .ok_or_else(|| anyhow!("unresolved operation reference: {key}"))?;
    resolve_optional_path(value, object.get("path"))
}

fn resolve_input_reference(object: &Map<String, Value>, input: &CanonicalValue) -> Result<Value> {
    if object.len() != 1 {
        bail!("$input reference may only contain a path array or true");
    }
    match object.get("$input") {
        Some(Value::Bool(true)) => canonicalize(input),
        Some(path @ Value::Array(_)) => resolve_optional_path(input, Some(path)),
        _ => bail!("$input reference requires true or a path array"),
    }
}

fn resolve_optional_path(root: &Value, path: Option<&Value>) -> Result<Value> {
    let Some(path) = path else {
        return canonicalize(root);
    };
    let Some(items) = path.as_array() else {
        bail!("reference path must be an array");
    };
    let mut current = root;
    for item in items {
        match item {
            Value::String(key) => {
                current = current
                    .get(key)
                    .ok_or_else(|| anyhow!("reference path is missing key: {key}"))?;
            }
            Value::Number(index) => {
                let index = index
                    .as_u64()
                    .ok_or_else(|| anyhow!("reference path index must be unsigned"))?
                    as usize;
                current = current
                    .as_array()
                    .and_then(|array| array.get(index))
                    .ok_or_else(|| anyhow!("reference path is missing index: {index}"))?;
            }
            _ => bail!("reference path entries must be strings or array indexes"),
        }
    }
    canonicalize(current)
}
