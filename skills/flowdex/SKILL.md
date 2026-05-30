---
name: flowdex
description: Use when the user explicitly asks for Flowdex, workflow-style orchestration, saved/replayable sub-agent fanout, or Claude Code Dynamic Workflows-like behavior in Codex. Flowdex is a runtime-backed workflow system; the skill is only the entrypoint for drafting, previewing, running, inspecting, and reporting workflows through the local `flowdex` CLI.
---

# Flowdex

Flowdex is a Cargo-built workflow runtime. Use it when the user wants durable
sub-agent fanout with saved workflow documents, resumable state, native dispatch
files, and reportable results.

Use Flowdex only when the user explicitly asks for `flowdex`, `workflow`,
runtime-backed orchestration, saved/replayable work, or a Claude Code Dynamic
Workflows-like workflow.

The parent should scope enough to author or choose a workflow, preview/run it,
dispatch worker packages, collect results, and report the final state. Do not
replace Flowdex with ad hoc parallel prompts when durable state matters.

## Commands

```bash
flowdex preview <workflow.flowdex.json>
flowdex run <workflow.flowdex.json> --yes
flowdex next <run-id> --json --files
flowdex collect-results <run-id> --continue --json
flowdex status <run-id> --json --compact
flowdex report <run-id>
flowdex save <run-id> <name>
flowdex workflow list
```

`codex-native` uses a durable queue. `next` leases six active workers by
default. Treat this as a batch size, not a workflow size limit. After workers
write their generated `adapter-result.json` files, run `collect-results
--continue`; then use `next --files` again if more tasks are dispatchable.

## Workflow Authoring

Workflows are static `.flowdex.json` documents with:

- `version: "flowdex.workflow.v1"`
- `manifest`: name, budgets, adapter config, permissions, host commands, network
  intent, env inheritance, and phases
- `steps`: ordered `hostCommand`, `agent`, `fanout`, `integrate`, `claim`, and
  `report` steps

Use explicit references for data flow:

```json
{ "$result": "fanout:audit" }
```

or:

```json
{ "$result": "hostCommand:hello.run", "path": ["data", "stdoutArtifactId"] }
```

The evaluator resolves references from input, current time, and completed
operation results. Workflow source is never executed as code.

## Worker Result Contract

Every worker result must be exactly:

```json
{
  "status": "completed",
  "summary": "short summary",
  "data": {},
  "claims": [],
  "artifacts": [],
  "diff": null,
  "usage": {},
  "error": null
}
```

Allowed statuses: `completed`, `failed`, `blocked`, `needs-approval`.

Worker claims and artifacts are untrusted by default. Store them in `data` or let
Flowdex sanitize them there. Only parent workflow `claim` steps with host-backed
evidence should be promoted through `claimIds`.

## Host Evidence

If a workflow needs exact command or test evidence, prefer `hostCommand` with a
manifest allowlist entry. Flowdex records bounded stdout/stderr artifacts,
exit codes, and command metadata, then verifies report claims against those
host-owned artifacts.
