import { describe, expect, it } from "vitest";
import { parseWorkflowSource } from "../src/policy/manifest.js";
import { runSandboxTick } from "../src/runtime/sandbox.js";

const workflow = `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "sandbox-flow",
  maxAgents: 2,
  maxConcurrency: 1,
  permissions: {
    read: ["**"],
    write: [],
    hostCommands: [{ id: "unit", argv: ["node", "-e", "console.log('ok')"], cwd: "project" }],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "test", maxAgents: 1 }]
}, async (ctx) => {
  const unit = await ctx.hostCommand({ id: "unit.run", phase: "test", commandId: "unit" });
  return ctx.report({ status: unit.status, exitCode: unit.data.exitCode });
});`;

describe("Deno sandbox tick", () => {
  it("suspends pending durable operations and completes replayed continuation", async () => {
    const parsed = parseWorkflowSource(workflow);
    const first = await runSandboxTick(parsed.transformedJavaScript, { input: {}, now: "2026-05-29T00:00:00.000Z", results: {} });
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("expected pending");
    expect(first.scheduled[0]?.kind).toBe("hostCommand");
    expect(first.scheduled[0]?.id).toBe("unit.run");

    const second = await runSandboxTick(parsed.transformedJavaScript, {
      input: {},
      now: "2026-05-29T00:00:00.000Z",
      results: {
        "hostCommand:unit.run": {
          status: "completed",
          data: {
            exitCode: 0
          }
        }
      }
    });
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.staged.reports[0]).toEqual({ exitCode: 0, status: "completed" });
  });
});
