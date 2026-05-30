export function templateFor(kind: string): string {
  if (kind === "code-audit") return codeAuditTemplate();
  if (kind === "parallel-review") return parallelReviewTemplate();
  if (kind === "implementation-fanout") return implementationFanoutTemplate();
  throw new Error(`unknown Flowdex template kind: ${kind}`);
}

function header(name: string): string {
  return `import { workflow } from "@flowdex/runtime";

export default workflow({
  name: "${name}",
  maxAgents: 8,
  maxConcurrency: 4,
  permissions: {
    read: ["**"],
    write: [],
    hostCommands: [],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "review", maxAgents: 8 }]
}, async (ctx) => {
`;
}

function codeAuditTemplate(): string {
  return `${header("code-audit")}
  const findings = await ctx.fanout({
    id: "audit",
    phase: "review",
    tasks: [
      { id: "runtime", phase: "review", mode: "read-only", prompt: "Audit runtime orchestration and state handling. Return AdapterResult JSON with material findings only.", role: "runtime-reviewer" },
      { id: "policy", phase: "review", mode: "read-only", prompt: "Audit manifest/body policy and workflow validation. Return AdapterResult JSON with material findings only.", role: "policy-reviewer" },
      { id: "cli", phase: "review", mode: "read-only", prompt: "Audit CLI behavior, saved workflows, and bridge commands. Return AdapterResult JSON with material findings only.", role: "cli-reviewer" },
      { id: "tests", phase: "review", mode: "read-only", prompt: "Audit tests and acceptance gaps. Return AdapterResult JSON with material findings only.", role: "test-reviewer" }
    ]
  });
  return ctx.report({ title: "Code audit", findings });
});
`;
}

function parallelReviewTemplate(): string {
  return `${header("parallel-review")}
  const reviews = await ctx.fanout({
    id: "parallel-review",
    phase: "review",
    tasks: [
      { id: "correctness", phase: "review", mode: "read-only", prompt: "Review correctness risks. Return AdapterResult JSON.", role: "correctness-reviewer" },
      { id: "architecture", phase: "review", mode: "read-only", prompt: "Review architecture and maintainability risks. Return AdapterResult JSON.", role: "architecture-reviewer" },
      { id: "verification", phase: "review", mode: "read-only", prompt: "Review verification and test coverage risks. Return AdapterResult JSON.", role: "verification-reviewer" },
      { id: "ux", phase: "review", mode: "read-only", prompt: "Review user-facing workflow and observability risks. Return AdapterResult JSON.", role: "ux-reviewer" }
    ]
  });
  return ctx.report({ title: "Parallel review", reviews });
});
`;
}

function implementationFanoutTemplate(): string {
  return `${header("implementation-fanout").replace("write: [],", "write: [\"**\"],")}
  const plans = await ctx.fanout({
    id: "implementation-slices",
    phase: "review",
    tasks: [
      { id: "types-state", phase: "review", mode: "read-only", prompt: "Plan the type and state changes for this implementation. Return AdapterResult JSON.", role: "state-planner" },
      { id: "runtime-cli", phase: "review", mode: "read-only", prompt: "Plan the runtime and CLI changes for this implementation. Return AdapterResult JSON.", role: "runtime-planner" },
      { id: "tests-docs", phase: "review", mode: "read-only", prompt: "Plan tests, examples, and documentation changes. Return AdapterResult JSON.", role: "tests-planner" },
      { id: "risk-review", phase: "review", mode: "read-only", prompt: "Review integration risks before implementation. Return AdapterResult JSON.", role: "risk-reviewer" }
    ]
  });
  return ctx.report({ title: "Implementation fanout", plans });
});
`;
}
