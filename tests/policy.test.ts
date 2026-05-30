import { describe, expect, it } from "vitest";
import { parseWorkflowSource } from "../src/policy/manifest.js";

const manifest = `{
  name: "test-flow",
  maxAgents: 4,
  maxConcurrency: 2,
  permissions: {
    read: ["src/**"],
    write: [],
    hostCommands: [{ id: "unit", argv: ["node", "-e", "console.log('ok')"], cwd: "project" }],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "test", maxAgents: 2 }]
}`;

function source(body: string): string {
  return `import { workflow } from "@flowdex/runtime";
export default workflow(${manifest}, async (ctx) => {
${body}
});`;
}

describe("workflow policy", () => {
  it("accepts a canonical hostCommand workflow", () => {
    const parsed = parseWorkflowSource(
      source(`
  const unit = await ctx.hostCommand({ id: "unit.run", phase: "test", commandId: "unit" });
  return ctx.report({ status: unit.status, exitCode: unit.data.exitCode });
`)
    );
    expect(parsed.manifest.name).toBe("test-flow");
    expect(parsed.approvalHash).toHaveLength(64);
  });

  it("accepts codex-native adapter configs", () => {
    const parsed = parseWorkflowSource(
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "native-flow",
  maxAgents: 4,
  maxConcurrency: 2,
  defaultAdapter: "codex-native",
  adapters: { "codex-native": { type: "codex-native", model: "gpt-5.5", reasoningEffort: "medium" } },
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },
  phases: [{ id: "test", maxAgents: 2 }]
}, async (ctx) => {
  return ctx.report({ ok: true });
});`
    );
    expect(parsed.manifest.defaultAdapter).toBe("codex-native");
  });

  it("accepts web network intent for native research workflows", () => {
    const parsed = parseWorkflowSource(
      `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "web-research",
  maxAgents: 4,
  maxConcurrency: 2,
  defaultAdapter: "codex-native",
  adapters: { "codex-native": { type: "codex-native" } },
  permissions: { read: ["src/**"], write: [], hostCommands: [], network: "web", env: { inherit: [] } },
  phases: [{ id: "research", maxAgents: 2 }]
}, async (ctx) => {
  return ctx.report({ ok: true });
});`
    );
    expect(parsed.manifest.permissions.network).toBe("web");
  });

  it.each([
    ["too many agents", "maxAgents: 1001, maxConcurrency: 2"],
    ["too much concurrency", "maxAgents: 4, maxConcurrency: 17"],
    ["unknown default adapter", "maxAgents: 4, maxConcurrency: 2, defaultAdapter: \"missing\""],
    ["removed cli adapter", "maxAgents: 4, maxConcurrency: 2, defaultAdapter: \"codex-cli\""],
    ["unknown network mode", "maxAgents: 4, maxConcurrency: 2, permissions: { read: [\"src/**\"], write: [], hostCommands: [], network: \"internet\", env: { inherit: [] } }"],
    ["non-string read permission", "maxAgents: 4, maxConcurrency: 2, permissions: { read: [1], write: [], hostCommands: [], network: \"none\", env: { inherit: [] } }"],
    ["bad env inherit", "maxAgents: 4, maxConcurrency: 2, permissions: { read: [\"src/**\"], write: [], hostCommands: [], network: \"none\", env: { inherit: [1] } }"],
    ["bad host command cwd", "maxAgents: 4, maxConcurrency: 2, permissions: { read: [\"src/**\"], write: [], hostCommands: [{ id: \"unit\", argv: [\"node\"], cwd: \"snapshot\" }], network: \"none\", env: { inherit: [] } }"],
    ["empty host command argv", "maxAgents: 4, maxConcurrency: 2, permissions: { read: [\"src/**\"], write: [], hostCommands: [{ id: \"unit\", argv: [], cwd: \"project\" }], network: \"none\", env: { inherit: [] } }"]
  ])("rejects %s", (_name, limits) => {
    expect(() =>
      parseWorkflowSource(
        `import { workflow } from "@flowdex/runtime";
export default workflow({
  name: "bad-flow",
  ${limits},
  ${limits.includes("permissions:") ? "" : 'permissions: { read: ["src/**"], write: [], hostCommands: [], network: "none", env: { inherit: [] } },'}
  phases: [{ id: "test", maxAgents: 2 }]
}, async (ctx) => {
  return ctx.report({ ok: true });
});`
      )
    ).toThrow();
  });

  it.each([
    ["globalThis", "const x = globalThis; return ctx.report({ x });"],
    ["Date", "const x = Date.now(); return ctx.report({ x });"],
    ["eval", "const x = eval('1'); return ctx.report({ x });"],
    ["constructor", "const x = ({}).constructor; return ctx.report({ x });"],
    ["computed constructor", "const key = 'constructor'; const x = ({})[key]; return ctx.report({ x });"],
    ["async helper", "async function helper() { return 1; } return ctx.report({ x: 1 });"],
    ["await helper", "function helper() { return 1; } const x = await helper(); return ctx.report({ x });"],
    ["Promise", "const x = Promise.resolve(1); return ctx.report({ x });"],
    ["function value outbound", "function helper() { return 1; } return ctx.report({ helper });"],
    ["helper default side effect", "function helper(x = ctx.report({ bad: true })) { return x; } return ctx.report({ ok: true });"],
    ["helper destructuring default side effect", "function helper({ x = ctx.report({ bad: true }) } = {}) { return x; } return ctx.report({ ok: true });"],
    ["callback default durable call", "const xs = [1].map((x = ctx.agent({ id: 'a', phase: 'test', mode: 'read-only', prompt: 'a' })) => x); return ctx.report({ xs });"],
    ["destructuring default durable call", "const { x = ctx.agent({ id: 'a', phase: 'test', mode: 'read-only', prompt: 'a' }) } = {}; return ctx.report({ x });"],
    ["ctx method alias", "const dispatch = { map: ctx.agent }; dispatch.map({ id: 'a', phase: 'test', mode: 'read-only', prompt: 'a' }); return ctx.report({ ok: true });"],
    ["ctx side effect callback alias", "const items = [1]; items.map(ctx.report); return ctx.report({ ok: true });"],
    ["builtin callback alias", "const xs = [1].map(Math.random); return ctx.report({ xs });"],
    ["ctx reassignment", "ctx = { agent: JSON.stringify, report: JSON.parse }; const x = await ctx.agent({ id: 'a', phase: 'test', mode: 'read-only', prompt: 'a' }); return ctx.report({ x });"],
    ["ctx parameter shadow", "const xs = [1].map((ctx) => ctx); return ctx.report({ xs });"],
    ["builtin reassignment", "JSON = { stringify: String }; return ctx.report({ ok: true });"],
    ["ctx property assignment", "ctx.input = {}; return ctx.report({ ok: true });"],
    ["legacy fanout task callback", "const xs = await ctx.fanout({ id: 'f', phase: 'test', items: [1], task: (x) => ({ id: String(x), phase: 'test' }) }); return ctx.report({ xs });"],
    ["durable catch success", "try { const unit = await ctx.hostCommand({ id: 'unit.run', phase: 'test', commandId: 'unit' }); return ctx.report(unit); } catch (error) { return ctx.report({ ok: true }); }"]
  ])("rejects %s", (_name, body) => {
    expect(() => parseWorkflowSource(source(body))).toThrow();
  });
});
