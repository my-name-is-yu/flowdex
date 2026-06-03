use anyhow::{Result, bail};

pub fn template_for(kind: &str) -> Result<String> {
    match kind {
        "code-audit" => Ok(code_audit_template()),
        "parallel-review" => Ok(parallel_review_template()),
        "implementation-fanout" => Ok(implementation_fanout_template()),
        _ => bail!("unknown Flowdex template kind: {kind}"),
    }
}

fn workflow_template(name: &str, max_agents: u64, phase_max_agents: u64, body: &str) -> String {
    format!(
        r#"import {{ workflow }} from "@flowdex/runtime";

export default workflow({{
  name: "{name}",
  maxAgents: {max_agents},
  maxConcurrency: 4,
  defaultAdapter: "codex-native",
  permissions: {{
    read: ["src/**", "tests/**", "examples/**", "skills/**", "README.md"],
    write: [],
    hostCommands: [],
    network: "none",
    env: {{ inherit: [] }}
  }},
  phases: [{{ id: "review", maxAgents: {phase_max_agents} }}]
}}, async (ctx) => {{
{body}
}});
"#
    )
}

fn code_audit_template() -> String {
    workflow_template(
        "code-audit",
        8,
        4,
        r#"  const findings = await ctx.fanout({
    id: "audit",
    phase: "review",
    tasks: [
      { id: "runtime", phase: "review", mode: "read-only", prompt: "Audit runtime orchestration and state handling. Return AdapterResult JSON with material findings only.", role: "runtime-reviewer" },
      { id: "policy", phase: "review", mode: "read-only", prompt: "Audit manifest policy and workflow validation. Return AdapterResult JSON with material findings only.", role: "policy-reviewer" },
      { id: "cli", phase: "review", mode: "read-only", prompt: "Audit CLI behavior, saved workflows, and bridge commands. Return AdapterResult JSON with material findings only.", role: "cli-reviewer" },
      { id: "tests", phase: "review", mode: "read-only", prompt: "Audit tests and acceptance gaps. Return AdapterResult JSON with material findings only.", role: "test-reviewer" }
    ]
  });
  return ctx.report({ title: "Code audit", findings });"#,
    )
}

fn parallel_review_template() -> String {
    workflow_template(
        "parallel-review",
        8,
        4,
        r#"  const reviews = await ctx.fanout({
    id: "parallel-review",
    phase: "review",
    tasks: [
      { id: "correctness", phase: "review", mode: "read-only", prompt: "Review correctness risks. Return AdapterResult JSON.", role: "correctness-reviewer" },
      { id: "architecture", phase: "review", mode: "read-only", prompt: "Review architecture and maintainability risks. Return AdapterResult JSON.", role: "architecture-reviewer" },
      { id: "verification", phase: "review", mode: "read-only", prompt: "Review verification and test coverage risks. Return AdapterResult JSON.", role: "verification-reviewer" },
      { id: "ux", phase: "review", mode: "read-only", prompt: "Review user-facing workflow and observability risks. Return AdapterResult JSON.", role: "ux-reviewer" }
    ]
  });
  return ctx.report({ title: "Parallel review", reviews });"#,
    )
}

fn implementation_fanout_template() -> String {
    workflow_template(
        "implementation-fanout",
        8,
        4,
        r#"  const plans = await ctx.fanout({
    id: "implementation-slices",
    phase: "review",
    tasks: [
      { id: "types-state", phase: "review", mode: "read-only", prompt: "Plan the type and state changes for this implementation. Return AdapterResult JSON.", role: "state-planner" },
      { id: "runtime-cli", phase: "review", mode: "read-only", prompt: "Plan the runtime and CLI changes for this implementation. Return AdapterResult JSON.", role: "runtime-planner" },
      { id: "tests-docs", phase: "review", mode: "read-only", prompt: "Plan tests, examples, and documentation changes. Return AdapterResult JSON.", role: "tests-planner" },
      { id: "risk-review", phase: "review", mode: "read-only", prompt: "Review integration risks before implementation. Return AdapterResult JSON.", role: "risk-reviewer" }
    ]
  });
  return ctx.report({ title: "Implementation fanout", plans });"#,
    )
}
