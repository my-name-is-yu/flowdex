import { workflow } from "@flowdex/runtime";

export default workflow({
  name: "code-audit",
  maxAgents: 8,
  maxConcurrency: 4,
  defaultAdapter: "codex-native",
  permissions: {
    read: ["src/**", "tests/**", "README.md", "skills/**"],
    write: [],
    hostCommands: [],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "review", maxAgents: 4 }]
}, async (ctx) => {
  const findings = await ctx.fanout({
    id: "audit",
    phase: "review",
    tasks: [
      { id: "runtime", phase: "review", mode: "read-only", prompt: "Review Flowdex runtime orchestration, durable state, and dispatch behavior. Return AdapterResult JSON with material findings only.", role: "runtime-reviewer" },
      { id: "policy", phase: "review", mode: "read-only", prompt: "Review manifest and workflow body validation. Return AdapterResult JSON with material findings only.", role: "policy-reviewer" },
      { id: "cli", phase: "review", mode: "read-only", prompt: "Review CLI commands and user workflow. Return AdapterResult JSON with material findings only.", role: "cli-reviewer" },
      { id: "tests", phase: "review", mode: "read-only", prompt: "Review test coverage and acceptance gaps. Return AdapterResult JSON with material findings only.", role: "test-reviewer" }
    ]
  });
  return ctx.report({ title: "Code audit", findings });
});
