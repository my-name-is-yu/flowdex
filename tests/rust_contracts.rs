use flowdex::adapter_result::validate_adapter_result;
use flowdex::dynamic_sandbox::run_dynamic_workflow_tick;
use flowdex::manifest::parse_workflow_source;
use flowdex::native_dispatch::write_native_dispatch_file_package;
use flowdex::report_path::read_report_path;
use flowdex::runtime::{FlowdexRuntime, RuntimeOptions};
use flowdex::skill::{bundled_skill_source, install_skill_from};
use flowdex::types::NativeDispatch;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;

#[test]
fn parses_bundled_examples() {
    let root = env!("CARGO_MANIFEST_DIR");
    let hello = fs::read_to_string(format!("{root}/examples/hello.ts")).unwrap();
    let dynamic_code_audit = fs::read_to_string(format!("{root}/examples/code-audit.ts")).unwrap();

    let hello = parse_workflow_source(&hello, "examples/hello.ts").unwrap();
    let dynamic_code_audit =
        parse_workflow_source(&dynamic_code_audit, "examples/code-audit.ts").unwrap();

    assert_eq!(hello.manifest.name, "hello-host-command");
    assert_eq!(dynamic_code_audit.manifest.name, "code-audit");
    assert_eq!(dynamic_code_audit.manifest.phases[0].id, "review");
    assert_eq!(hello.approval_hash.len(), 64);
    assert!(hello.transformed_source.contains("__flowdexWorkflow"));
}

#[test]
fn rejects_non_ts_workflow_source() {
    let source = r#"import "flowdex";
{
  "version": "flowdex.workflow.v1",
  "manifest": {},
  "steps": []
}
"#;
    let file_name = "workflow.json";
    let error = parse_workflow_source(source, &file_name)
        .unwrap_err()
        .to_string();

    assert!(error.contains("workflow source file name must end in .ts"));
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
fn runs_dynamic_host_command_example_to_completed_report() {
    let root = env!("CARGO_MANIFEST_DIR");
    let temp = tempfile::tempdir().unwrap();
    let mut options = RuntimeOptions::new(temp.path().to_path_buf());
    options.auto_approve = true;
    let summary = FlowdexRuntime::new(options)
        .run(&std::path::Path::new(root).join("examples/hello.ts"))
        .unwrap();

    assert_eq!(summary.status, "completed");
    assert_eq!(summary.report.unwrap()["title"], "Hello host command");
}

#[test]
fn dynamic_sandbox_suspends_and_replays_durable_operations() {
    let root = env!("CARGO_MANIFEST_DIR");
    let source = fs::read_to_string(format!("{root}/examples/hello.ts")).unwrap();
    let parsed = parse_workflow_source(&source, "examples/hello.ts").unwrap();
    let first = run_dynamic_workflow_tick(
        &parsed.transformed_source,
        &json!({}),
        "2026-05-29T00:00:00.000Z",
        &BTreeMap::new(),
    )
    .unwrap();
    let flowdex::types::TickResult::Pending { scheduled } = first else {
        panic!("expected pending dynamic tick");
    };
    assert_eq!(scheduled[0].kind, "hostCommand");
    assert_eq!(scheduled[0].id, "hello.run");

    let mut results = BTreeMap::new();
    results.insert(
        "hostCommand:hello.run".to_string(),
        json!({
            "status": "completed",
            "data": {
                "exitCode": 0,
                "stdoutArtifactId": "stdout-1"
            }
        }),
    );
    let second = run_dynamic_workflow_tick(
        &parsed.transformed_source,
        &json!({}),
        "2026-05-29T00:00:00.000Z",
        &results,
    )
    .unwrap();
    let flowdex::types::TickResult::Completed { staged, .. } = second else {
        panic!("expected completed dynamic tick");
    };
    assert_eq!(staged.reports[0]["exitCode"], 0);
    assert_eq!(staged.reports[0]["stdoutArtifactId"], "stdout-1");
}

#[test]
fn dynamic_workflow_can_build_fanout_from_runtime_input() {
    let source = r#"import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "dynamic-input-fanout",
  maxAgents: 8,
  maxConcurrency: 4,
  defaultAdapter: "codex-native",
  permissions: {
    read: ["README.md"],
    write: [],
    hostCommands: [],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "review", maxAgents: 8 }]
}, async (ctx) => {
  const tasks = [];
  for (let index = 0; index < ctx.input.count; index++) {
    tasks.push({
      id: `review-${index}`,
      phase: "review",
      mode: "read-only",
      prompt: `Review shard ${index}. Return AdapterResult JSON.`
    });
  }
  const reviews = await ctx.fanout({ id: `dynamic-${ctx.input.count}`, phase: "review", tasks });
  return ctx.report({ count: reviews.length });
});"#;
    let parsed = parse_workflow_source(source, "dynamic-input-fanout.ts").unwrap();
    let first = run_dynamic_workflow_tick(
        &parsed.transformed_source,
        &json!({ "count": 3 }),
        "2026-05-29T00:00:00.000Z",
        &BTreeMap::new(),
    )
    .unwrap();
    let flowdex::types::TickResult::Pending { scheduled } = first else {
        panic!("expected pending dynamic tick");
    };
    assert_eq!(scheduled[0].kind, "fanout");
    assert_eq!(scheduled[0].id, "dynamic-3");
    assert_eq!(scheduled[0].args["tasks"].as_array().unwrap().len(), 3);
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

#[test]
fn installs_bundled_flowdex_skill() {
    let temp = tempfile::tempdir().unwrap();
    let destination = temp
        .path()
        .join("codex-home")
        .join("skills")
        .join("flowdex");
    let summary = install_skill_from(&bundled_skill_source().unwrap(), &destination).unwrap();

    assert_eq!(summary.skill, "flowdex");
    assert!(summary.files_copied >= 2);
    assert!(destination.join("SKILL.md").is_file());
    assert!(destination.join("agents/openai.yaml").is_file());
    assert!(
        fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("Flowdex")
    );
}
