# Flowdex

Flowdex is a runtime-backed workflow system for Codex-style orchestration.

It is not a prompt-only skill. The `$flowdex` skill is an entrypoint; the
authoritative semantics live in the `flowdex` CLI/runtime:

- static manifest and workflow-body policy validation before approval
- Deno sandbox replay ticks
- durable `ctx.agent`, `ctx.fanout`, and `ctx.hostCommand` operations
- SQLite-authoritative run state plus JSONL projection
- immutable snapshot builder for read-only agent inputs
- host-verified evidence and claim-backed final reports
- resumable runs and basic lifecycle commands
- native-subagent dispatch bridge for this Mac's Codex Desktop
- explicit `ctx.integrate` patch application

## Commands

```sh
npm install
npm run build

node dist/cli.js preview examples/hello.ts
node dist/cli.js run examples/hello.ts --yes
node dist/cli.js run examples/code-audit.ts --yes
node dist/cli.js next <run-id> --json --files
node dist/cli.js attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <native-id>
node dist/cli.js collect-results <run-id> --continue --json
node dist/cli.js status <run-id> --json --compact
node dist/cli.js watch <run-id>
node dist/cli.js list
node dist/cli.js inspect <run-id>
node dist/cli.js report <run-id> [--path json.path] [--raw]
node dist/cli.js complete-agent <run-id> <child-key> --lease-token <token> --result @<result-path>
node dist/cli.js resume <run-id>
node dist/cli.js pause <run-id>
node dist/cli.js stop <run-id>
node dist/cli.js restart-agent <run-id> <op-key>
node dist/cli.js save <run-id> <name>
node dist/cli.js workflow list
node dist/cli.js init code-audit .flowdex/workflows/code-audit.ts
```

## Workflow Contract

Workflow source must be exactly:

```ts
import { workflow } from "@flowdex/runtime";

export default workflow(staticManifest, async (ctx) => {
  // orchestration only
});
```

Use `ctx.fanout({ tasks: [...] })`. Do not pass task callback functions across
the workflow boundary; durable operation arguments must be canonical JSON. Use
`ctx.integrate({ patches: [...] })` to apply write-agent patches in an explicit
integration phase.

Agent tasks create dispatch records for the `$flowdex` skill bridge. The Node
runtime does not directly spawn Codex Desktop native subagents. In Desktop, the
parent Codex session reads `flowdex next --files`, spawns exactly those native
subagents with the returned `agentPrompt`, attaches their native ids, and lets
`collect-results --continue` register completed AdapterResult files.

Codex Desktop currently supports six active subagents at a time. Flowdex treats
that as an active batch limit, not a workflow size limit: `next` leases six
dispatches by default, while the durable queue may contain tens or hundreds of
fanout tasks. Use `--files` for native dispatches so large prompts and
cross-phase `task.data` stay in Flowdex-owned files instead of being pasted
through the parent Codex context. Complete the current batch, run
`collect-results --continue`, then `next --files` again to roll through the next
batch. The parent Codex session should use the native spawn/wait tools for
execution. Completed subagents may be left open for review; Flowdex only tracks
the durable queue, file handoff, and validated AdapterResult boundary.
Use `watch` or `status --json --compact` for progress checks; plain
`status --json` includes full task and result payloads for debugging.

Flowdex is intentionally local-Codex-only: it does not ship a `codex-cli`
fallback, external model broker, background worker, or write-worktree runner.
If a native worker needs to propose edits, have it return a patch and apply it
through an explicit `ctx.integrate` phase.

Native research workflows can declare `permissions.network: "web"` so preview
and saved manifests make web access intent explicit. Flowdex records this intent
for approval and review; native workers still execute through Codex Desktop's
tooling rather than a Flowdex-owned browser sandbox.

## Verification

```sh
npm run check
npm run build
```
