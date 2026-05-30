use crate::canonical::{hash_canonical, sha256_bytes, stable_stringify, to_canonical_value};
use crate::types::{ParsedWorkflow, WorkflowManifest};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;

const BODY_POLICY_VERSION: &str = "flowdex-body-policy-v0.5.0-rust";
const SNAPSHOT_POLICY_VERSION: &str = "flowdex-snapshot-policy-v0.5.0-rust";
const EVIDENCE_POLICY_VERSION: &str = "flowdex-evidence-policy-v0.5.0-rust";
const RUNTIME_VERSION: &str = "flowdex-runtime-v0.1.0-rust";

pub fn parse_workflow_source(source: &str, file_name: &str) -> Result<ParsedWorkflow> {
    validate_runtime_import(source)?;
    let workflow_start = source
        .find("workflow")
        .ok_or_else(|| anyhow!("{file_name}: export default must call workflow(...)"))?;
    let open_paren = source[workflow_start..]
        .find('(')
        .map(|index| workflow_start + index)
        .ok_or_else(|| anyhow!("{file_name}: workflow(...) must receive manifest and callback"))?;
    let manifest_start = next_non_ws(source, open_paren + 1)
        .ok_or_else(|| anyhow!("{file_name}: workflow manifest is missing"))?;
    if source.as_bytes().get(manifest_start) != Some(&b'{') {
        bail!("{file_name}: workflow manifest must be a static object literal");
    }
    let manifest_end = find_matching(source, manifest_start, b'{', b'}')?;
    let manifest_text = &source[manifest_start..=manifest_end];
    let callback_start = source[manifest_end + 1..]
        .find("async")
        .map(|index| manifest_end + 1 + index)
        .ok_or_else(|| anyhow!("{file_name}: workflow callback must be async"))?;
    let body_start = source[callback_start..]
        .find('{')
        .map(|index| callback_start + index)
        .ok_or_else(|| anyhow!("{file_name}: workflow body must be a block"))?;
    let body_end = find_matching(source, body_start, b'{', b'}')?;
    let body = source[body_start + 1..body_end].to_string();
    validate_body_policy(&body)?;

    let manifest_value = crate::canonical::canonicalize(&json5::from_str::<Value>(manifest_text)?)?;
    let manifest: WorkflowManifest = serde_json::from_value(manifest_value.clone())?;
    validate_manifest_shape(&manifest)?;

    let source_hash = sha256_bytes(source.as_bytes());
    let manifest_hash = hash_canonical(&manifest_value)?;
    let approval_hash = sha256_bytes(stable_stringify(&json!({
        "sourceHash": source_hash,
        "manifestHash": manifest_hash,
        "bodyPolicyVersion": BODY_POLICY_VERSION,
        "parserVersion": "json5+flowdex-rust",
        "transformVersion": "flowdex-rust-interpreter",
        "harnessVersion": "flowdex-harness-v0.5.0-rust",
        "runtimeVersion": RUNTIME_VERSION,
        "snapshotPolicyVersion": SNAPSHOT_POLICY_VERSION,
        "evidencePolicyVersion": EVIDENCE_POLICY_VERSION,
        "permissionCapabilityPolicyHash": hash_canonical(&to_canonical_value(&manifest.permissions)?)?,
        "adapterPolicyHash": hash_canonical(&to_canonical_value(&manifest.adapters)?)?
    }))?);

    Ok(ParsedWorkflow {
        manifest,
        source_hash,
        manifest_hash,
        approval_hash,
        workflow_body: body,
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
    let manifest_json = stable_stringify(&to_canonical_value(manifest)?)?;
    Ok(format!(
        "Flowdex preview\nworkflow: {}\nsourceHash: {}\nmanifestHash: {}\napprovalHash: {}\nmaxAgents: {}\nmaxConcurrency: {}\ndefaultAdapter: {}\nnetwork: {}\nread: {}\nwrite: {}\nphases: {}\nmanifest: {}",
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

fn validate_runtime_import(source: &str) -> Result<()> {
    let import_re =
        Regex::new(r#"(?m)^\s*import\s*\{\s*workflow\s*\}\s*from\s*["']@flowdex/runtime["'];\s*"#)?;
    if !import_re.is_match(source) {
        bail!("first statement must be import {{ workflow }} from \"@flowdex/runtime\"");
    }
    let export_count = source.matches("export default workflow").count();
    if export_count != 1 {
        bail!("workflow source must contain exactly one export default workflow call");
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

fn validate_body_policy(body: &str) -> Result<()> {
    let searchable = erase_strings_and_comments(body);
    let forbidden = [
        "globalThis",
        "Date",
        "eval",
        "Function",
        "Promise",
        "process",
        "Deno",
        "fetch",
        "console",
        "Buffer",
        "setTimeout",
        "setInterval",
        "new ",
        "class ",
        "try ",
        "catch ",
        "constructor",
        "__proto__",
        "ctx =",
        "ctx.",
    ];
    for token in forbidden {
        if token == "ctx." {
            continue;
        }
        if searchable.contains(token) {
            bail!("workflow body contains forbidden construct: {token}");
        }
    }
    let allowed_ctx = Regex::new(
        r#"ctx\.(agent|fanout|hostCommand|integrate|claim|report|now|isFlowdexPending)\s*\("#,
    )?;
    for captures in Regex::new(r#"ctx\.[A-Za-z_][A-Za-z0-9_]*"#)?.find_iter(body) {
        let tail = &body[captures.start()..];
        if !allowed_ctx.is_match(tail) {
            bail!(
                "workflow body contains unsupported ctx access: {}",
                captures.as_str()
            );
        }
    }
    Ok(())
}

fn erase_strings_and_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len());
    let mut index = 0usize;
    let mut string_quote: Option<u8> = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
                output.push('\n');
            } else {
                output.push(' ');
            }
            index += 1;
            continue;
        }
        if block_comment {
            if byte == b'*' && next == Some(b'/') {
                output.push_str("  ");
                block_comment = false;
                index += 2;
            } else {
                output.push(if byte == b'\n' { '\n' } else { ' ' });
                index += 1;
            }
            continue;
        }
        if let Some(quote) = string_quote {
            output.push(if byte == b'\n' { '\n' } else { ' ' });
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                string_quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && next == Some(b'/') {
            output.push_str("  ");
            line_comment = true;
            index += 2;
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            output.push_str("  ");
            block_comment = true;
            index += 2;
            continue;
        }
        if matches!(byte, b'"' | b'\'' | b'`') {
            output.push(' ');
            string_quote = Some(byte);
            index += 1;
            continue;
        }
        output.push(byte as char);
        index += 1;
    }
    output
}

pub fn is_safe_id(value: &str) -> bool {
    !matches!(value, "." | "..")
        && value.len() <= 120
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

pub fn find_matching(text: &str, start: usize, open: u8, close: u8) -> Result<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut index = start;
    let mut string_quote: Option<u8> = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            if byte == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if block_comment {
            if byte == b'*' && next == Some(b'/') {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(quote) = string_quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                string_quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && next == Some(b'/') {
            line_comment = true;
            index += 2;
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            block_comment = true;
            index += 2;
            continue;
        }
        if matches!(byte, b'"' | b'\'' | b'`') {
            string_quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == open {
            depth += 1;
        } else if byte == close {
            depth = depth
                .checked_sub(1)
                .ok_or_else(|| anyhow!("unbalanced delimiter"))?;
            if depth == 0 {
                return Ok(index);
            }
        }
        index += 1;
    }
    bail!("unclosed delimiter")
}

fn next_non_ws(text: &str, start: usize) -> Option<usize> {
    text.as_bytes()[start..]
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|offset| start + offset)
}
