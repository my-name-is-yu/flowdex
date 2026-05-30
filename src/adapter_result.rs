use crate::canonical::canonicalize;
use crate::types::{AdapterResult, ArtifactRecord, Claim, EvidenceRef};
use anyhow::{Result, anyhow};
use serde_json::{Map, Value};

const TOP_LEVEL_FIELDS: &[&str] = &[
    "status",
    "summary",
    "data",
    "claims",
    "artifacts",
    "diff",
    "usage",
    "error",
];

pub fn validate_adapter_result(value: Value) -> Result<AdapterResult> {
    let canonical = canonicalize(&value)?;
    let object = canonical
        .as_object()
        .ok_or_else(|| anyhow!("adapter result must be an object"))?;
    if object.len() != TOP_LEVEL_FIELDS.len() {
        return Err(anyhow!(
            "adapter result must have exactly {} top-level fields",
            TOP_LEVEL_FIELDS.len()
        ));
    }
    for key in object.keys() {
        if !TOP_LEVEL_FIELDS.contains(&key.as_str()) {
            return Err(anyhow!("unexpected adapter result field: {key}"));
        }
    }
    let result: AdapterResult = serde_json::from_value(canonical)?;
    if !matches!(
        result.status.as_str(),
        "completed" | "failed" | "blocked" | "needs-approval"
    ) {
        return Err(anyhow!("invalid adapter status"));
    }
    if !result.error.is_null() && !result.error.is_string() {
        return Err(anyhow!("adapter error must be string or null"));
    }
    for claim in &result.claims {
        validate_claim(claim)?;
    }
    for artifact in &result.artifacts {
        validate_artifact_record(artifact)?;
    }
    Ok(result)
}

pub fn agent_task_status_for_result(result: &AdapterResult) -> &'static str {
    match result.status.as_str() {
        "completed" => "completed",
        "blocked" | "needs-approval" => "blocked",
        _ => "failed",
    }
}

pub fn sanitize_adapter_result_for_storage(result: &AdapterResult) -> AdapterResult {
    if result.claims.is_empty() && result.artifacts.is_empty() {
        return result.clone();
    }
    let mut data = match result.data.as_object() {
        Some(object) => object.clone(),
        None => {
            let mut object = Map::new();
            object.insert("value".to_string(), result.data.clone());
            object
        }
    };
    if !result.claims.is_empty() {
        data.insert(
            "flowdexUntrustedClaims".to_string(),
            serde_json::to_value(&result.claims).unwrap_or(Value::Array(vec![])),
        );
    }
    if !result.artifacts.is_empty() {
        data.insert(
            "flowdexUntrustedArtifacts".to_string(),
            serde_json::to_value(&result.artifacts).unwrap_or(Value::Array(vec![])),
        );
    }
    AdapterResult {
        data: Value::Object(data),
        claims: vec![],
        artifacts: vec![],
        ..result.clone()
    }
}

fn validate_claim(claim: &Claim) -> Result<()> {
    if claim.id.is_empty() || claim.text.is_empty() {
        return Err(anyhow!("adapter claim id/text must be strings"));
    }
    if !matches!(
        claim.kind.as_str(),
        "finding" | "change" | "verification" | "blocker" | "risk"
    ) {
        return Err(anyhow!("adapter claim kind is invalid"));
    }
    if !matches!(claim.confidence.as_str(), "high" | "medium" | "low") {
        return Err(anyhow!("adapter claim confidence is invalid"));
    }
    for evidence in &claim.evidence {
        validate_evidence_ref(evidence)?;
    }
    Ok(())
}

fn validate_evidence_ref(evidence: &EvidenceRef) -> Result<()> {
    match evidence {
        EvidenceRef::FileRange {
            path,
            start_line,
            end_line,
            content_hash,
        } => {
            if path.is_empty()
                || *start_line == 0
                || end_line < start_line
                || content_hash.is_empty()
            {
                return Err(anyhow!("adapter fileRange evidence is invalid"));
            }
        }
        EvidenceRef::Command {
            artifact_id,
            command,
            ..
        }
        | EvidenceRef::Test {
            artifact_id,
            command,
            ..
        } => {
            if artifact_id.is_empty() || command.is_empty() || command.iter().any(String::is_empty)
            {
                return Err(anyhow!("adapter command/test evidence is invalid"));
            }
        }
        EvidenceRef::DiffHunk {
            artifact_id,
            file,
            hunk_hash,
        } => {
            if artifact_id.is_empty() || file.is_empty() || hunk_hash.is_empty() {
                return Err(anyhow!("adapter diffHunk evidence is invalid"));
            }
        }
        EvidenceRef::AgentResult {
            task_id,
            artifact_id,
        } => {
            if task_id.is_empty() || artifact_id.is_empty() {
                return Err(anyhow!("adapter agentResult evidence is invalid"));
            }
        }
        EvidenceRef::SchemaValidation {
            schema,
            artifact_id,
            status,
        } => {
            if schema.is_empty()
                || artifact_id.is_empty()
                || !matches!(status.as_str(), "passed" | "failed")
            {
                return Err(anyhow!("adapter schemaValidation evidence is invalid"));
            }
        }
    }
    Ok(())
}

fn validate_artifact_record(artifact: &ArtifactRecord) -> Result<()> {
    if artifact.id.is_empty()
        || artifact.sha256.is_empty()
        || artifact.media_type.is_empty()
        || artifact.path.is_empty()
    {
        return Err(anyhow!("adapter artifact record is invalid"));
    }
    if !matches!(artifact.redaction_status.as_str(), "none" | "redacted") {
        return Err(anyhow!("adapter artifact redactionStatus is invalid"));
    }
    Ok(())
}
