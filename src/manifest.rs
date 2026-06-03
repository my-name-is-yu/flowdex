use crate::canonical::{
    canonicalize, hash_canonical, sha256_bytes, stable_stringify, to_canonical_value,
};
use crate::types::{ParsedWorkflow, WorkflowManifest};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;

pub const WORKFLOW_TS_FILE_SUFFIX: &str = ".ts";

const SNAPSHOT_POLICY_VERSION: &str = "flowdex-snapshot-policy-v0.6.0-rust";
const EVIDENCE_POLICY_VERSION: &str = "flowdex-evidence-policy-v0.6.0-rust";
const RUNTIME_VERSION: &str = "flowdex-runtime-v0.2.0-rust";
const DYNAMIC_PARSER_VERSION: &str = "flowdex-dynamic-ts-parser-v2";
const DYNAMIC_HARNESS_VERSION: &str = "flowdex-deno-harness-v2";

pub fn parse_workflow_source(source: &str, file_name: &str) -> Result<ParsedWorkflow> {
    if !file_name.ends_with(WORKFLOW_TS_FILE_SUFFIX) {
        bail!("{file_name}: workflow source file name must end in {WORKFLOW_TS_FILE_SUFFIX}");
    }
    let ParsedSource {
        manifest_source,
        callback_source,
        workflow_call_source,
    } = parse_source_shape(source, file_name)?;
    let manifest_value = canonicalize(&json5::from_str::<Value>(&manifest_source)?)?;
    let manifest: WorkflowManifest = serde_json::from_value(manifest_value.clone())?;
    validate_manifest_shape(&manifest)?;
    validate_callback_source(&callback_source, file_name)?;

    let source_hash = sha256_bytes(source.as_bytes());
    let manifest_hash = hash_canonical(&manifest_value)?;
    let transformed_source = format!(
        "function workflow(manifest, callback) {{ return {{ manifest, callback }}; }}\nconst __flowdexWorkflow = {workflow_call_source};\n"
    );
    let approval_payload = json!({
        "sourceHash": source_hash,
        "manifestHash": manifest_hash,
        "transformedHash": sha256_bytes(transformed_source.as_bytes()),
        "workflowFormatVersion": "flowdex.workflow.ts.v1",
        "parserVersion": DYNAMIC_PARSER_VERSION,
        "harnessVersion": DYNAMIC_HARNESS_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "snapshotPolicyVersion": SNAPSHOT_POLICY_VERSION,
        "evidencePolicyVersion": EVIDENCE_POLICY_VERSION,
        "permissionCapabilityPolicyHash": hash_canonical(&to_canonical_value(&manifest.permissions)?)?,
        "adapterPolicyHash": hash_canonical(&to_canonical_value(&manifest.adapters)?)?
    });
    let approval_hash = sha256_bytes(stable_stringify(&approval_payload)?);
    Ok(ParsedWorkflow {
        manifest,
        source_hash,
        manifest_hash,
        approval_hash,
        transformed_source,
    })
}

struct ParsedSource {
    manifest_source: String,
    callback_source: String,
    workflow_call_source: String,
}

fn parse_source_shape(source: &str, file_name: &str) -> Result<ParsedSource> {
    let after_import = strip_runtime_import(source).ok_or_else(|| {
        anyhow!(
            "{file_name}: workflow.ts must start with import {{ workflow }} from \"@flowdex/runtime\""
        )
    })?;
    let export_offset = skip_js_space_and_comments(after_import, 0)?;
    let export_prefix = "export default workflow(";
    if !after_import[export_offset..].starts_with(export_prefix) {
        bail!("{file_name}: second statement must be export default workflow(...)");
    }
    let call_start = export_offset + "export default ".len();
    let open_paren = export_offset + export_prefix.len() - 1;
    let manifest_start = skip_js_space_and_comments(after_import, open_paren + 1)?;
    if after_import.as_bytes().get(manifest_start) != Some(&b'{') {
        bail!("{file_name}: workflow manifest must be a static object literal");
    }
    let manifest_end = find_matching_delimiter(after_import, manifest_start, b'{', b'}')?;
    let comma = skip_js_space_and_comments(after_import, manifest_end + 1)?;
    if after_import.as_bytes().get(comma) != Some(&b',') {
        bail!("{file_name}: workflow(...) must receive manifest and callback");
    }
    let callback_start = skip_js_space_and_comments(after_import, comma + 1)?;
    let close_paren = find_matching_delimiter(after_import, open_paren, b'(', b')')?;
    let after_call = skip_js_space_and_comments(after_import, close_paren + 1)?;
    let after_semicolon = if after_import.as_bytes().get(after_call) == Some(&b';') {
        skip_js_space_and_comments(after_import, after_call + 1)?
    } else {
        after_call
    };
    if after_semicolon != after_import.len() {
        bail!(
            "{file_name}: workflow source must contain only the runtime import and export default workflow(...)"
        );
    }
    Ok(ParsedSource {
        manifest_source: after_import[manifest_start..=manifest_end].to_string(),
        callback_source: after_import[callback_start..close_paren].trim().to_string(),
        workflow_call_source: after_import[call_start..=close_paren].to_string(),
    })
}

