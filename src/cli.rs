use crate::adapter_result::validate_adapter_result;
use crate::canonical::{stable_stringify, stable_stringify_pretty};
use crate::manifest::{format_preview, is_safe_id, parse_workflow_source};
use crate::native_dispatch::{
    collect_native_result_files, native_dispatch_result_path, write_native_dispatch_file_package,
};
use crate::report_path::{list_report_paths, read_report_path};
use crate::runtime::{FlowdexRuntime, RuntimeOptions};
use crate::skill::install_bundled_skill;
use crate::snapshot::build_snapshot;
use crate::state::FlowdexState;
use crate::templates::template_for;
use crate::types::{AgentTaskRecord, CanonicalValue, NativeDispatch, WorkflowManifest};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const CODEX_DESKTOP_ACTIVE_AGENT_LIMIT: usize = 6;
const SNAPSHOT_MANIFEST_FILE: &str = ".flowdex-snapshot.json";
const WORKFLOW_TS_FILE: &str = "workflow.ts";
const WORKFLOW_TS_FILE_SUFFIX: &str = ".ts";

pub fn run(args: Vec<String>) -> Result<()> {
    let cwd = std::env::current_dir()?;
    let Some(command) = args.first().map(String::as_str) else {
        print_help();
        return Ok(());
    };
    if matches!(command, "help" | "--help" | "-h") {
        print_help();
        return Ok(());
    }
    let target = args.get(1).map(String::as_str);
    let rest = args.iter().skip(2).cloned().collect::<Vec<_>>();
    match command {
        "preview" => preview_command(&cwd, target),
        "run" => run_command(&cwd, target, &rest),
        "list" => list_command(&cwd),
        "resume" | "continue" => resume_command(&cwd, command, target),
        "inspect" => inspect_command(&cwd, target),
        "next" => next_command(&cwd, target, &rest),
        "attach-agent" => attach_agent_command(&cwd, target, &rest),
        "complete-agent" => complete_agent_command(&cwd, target, &rest),
        "collect-results" => collect_results_command(&cwd, target, &rest),
        "report" => report_command(&cwd, target, &rest),
        "watch" => watch_command(&cwd, target),
        "status" => status_command(&cwd, target, &rest),
        "pause" | "stop" => lifecycle_command(&cwd, command, target),
        "repair-events" => repair_events_command(&cwd, target),
        "restart-agent" => restart_agent_command(&cwd, target, &rest),
        "save" => save_command(&cwd, target, &rest),
        "workflow" => workflow_command(&cwd, target),
        "init" => init_command(&cwd, target, &rest),
        "skill" => skill_command(target, &rest),
        _ => bail!("unknown command: {command}"),
    }
}

fn preview_command(cwd: &Path, target: Option<&str>) -> Result<()> {
    let target = target.ok_or_else(|| anyhow!("flowdex preview requires a workflow path"))?;
    let workflow_path = resolve_workflow_path(cwd, target);
    let parsed = parse_workflow_source(
        &fs::read_to_string(&workflow_path)?,
        &workflow_path.to_string_lossy(),
    )?;
    println!("{}", format_preview(&parsed)?);
    Ok(())
}

fn run_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let target = target.ok_or_else(|| anyhow!("flowdex run requires a workflow path"))?;
    let input = match read_flag(rest, "--input") {
        Some(value) => serde_json::from_str::<Value>(&read_input(value)?)?,
        None => json!({}),
    };
    let mut options = RuntimeOptions::new(cwd.to_path_buf());
    options.input = input;
    options.auto_approve = rest.iter().any(|item| item == "--yes");
    options.run_id = read_flag(rest, "--run-id").map(str::to_string);
    let runtime = FlowdexRuntime::new(options);
    let summary = runtime.run(&resolve_workflow_path(cwd, target))?;
    write_run_summary(&summary.run_id, &summary.status, summary.report.as_ref())?;
    Ok(())
}

