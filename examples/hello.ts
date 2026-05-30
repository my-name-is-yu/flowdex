import { workflow } from "@flowdex/runtime";

export default workflow({
  name: "hello-host-command",
  maxAgents: 2,
  maxConcurrency: 1,
  permissions: {
    read: ["**"],
    write: [],
    hostCommands: [{ id: "hello", argv: ["node", "-e", "console.log(42)"], cwd: "project" }],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  const result = await ctx.hostCommand({ id: "hello.run", phase: "test", commandId: "hello" });
  ctx.claim({
    id: "hello-command-completed",
    text: "The hello host command completed.",
    kind: "verification",
    confidence: "high",
    evidence: [{ type: "command", artifactId: result.data.stdoutArtifactId, command: ["node", "-e", "console.log(42)"], exitCode: result.data.exitCode }]
  });
  return ctx.report({ title: "Hello host command", claimIds: ["hello-command-completed"] });
});
