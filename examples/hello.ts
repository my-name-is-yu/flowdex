import { workflow } from "@flowdex/runtime";

export default workflow({
  name: "hello-host-command",
  maxAgents: 1,
  maxConcurrency: 1,
  defaultAdapter: "codex-native",
  permissions: {
    read: ["README.md"],
    write: [],
    hostCommands: [
      {
        id: "hello",
        argv: ["sh", "-c", "printf 'hello flowdex'"],
        cwd: "project",
        timeoutMs: 5000,
        maxOutputBytes: 4096
      }
    ],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "verify", maxAgents: 1 }]
}, async (ctx) => {
  const hello = await ctx.hostCommand({ id: "hello.run", phase: "verify", commandId: "hello" });
  return ctx.report({
    title: "Hello host command",
    status: hello.status,
    stdoutArtifactId: hello.data.stdoutArtifactId,
    exitCode: hello.data.exitCode
  });
});