fn list_command(cwd: &Path) -> Result<()> {
    for run_id in FlowdexState::list_run_ids(cwd)? {
        match FlowdexState::open_existing_run(cwd, &run_id)? {
            Some(state) => {
                let status = state
                    .get_run(&run_id)?
                    .and_then(|run| run["status"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string());
                println!("{run_id}\t{status}");
            }
            None => println!("{run_id}\tunknown"),
        }
    }
    Ok(())
}

fn resume_command(cwd: &Path, command: &str, target: Option<&str>) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex {command} requires a run id"))?;
    let mut options = RuntimeOptions::new(cwd.to_path_buf());
    options.auto_approve = true;
    let summary = FlowdexRuntime::new(options).resume(run_id)?;
    write_run_summary(&summary.run_id, &summary.status, summary.report.as_ref())?;
    Ok(())
}

fn inspect_command(cwd: &Path, target: Option<&str>) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex inspect requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let output = json!({
        "run": state.get_run(run_id)?,
        "events": state.list_events(run_id)?
    });
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn next_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex next requires a run id"))?;
    let limit = read_flag(rest, "--limit")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(CODEX_DESKTOP_ACTIVE_AGENT_LIMIT);
    let state = open_existing_state(cwd, run_id)?;
    let dispatches = state.lease_dispatches(run_id, limit)?;
    let run_root = FlowdexState::run_directory(cwd, run_id)?;
    let mut materialized = Vec::new();
    for dispatch in dispatches {
        let child_key = dispatch.child_key.clone();
        let lease_token = dispatch.lease_token.clone();
        match materialize_dispatch_snapshot(cwd, run_id, &run_root, dispatch) {
            Ok(dispatch) => materialized.push(dispatch),
            Err(error) => {
                state.release_lease(run_id, &child_key, &lease_token, &format!("{error:#}"))?;
                return Err(error);
            }
        }
    }
    if rest.iter().any(|item| item == "--files") {
        let mut output = Vec::new();
        for dispatch in &materialized {
            match write_native_dispatch_file_package(&run_root, dispatch) {
                Ok(package) => output.push(serde_json::to_value(package)?),
                Err(error) => {
                    state.release_lease(
                        run_id,
                        &dispatch.child_key,
                        &dispatch.lease_token,
                        &format!("{error:#}"),
                    )?;
                    return Err(error);
                }
            }
        }
        write_json_or_lines(rest, output, |value| {
            let object = value.as_object().expect("package is object");
            format!(
                "{}\t{}\t{}\t{}\t{}\t{}",
                object["childKey"].as_str().unwrap_or_default(),
                object["phase"].as_str().unwrap_or_default(),
                object["mode"].as_str().unwrap_or_default(),
                object["cwd"].as_str().unwrap_or_default(),
                object["instructionPath"].as_str().unwrap_or_default(),
                object["resultPath"].as_str().unwrap_or_default()
            )
        })?;
    } else {
        let output = materialized
            .iter()
            .map(serde_json::to_value)
            .collect::<serde_json::Result<Vec<_>>>()?;
        write_json_or_lines(rest, output, |value| {
            format!(
                "{}\t{}\t{}\t{}",
                value["childKey"].as_str().unwrap_or_default(),
                value["phase"].as_str().unwrap_or_default(),
                value["mode"].as_str().unwrap_or_default(),
                value["cwd"].as_str().unwrap_or_default()
            )
        })?;
    }
    Ok(())
}