fn strip_runtime_import(source: &str) -> Option<&str> {
    let trimmed = source.trim_start_matches('\u{feff}').trim_start();
    let pattern =
        Regex::new(r#"^import\s*\{\s*workflow\s*\}\s*from\s*["']@flowdex/runtime["']\s*;"#)
            .expect("runtime import regex is valid");
    pattern
        .find(trimmed)
        .map(|matched| &trimmed[matched.end()..])
}

fn validate_callback_source(callback: &str, file_name: &str) -> Result<()> {
    let callback = callback.trim();
    if !callback.starts_with("async ") && !callback.starts_with("async(") {
        bail!("{file_name}: workflow callback must be async");
    }
    if callback.contains("import(") {
        bail!("{file_name}: dynamic imports are not allowed in workflow callbacks");
    }
    Ok(())
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

    if manifest.phases.is_empty() {
        bail!("manifest.phases must be a non-empty array");
    }
    let mut phases = HashSet::new();
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
    let manifest_json = stable_stringify(&to_canonical_value(manifest)?)?;
    Ok(format!(
        "Flowdex preview\nworkflow: {}\nformat: flowdex.workflow.ts.v1\nsourceHash: {}\nmanifestHash: {}\napprovalHash: {}\nmaxAgents: {}\nmaxConcurrency: {}\ndefaultAdapter: {}\nnetwork: {}\nread: {}\nwrite: {}\nphases: {}\nsteps: dynamic-callback\nmanifest: {}",
        manifest.name,
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
        manifest_json
    ))
}

fn skip_js_space_and_comments(source: &str, mut index: usize) -> Result<usize> {
    let bytes = source.as_bytes();
    loop {
        while let Some(byte) = bytes.get(index)
            && byte.is_ascii_whitespace()
        {
            index += 1;
        }
        if bytes.get(index) == Some(&b'/') && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while let Some(byte) = bytes.get(index)
                && *byte != b'\n'
            {
                index += 1;
            }
            continue;
        }
        if bytes.get(index) == Some(&b'/') && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            let Some(end) = source[index..].find("*/") else {
                bail!("unterminated block comment in workflow source");
            };
            index += end + 2;
            continue;
        }
        return Ok(index);
    }
}

fn find_matching_delimiter(source: &str, open_index: usize, open: u8, close: u8) -> Result<usize> {
    let bytes = source.as_bytes();
    if bytes.get(open_index) != Some(&open) {
        bail!("workflow parser expected delimiter {}", open as char);
    }
    let mut index = open_index;
    let mut depth = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                index = skip_js_string(source, index)?;
            }
            b'/' if bytes.get(index + 1) == Some(&b'/') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                let Some(end) = source[index..].find("*/") else {
                    bail!("unterminated block comment in workflow source");
                };
                index += end + 2;
            }
            byte if byte == open => {
                depth += 1;
                index += 1;
            }
            byte if byte == close => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| anyhow!("unbalanced workflow source delimiter"))?;
                if depth == 0 {
                    return Ok(index);
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    bail!("unterminated workflow source delimiter {}", open as char)
}

fn skip_js_string(source: &str, start: usize) -> Result<usize> {
    let bytes = source.as_bytes();
    let quote = bytes[start];
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index += 2;
            continue;
        }
        if bytes[index] == quote {
            return Ok(index + 1);
        }
        index += 1;
    }
    bail!("unterminated string literal in workflow source")
}

pub fn is_safe_id(value: &str) -> bool {
    static SAFE_ID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    SAFE_ID
        .get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]{1,120}$").expect("safe id regex is valid"))
        .is_match(value)
}
