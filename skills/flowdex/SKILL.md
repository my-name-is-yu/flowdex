---
name: flowdex
description: Use when the user explicitly asks for Flowdex, workflow-style orchestration, saved/replayable sub-agent fanout, or Claude Code Dynamic Workflows-like behavior in Codex. Flowdex is a runtime-backed workflow system; the skill is only the entrypoint for drafting, previewing, running, inspecting, and reporting workflows through the local `flowdex` CLI.
---

# Flowdex

Use this skill as the native bridge entrypoint to the local Flowdex runtime.

Flowdex is not a prompt-only sub-agent pattern. It uses workflow source files,
the `flowdex` CLI/runtime, durable dispatch records, immutable snapshots,
host-verified evidence, and resumable runs.

## Operating Mode

Use Flowdex only when the user explicitly asks for `flowdex`, `workflow`,
runtime-backed orchestration, saved/replayable work, or a Claude Code Dynamic
Workflows-like workflow.

When Flowdex is triggered, the parent Codex agent must not solve the target task.
The parent may only scope enough to author or choose a workflow, preview/run it,
dispatch workers, record worker JSON, continue, and report from Flowdex output.

Prefer native Codex Desktop subagents when the multi-agent tools are available.
Use `codex-native` dispatch mode for that path:

```sh
flowdex preview <workflow.ts>
flowdex run <workflow.ts> --yes
flowdex next <run-id> --json --files
flowdex attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <native-id>
flowdex collect-results <run-id> --continue --json
flowdex status <run-id> --json --compact
flowdex report <run-id>
flowdex report <run-id> --paths
```

`flowdex next` leases six native dispatches by default because Codex Desktop can
run six active subagents at a time. Treat this as a batch size, not a workflow
size limit: after workers finish, record their AdapterResult JSON, run
`continue`, then lease the next batch until the durable queue is empty.
Snapshots are materialized at lease/file-package time, not for every queued
fanout task up front.
If the original `next --files` output is lost, use `status --json --compact` to
recover the current `adapter-result.json` path for leased or dispatched tasks.
`collect-results` reports missing, invalid, and stale-result files through
Flowdex state instead of relying on chat memory.
Native worker claims/artifacts are stored as untrusted data; final factual
claims should be promoted by the parent workflow through `claimIds`.

For each `flowdex next --files` item, spawn exactly that native subagent task
with the returned `agentPrompt`, then attach its native id. Use Codex's native
spawn/wait tools for execution. The worker must read the returned
`instructionPath`, write AdapterResult JSON to `resultPath`, and avoid returning
large result JSON through chat. After workers finish, run
`collect-results --continue`; do not infer factual claims from prose or from
Codex session internals. Completed subagents may be left open for review; close
them only when the user wants to reduce UI clutter or free resources.

There is no fallback adapter path. The `--files` handoff exists so this Mac's
Codex parent session can stay thin while native Codex subagents do the actual
work.

For existing runs:

```sh
flowdex list
flowdex inspect <run-id>
flowdex status <run-id>
flowdex status <run-id> --json --compact
flowdex watch <run-id>
flowdex report <run-id>
flowdex report <run-id> --path synthesis.data.concise_japanese_answer --raw
flowdex report <run-id> --paths
flowdex collect-results <run-id> [--continue] [--json]
flowdex complete-agent <run-id> <child-key> --lease-token <token> --result @<result-path>
flowdex resume <run-id>
flowdex continue <run-id>
flowdex pause <run-id>
flowdex stop <run-id>
flowdex repair-events <run-id>
flowdex restart-agent <run-id> <op-key>
flowdex save <run-id> <name>
flowdex workflow list
```

## Workflow Authoring Contract

Follow the runtime contract:

- Use only `import { workflow } from "@flowdex/runtime"`.
- Keep the manifest static and JSON-compatible.
- Use `defaultAdapter: "codex-native"` or omit it; Flowdex only supports the
  local Codex Desktop native bridge.
- Use canonical JSON data across workflow boundaries.
- Use `permissions.network: "web"` for native research workflows that need web
  access. This records approval intent; Flowdex does not own native web tooling.
- Use `timeoutMs` and `maxOutputBytes` for host commands that may be slow or
  noisy.
- Use `ctx.hostCommand`, `ctx.agent`, and `ctx.fanout` as durable operations.
- Use `ctx.fanout({ tasks: [...] })`; do not pass task callback functions.
- Use `ctx.integrate({ patches: [...] })` for explicit write integration.
- Do not use filesystem, shell, network, dynamic imports, timers, randomness, or
  arbitrary JS globals in workflow code.
- Final reports should use `claimIds` and be backed by validated
  claims/evidence whenever making factual assertions. Command/test evidence must
  match Flowdex-owned host command argv and exit code.

If a workflow needs exact command/test evidence, prefer `ctx.hostCommand` with a
manifest `permissions.hostCommands` entry. Native workers are for Codex Desktop
subagent judgment; command evidence should come from Flowdex-owned host commands.
Completed and failed runs are terminal on `resume`; use explicit repair commands
such as `restart-agent` to invalidate work before re-driving a run.
If `events.jsonl` is missing or stale, use `flowdex repair-events <run-id>` to
rebuild it from SQLite.