fn materialize_dispatch_snapshot(
    cwd: &Path,
    run_id: &str,
    run_root: &Path,
    mut dispatch: NativeDispatch,
) -> Result<NativeDispatch> {
    if !dispatch.cwd.is_empty() {
        return Ok(dispatch);
    }
    let state = open_existing_state(cwd, run_id)?;
    let run = state
        .get_run(run_id)?
        .ok_or_else(|| anyhow!("unknown Flowdex run: {run_id}"))?;
    let manifest_json = run["manifest_json"]
        .as_str()
        .ok_or_else(|| anyhow!("run manifest_json missing"))?;
    let manifest: WorkflowManifest = serde_json::from_str(manifest_json)?;
    let snapshot_root = run_root
        .join("snapshots")
        .join(collision_resistant_segment(&dispatch.child_key));
    if snapshot_root.exists() {
        fs::remove_dir_all(&snapshot_root)?;
    }
    let snapshot = build_snapshot(cwd, &manifest.permissions.read, &snapshot_root)?;
    fs::write(
        snapshot_root.join(SNAPSHOT_MANIFEST_FILE),
        stable_stringify(&serde_json::to_value(&snapshot)?)?,
    )?;
    let snapshot_root_text = snapshot_root.to_string_lossy().into_owned();
    state.set_agent_task_context_cwd(run_id, &dispatch.child_key, &snapshot_root_text)?;
    dispatch.cwd = snapshot_root_text;
    Ok(dispatch)
}

fn attach_agent_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id =
        target.ok_or_else(|| anyhow!("flowdex attach-agent requires a run id and child key"))?;
    let child_key = rest
        .first()
        .ok_or_else(|| anyhow!("flowdex attach-agent requires a run id and child key"))?;
    let lease_token = read_flag(rest, "--lease-token")
        .ok_or_else(|| anyhow!("flowdex attach-agent requires --lease-token and --agent-ref"))?;
    let agent_ref = read_flag(rest, "--agent-ref")
        .ok_or_else(|| anyhow!("flowdex attach-agent requires --lease-token and --agent-ref"))?;
    let state = open_existing_state(cwd, run_id)?;
    state.attach_agent(run_id, child_key, lease_token, agent_ref)?;
    println!("{run_id}\tattached {child_key}\t{agent_ref}");
    Ok(())
}

fn complete_agent_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id =
        target.ok_or_else(|| anyhow!("flowdex complete-agent requires a run id and child key"))?;
    let child_key = rest
        .first()
        .ok_or_else(|| anyhow!("flowdex complete-agent requires a run id and child key"))?;
    let lease_token = read_flag(rest, "--lease-token")
        .ok_or_else(|| anyhow!("flowdex complete-agent requires --lease-token and --result"))?;
    let result_path = read_flag(rest, "--result")
        .ok_or_else(|| anyhow!("flowdex complete-agent requires --lease-token and --result"))?;
    let result = validate_adapter_result(serde_json::from_str(&read_input(result_path)?)?)?;
    let state = open_existing_state(cwd, run_id)?;
    state.complete_agent_task(run_id, child_key, lease_token, &result)?;
    println!("{run_id}\tcompleted {child_key}\t{}", result.status);
    Ok(())
}

fn collect_results_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex collect-results requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let results = collect_native_result_files(cwd, run_id, &state)?;
    let continued = if rest.iter().any(|item| item == "--continue") {
        let mut options = RuntimeOptions::new(cwd.to_path_buf());
        options.auto_approve = true;
        let summary = FlowdexRuntime::new(options).resume(run_id)?;
        Some(json!({
            "runId": summary.run_id,
            "status": summary.status,
            "report": summary.report
        }))
    } else {
        None
    };
    if rest.iter().any(|item| item == "--json") {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "runId": run_id,
                "results": results,
                "continued": continued
            }))?
        );
    } else {
        for result in &results {
            if let Some(error) = &result.error {
                println!("{}\t{}\t{}", result.child_key, result.status, error);
            } else {
                println!("{}\t{}", result.child_key, result.status);
            }
        }
        if let Some(continued) = continued {
            println!(
                "{}\tcontinued\t{}",
                continued["runId"].as_str().unwrap_or(run_id),
                continued["status"].as_str().unwrap_or("unknown")
            );
        }
    }
    Ok(())
}

