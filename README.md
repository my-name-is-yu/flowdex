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
- resumable runs with terminal-state idempotence and basic lifecycle commands
- native-subagent dispatch bridge for this Mac's Codex Desktop
- explicit `ctx.integrate` patch application

## Commands

```sh
cargo build

cargo run -- preview examples/hello.ts
cargo run -- run examples/hello.ts --yes
cargo run -- run examples/code-audit.ts --yes
cargo run -- next <run-id> --json --files
cargo run -- attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <native-id>
cargo run -- collect-results <run-id> --continue --json
cargo run -- status <run-id> --json --compact
cargo run -- watch <run-id>
cargo run -- list
cargo run -- inspect <run-id>
cargo run -- report <run-id> [--path json.path] [--raw]
cargo run -- report <run-id> --paths
cargo run -- complete-agent <run-id> <child-key> --lease-token <token> --result @<result-path>
cargo run -- resume <run-id>
cargo run -- pause <run-id>
cargo run -- stop <run-id>
cargo run -- repair-events <run-id>
cargo run -- restart-agent <run-id> <op-key>
cargo run -- save <run-id> <name>
cargo run -- workflow list
cargo run -- init code-audit .flowdex/workflows/code-audit.ts
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
integration phase. Flowdex preflights all patches in an integration operation
before mutating the worktree, so a rejected later patch does not leave earlier
patches applied.

Final reports that make factual claims should use `claimIds`. Claim-backed
reports are filtered through host-verified evidence. `fileRange` evidence must
point at existing lines in a snapshot, and `command` / `test` evidence must
match a Flowdex-owned host command result, including argv and exit code.

Agent tasks create dispatch records for the `$flowdex` skill bridge. The Rust
runtime does not directly spawn Codex Desktop native subagents. In Desktop, the
parent Codex session reads `flowdex next --files`, spawns exactly those native
subagents with the returned `agentPrompt`, attaches their native ids, and lets
`collect-results --continue` register completed AdapterResult files.

Codex Desktop currently supports six active subagents at a time. Flowdex treats
that as an active batch limit, not a workflow size limit: `next` leases six
dispatches by default, while the durable queue may contain tens or hundreds of
fanout tasks. Read snapshots are materialized when a dispatch is leased, so
large fanouts do not eagerly copy a workspace for every queued task. Use
`--files` for native dispatches so large prompts and cross-phase `task.data`
stay in Flowdex-owned files instead of being pasted through the parent Codex
context. Complete the current batch, run
`collect-results --continue`, then `next --files` again to roll through the next
batch. The parent Codex session should use the native spawn/wait tools for
execution. Completed subagents may be left open for review; Flowdex only tracks
the durable queue, file handoff, and validated AdapterResult boundary.
Use `watch` or `status --json --compact` for progress checks; plain
`status --json` includes full task and result payloads for debugging. Compact
status includes the current `adapter-result.json` path for leased or dispatched
native tasks so an operator can recover after losing the original `next --files`
output. `collect-results` records missing, invalid, and stale-result diagnostics
on the task record. Native worker `claims` and `artifacts` are validated for
shape but stored as untrusted data (`flowdexUntrustedClaims` /
`flowdexUntrustedArtifacts`); only parent-staged `claimIds` become
host-verified final-report claims.

`next --files` requeues leases if dispatch package writing fails before the
worker can receive usable instructions. Expired leases can be reclaimed by a
later `next`; if a worker writes an `adapter-result.json` under an older lease
after reclaim, `collect-results` reports it as a stale result instead of
silently ignoring it.

Flowdex is intentionally local-Codex-only: it does not ship a `codex-cli`
fallback, external model broker, background worker, or write-worktree runner.
If a native worker needs to propose edits, have it return a patch and apply it
through an explicit `ctx.integrate` phase.

Native research workflows can declare `permissions.network: "web"` so preview
and saved manifests make web access intent explicit. Flowdex records this intent
for approval and review; native workers still execute through Codex Desktop's
tooling rather than a Flowdex-owned browser sandbox.

Host commands are allowlisted in the manifest. They inherit `PATH` plus any
variables listed in `permissions.env.inherit`, and they have bounded
stdout/stderr capture. Use `timeoutMs` and `maxOutputBytes` when a command may
be slow or noisy.

Completed runs are terminal: `resume` returns the completed report without
replaying the workflow. Failed runs are also terminal until an explicit repair
operation such as `restart-agent` invalidates the affected task.

SQLite is the source of truth for run events. `events.jsonl` is a projection for
inspection and can be rebuilt with `repair-events` if it is deleted or becomes
stale.

## Verification

```sh
cargo fmt --all -- --check
cargo test
cargo run -- preview examples/hello.ts
cargo run -- preview examples/code-audit.ts
```
