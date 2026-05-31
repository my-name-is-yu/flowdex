use flowdex::adapter_result::validate_adapter_result;
use flowdex::manifest::{parse_run_workflow_source, parse_workflow_document};
use flowdex::native_dispatch::write_native_dispatch_file_package;
use flowdex::report_path::read_report_path;
use flowdex::runtime::{FlowdexRuntime, RuntimeOptions};
use flowdex::types::NativeDispatch;
use serde_json::json;
use std::fs;

#[test]
fn parses_bundled_examples() {
    let root = env!("CARGO_MANIFEST_DIR");
    let hello = fs::read_to_string(format!("{root}/examples/hello.flowdex.json")).unwrap();
    let code_audit =
        fs::read_to_string(format!("{root}/examples/code-audit.flowdex.json")).unwrap();

    let hello = parse_workflow_document(&hello, "examples/hello.flowdex.json").unwrap();
    let code_audit =
        parse_workflow_document(&code_audit, "examples/code-audit.flowdex.json").unwrap();

    assert_eq!(hello.manifest.name, "hello-host-command");
    assert_eq!(code_audit.manifest.name, "code-audit");
    assert_eq!(code_audit.manifest.phases[0].id, "review");
    assert_eq!(hello.approval_hash.len(), 64);
    assert_eq!(hello.document.steps.len(), 3);
}

#[test]
fn rejects_import_prefixed_workflow_source() {
    let source = r#"import "flowdex";
{
  "version": "flowdex.workflow.v1",
  "manifest": {},
  "steps": []
}
"#;
    let file_name = "workflow.flowdex.json";
    let error = parse_run_workflow_source(source, &file_name)
        .unwrap_err()
        .to_string();

    assert!(error.contains("workflow source must be a static .flowdex.json document"));
}

#[test]
fn validates_exact_adapter_result_envelope() {
    let value = json!({
        "status": "completed",
        "summary": "done",
        "data": { "value": 1 },
        "claims": [],
        "artifacts": [],
        "diff": null,
        "usage": {},
        "error": null
    });
    assert_eq!(validate_adapter_result(value).unwrap().status, "completed");

    let invalid = json!({
        "status": "completed",
        "summary": "done",
        "data": {},
        "claims": [],
        "artifacts": [],
        "diff": null,
        "usage": {},
        "error": null,
        "extra": true
    });
    assert!(validate_adapter_result(invalid).is_err());
}

#[test]
fn runs_host_command_example_to_completed_report() {
    let root = env!("CARGO_MANIFEST_DIR");
    let temp = tempfile::tempdir().unwrap();
    let mut options = RuntimeOptions::new(temp.path().to_path_buf());
    options.auto_approve = true;
    let summary = FlowdexRuntime::new(options)
        .run(&std::path::Path::new(root).join("examples/hello.flowdex.json"))
        .unwrap();

    assert_eq!(summary.status, "completed");
    assert_eq!(summary.report.unwrap()["title"], "Hello host command");
}

#[test]
fn writes_native_dispatch_file_package() {
    let temp = tempfile::tempdir().unwrap();
    let dispatch = NativeDispatch {
        run_id: "run".to_string(),
        child_key: "fanout:review#runtime".to_string(),
        parent_op_key: "fanout:review".to_string(),
        task_id: "runtime".to_string(),
        phase: "review".to_string(),
        adapter: "codex-native".to_string(),
        mode: "read-only".to_string(),
        prompt: "Review the runtime".to_string(),
        schema: None,
        data: Some(json!({ "notes": "large payload stays in task.json" })),
        cwd: temp.path().to_string_lossy().into_owned(),
        lease_token: "lease-token".to_string(),
        lease_expires_at: "2030-01-01T00:00:00.000Z".to_string(),
        model: Some("gpt-5-codex".to_string()),
        reasoning_effort: Some("high".to_string()),
        network: Some("web".to_string()),
        role: Some("runtime-reviewer".to_string()),
        nickname: None,
    };

    let package = write_native_dispatch_file_package(temp.path(), &dispatch).unwrap();
    assert!(package.task_path.ends_with("task.json"));
    assert!(package.instruction_path.ends_with("instructions.md"));
    assert!(package.result_path.ends_with("adapter-result.json"));
    assert!(!package.agent_prompt.contains("large payload"));
    assert!(
        fs::read_to_string(package.task_path)
            .unwrap()
            .contains("large payload")
    );
}

#[test]
fn reads_report_paths() {
    let report = json!({ "result": { "items": [{ "summary": "ok" }] } });
    assert_eq!(
        read_report_path(&report, "result.items.0.summary").unwrap(),
        "ok"
    );
    assert!(read_report_path(&report, "result.items.nope").is_err());
}