fn report_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex report requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let report = state
        .latest_completed_report(run_id)?
        .unwrap_or(Value::Null);
    if rest.iter().any(|item| item == "--paths") {
        println!(
            "{}",
            serde_json::to_string_pretty(&list_report_paths(&report))?
        );
        return Ok(());
    }
    let value = match read_flag(rest, "--path") {
        Some(path) => read_report_path(&report, path)?.clone(),
        None => report,
    };
    if rest.iter().any(|item| item == "--raw") && value.is_string() {
        println!("{}", value.as_str().unwrap_or_default());
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

fn watch_command(cwd: &Path, target: Option<&str>) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex watch requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let (run, tasks) = state.get_run_summary(run_id)?;
    print!("{}", format_watch(run_id, run.as_ref(), &tasks));
    Ok(())
}

fn status_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex status requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let (run, tasks) = state.get_run_summary(run_id)?;
    if rest.iter().any(|item| item == "--json") {
        let output_tasks = if rest.iter().any(|item| item == "--compact") {
            tasks
                .iter()
                .map(|task| compact_status_task(cwd, run_id, task))
                .collect::<Vec<_>>()
        } else {
            tasks
                .iter()
                .map(serde_json::to_value)
                .collect::<serde_json::Result<Vec<_>>>()?
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "runId": run_id,
                "run": run,
                "counts": count_tasks(&tasks),
                "tasks": output_tasks
            }))?
        );
    } else {
        print!("{}", format_watch(run_id, run.as_ref(), &tasks));
    }
    Ok(())
}

fn lifecycle_command(cwd: &Path, command: &str, target: Option<&str>) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex {command} requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let status = if command == "pause" {
        "paused"
    } else {
        "stopped"
    };
    state.set_run_status(run_id, status)?;
    println!("{run_id}\t{status}");
    Ok(())
}

fn repair_events_command(cwd: &Path, target: Option<&str>) -> Result<()> {
    let run_id = target.ok_or_else(|| anyhow!("flowdex repair-events requires a run id"))?;
    let state = open_existing_state(cwd, run_id)?;
    let count = state.rebuild_event_projection(run_id)?;
    println!("{run_id}\trebuilt events.jsonl\t{count}");
    Ok(())
}

fn restart_agent_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id =
        target.ok_or_else(|| anyhow!("flowdex restart-agent requires a run id and op key"))?;
    let op_key = rest
        .first()
        .ok_or_else(|| anyhow!("flowdex restart-agent requires a run id and op key"))?;
    let state = open_existing_state(cwd, run_id)?;
    state.delete_task_result(run_id, op_key)?;
    let mut options = RuntimeOptions::new(cwd.to_path_buf());
    options.auto_approve = true;
    let summary = FlowdexRuntime::new(options).resume(run_id)?;
    println!("{run_id}\tinvalidated {op_key}\t{}", summary.status);
    Ok(())
}

fn save_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let run_id =
        target.ok_or_else(|| anyhow!("flowdex save requires a run id and workflow name"))?;
    let name = rest
        .first()
        .ok_or_else(|| anyhow!("flowdex save requires a run id and workflow name"))?;
    if !is_safe_workflow_name(name) {
        bail!("flowdex save workflow name must be a safe id");
    }
    let run_workflow = FlowdexState::run_directory(cwd, run_id)?.join(WORKFLOW_TS_FILE);
    let destination = cwd
        .join(".flowdex")
        .join("workflows")
        .join(format!("{name}{WORKFLOW_TS_FILE_SUFFIX}"));
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&destination)?;
    fs::copy(run_workflow, &destination)?;
    println!("{}", destination.to_string_lossy());
    Ok(())
}

