use crate::artifacts::ArtifactStore;
use crate::types::{ArtifactRecord, HostCommandSpec};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::process::{Command, Stdio};

const DEFAULT_MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct HostCommandResult {
    pub status: String,
    pub artifacts: Vec<ArtifactRecord>,
    pub data: Value,
}

pub fn run_host_command(
    spec: &HostCommandSpec,
    cwd: &std::path::Path,
    artifact_store: &ArtifactStore,
    inherit_env: &[String],
) -> Result<HostCommandResult> {
    let Some((program, args)) = spec.argv.split_first() else {
        bail!("host command argv must be non-empty");
    };
    let max_output_bytes = spec.max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES);
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    for key in inherit_env {
        if key == "PATH" {
            continue;
        }
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = command.output()?;
    let (stdout, stdout_truncated) = bounded_output(&output.stdout, max_output_bytes);
    let (stderr, stderr_truncated) = bounded_output(&output.stderr, max_output_bytes);
    let stdout_record = artifact_store.write(
        &stdout,
        "text/plain",
        Some(&format!("hostCommand:{}:stdout", spec.id)),
    )?;
    let stderr_record = artifact_store.write(
        &stderr,
        "text/plain",
        Some(&format!("hostCommand:{}:stderr", spec.id)),
    )?;
    let exit_code = output.status.code();
    let output_limit_exceeded = stdout_truncated || stderr_truncated;
    Ok(HostCommandResult {
        status: if exit_code == Some(0) && !output_limit_exceeded {
            "completed".to_string()
        } else {
            "failed".to_string()
        },
        artifacts: vec![stdout_record.clone(), stderr_record.clone()],
        data: json!({
            "command": spec.argv,
            "exitCode": exit_code,
            "stdoutArtifactId": stdout_record.id,
            "stderrArtifactId": stderr_record.id,
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated,
            "maxOutputBytes": max_output_bytes
        }),
    })
}

fn bounded_output(bytes: &[u8], max_bytes: usize) -> (Vec<u8>, bool) {
    if bytes.len() <= max_bytes {
        return (bytes.to_vec(), false);
    }
    (bytes[..max_bytes].to_vec(), true)
}

pub fn env_inherit_list(value: &Option<crate::types::EnvPolicy>) -> Vec<String> {
    value
        .as_ref()
        .map(|env| env.inherit.clone())
        .unwrap_or_default()
}

pub fn command_result_for_storage(status: &str, data: Value) -> Value {
    let mut object = BTreeMap::new();
    object.insert("status".to_string(), Value::String(status.to_string()));
    object.insert("data".to_string(), data);
    serde_json::to_value(object).unwrap_or(Value::Null)
}