fn workflow_command(cwd: &Path, target: Option<&str>) -> Result<()> {
    if target == Some("list") {
        let directory = cwd.join(".flowdex").join("workflows");
        if !directory.is_dir() {
            return Ok(());
        }
        let mut entries = fs::read_dir(directory)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.strip_suffix(WORKFLOW_TS_FILE_SUFFIX)
                    .map(str::to_string)
            })
            .collect::<Vec<_>>();
        entries.sort();
        for entry in entries {
            println!("{entry}");
        }
        return Ok(());
    }
    bail!("flowdex workflow supports: list")
}

fn init_command(cwd: &Path, target: Option<&str>, rest: &[String]) -> Result<()> {
    let kind = target
        .ok_or_else(|| anyhow!("flowdex init requires a template kind and destination path"))?;
    let destination = rest
        .first()
        .ok_or_else(|| anyhow!("flowdex init requires a template kind and destination path"))?;
    let source = template_for(kind)?;
    let output_path = cwd.join(destination);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&output_path)?;
    fs::write(&output_path, source)?;
    println!("{}", output_path.to_string_lossy());
    Ok(())
}

fn skill_command(target: Option<&str>, rest: &[String]) -> Result<()> {
    if target == Some("install") {
        let destination = read_flag(rest, "--target").map(PathBuf::from);
        let summary = install_bundled_skill(destination)?;
        if rest.iter().any(|item| item == "--json") {
            println!("{}", serde_json::to_string_pretty(&summary)?);
        } else {
            println!(
                "installed {} skill\nsource: {}\ndestination: {}\nfiles: {}",
                summary.skill,
                summary.source.to_string_lossy(),
                summary.destination.to_string_lossy(),
                summary.files_copied
            );
        }
        return Ok(());
    }
    bail!("flowdex skill supports: install [--target <skill-dir>] [--json]")
}

fn write_run_summary(run_id: &str, status: &str, report: Option<&CanonicalValue>) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "runId": run_id,
            "status": status,
            "report": report.cloned().unwrap_or(Value::Null)
        }))?
    );
    Ok(())
}

fn write_json_or_lines<F>(rest: &[String], values: Vec<Value>, line: F) -> Result<()>
where
    F: Fn(&Value) -> String,
{
    if rest.iter().any(|item| item == "--json") {
        println!("{}", serde_json::to_string_pretty(&values)?);
    } else {
        for value in &values {
            println!("{}", line(value));
        }
    }
    Ok(())
}

fn read_input(value: &str) -> Result<String> {
    if let Some(path) = value.strip_prefix('@') {
        Ok(fs::read_to_string(path)?)
    } else {
        Ok(value.to_string())
    }
}

fn open_existing_state(cwd: &Path, run_id: &str) -> Result<FlowdexState> {
    FlowdexState::open_existing_run(cwd, run_id)?
        .ok_or_else(|| anyhow!("unknown Flowdex run: {run_id}"))
}

fn read_flag<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|item| item == flag)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn resolve_workflow_path(cwd: &Path, target: &str) -> PathBuf {
    let direct = cwd.join(target);
    if direct.is_file() {
        return direct;
    }
    let saved_ts = cwd
        .join(".flowdex")
        .join("workflows")
        .join(format!("{target}{WORKFLOW_TS_FILE_SUFFIX}"));
    if saved_ts.is_file() { saved_ts } else { direct }
}

fn print_help() {
    print!(
        "flowdex\n\nUsage:\n  flowdex preview <workflow.ts>\n  flowdex run <workflow.ts> [--input JSON|@file] [--yes]\n  flowdex init <code-audit|parallel-review|implementation-fanout> <workflow.ts>\n  flowdex skill install [--target <skill-dir>] [--json]\n  flowdex list\n  flowdex resume <run-id>\n  flowdex continue <run-id>\n  flowdex inspect <run-id>\n  flowdex report <run-id> [--path json.path] [--raw] [--paths]\n  flowdex next <run-id> --json [--files] [--limit N]\n  flowdex attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <id>\n  flowdex complete-agent <run-id> <child-key> --lease-token <token> --result @file\n  flowdex collect-results <run-id> [--continue] [--json]\n  flowdex status <run-id> [--json] [--compact]\n  flowdex watch <run-id>\n  flowdex pause <run-id>\n  flowdex stop <run-id>\n  flowdex repair-events <run-id>\n  flowdex restart-agent <run-id> <op-key>\n  flowdex save <run-id> <name>\n  flowdex workflow list\n"
    );
}

fn is_safe_workflow_name(value: &str) -> bool {
    is_safe_id(value)
}

fn collision_resistant_segment(value: &str) -> String {
    let readable = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(72)
        .collect::<String>();
    let readable = if readable.is_empty() {
        "task".to_string()
    } else {
        readable
    };
    format!(
        "{}-{}",
        readable,
        crate::canonical::sha256_bytes(value.as_bytes())
            .chars()
            .take(16)
            .collect::<String>()
    )
}

fn count_tasks(tasks: &[AgentTaskRecord]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for task in tasks {
        *counts.entry(task.status.clone()).or_insert(0) += 1;
    }
    counts
}

fn compact_status_task(cwd: &Path, run_id: &str, task: &AgentTaskRecord) -> Value {
    let run_root = cwd.join(".flowdex").join("runs").join(run_id);
    json!({
        "childKey": task.child_key,
        "taskId": task.task_id,
        "phase": task.phase,
        "adapter": task.adapter,
        "mode": task.mode,
        "status": task.status,
        "cwd": task.context_cwd,
        "leaseToken": task.lease_token,
        "leaseExpiresAt": task.lease_expires_at,
        "agentRef": task.agent_ref,
        "resultPath": task.lease_token.as_ref().map(|token| native_dispatch_result_path(&run_root, &task.child_key, token).to_string_lossy().into_owned()),
        "adapterStatus": task.result.as_ref().map(|result| result.status.clone()),
        "summary": task.result.as_ref().map(|result| result.summary.clone()),
        "error": task.error.clone().or_else(|| task.result.as_ref().and_then(|result| result.error.as_str().map(str::to_string)))
    })
}

fn format_watch(run_id: &str, run: Option<&Value>, tasks: &[AgentTaskRecord]) -> String {
    let counts = count_tasks(tasks);
    let mut lines = vec![
        format!("run: {run_id}"),
        format!(
            "status: {}",
            run.and_then(|item| item["status"].as_str())
                .unwrap_or("unknown")
        ),
        format!(
            "agents: total={} dispatchable={} leased={} dispatched={} completed={} failed={} blocked={}",
            tasks.len(),
            counts.get("dispatchable").copied().unwrap_or(0),
            counts.get("leased").copied().unwrap_or(0),
            counts.get("dispatched").copied().unwrap_or(0),
            counts.get("completed").copied().unwrap_or(0),
            counts.get("failed").copied().unwrap_or(0),
            counts.get("blocked").copied().unwrap_or(0),
        ),
    ];
    let mut by_phase = BTreeMap::<String, Vec<&AgentTaskRecord>>::new();
    for task in tasks {
        by_phase.entry(task.phase.clone()).or_default().push(task);
    }
    for (phase, phase_tasks) in by_phase {
        lines.push(format!("phase {phase}: {} task(s)", phase_tasks.len()));
        for task in phase_tasks {
            let summary = task
                .result
                .as_ref()
                .map(|result| result.summary.clone())
                .or_else(|| task.error.clone())
                .unwrap_or_default();
            lines.push(format!(
                "  {}\t{}\t{}\t{}",
                task.child_key, task.status, task.adapter, summary
            ));
        }
    }
    format!("{}\n", lines.join("\n"))
}

pub fn adapter_result_json_for_worker(
    status: &str,
    summary: &str,
    data: Value,
    error: Option<&str>,
) -> Result<String> {
    stable_stringify_pretty(&json!({
        "status": status,
        "summary": summary,
        "data": data,
        "claims": [],
        "artifacts": [],
        "diff": null,
        "usage": {},
        "error": error
    }))
}
