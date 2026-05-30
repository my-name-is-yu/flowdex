# Flowdex

Flowdex is a Cargo-built workflow runtime for durable Codex-style fanout.

It provides:

- static workflow document validation before approval
- durable run state in SQLite with rebuildable event projections
- host command execution through explicit allowlists
- native dispatch packages for Codex workers
- exact `AdapterResult` collection and validation
- host-verified reports with claim-backed evidence
- explicit patch integration through manifest write permissions

## Quick Start

```bash
cargo run -- preview examples/hello.flowdex.json
cargo run -- run examples/hello.flowdex.json --yes
cargo run -- run examples/code-audit.flowdex.json --yes
cargo run -- next <run-id> --json --files
cargo run -- collect-results <run-id> --continue --json
cargo run -- report <run-id>
```

Saved workflow commands:

```bash
cargo run -- save <run-id> <name>
cargo run -- workflow list
cargo run -- init code-audit .flowdex/workflows/code-audit.flowdex.json
```

## Workflow Document

Workflow source is a static JSON document:

```json
{
  "version": "flowdex.workflow.v1",
  "manifest": {
    "name": "example",
    "maxAgents": 4,
    "maxConcurrency": 4,
    "defaultAdapter": "codex-native",
    "permissions": {
      "read": ["src/**", "tests/**"],
      "write": [],
      "hostCommands": [],
      "network": "none",
      "env": { "inherit": [] }
    },
    "phases": [{ "id": "review", "maxAgents": 4 }]
  },
  "steps": [
    {
      "type": "fanout",
      "id": "review",
      "phase": "review",
      "tasks": [
        { "id": "runtime", "phase": "review", "mode": "read-only", "prompt": "Review runtime risks. Return AdapterResult JSON." }
      ]
    },
    {
      "type": "report",
      "id": "final",
      "value": {
        "title": "Review",
        "results": { "$result": "fanout:review" }
      }
    }
  ]
}
```

Supported step types are `hostCommand`, `agent`, `fanout`, `integrate`, `claim`,
and `report`. References are explicit data objects such as:

```json
{ "$result": "hostCommand:hello.run", "path": ["data", "stdoutArtifactId"] }
```

The evaluator resolves references over `ctx.input`, current time, and completed
operation results. It does not execute workflow source as code.

## Native Dispatch

`codex-native` is a durable dispatch bridge. Flowdex does not spawn or complete
child sessions by itself. A normal native loop is:

```bash
cargo run -- run examples/code-audit.flowdex.json --yes
cargo run -- next <run-id> --json --files
# run workers from the generated instructions and write each adapter-result file
cargo run -- collect-results <run-id> --continue --json
```

`next` leases six active workers by default. Treat that as a batch size, not a
workflow size limit: `collect-results --continue`, then `next --files` again to
roll through later batches.

## Result Collection

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

Allowed statuses are `completed`, `failed`, `blocked`, and `needs-approval`.
Worker claims and artifacts are stored as untrusted data unless the parent
workflow promotes host-verified claims into the final report.

## Recovery

Completed runs resume idempotently and return the stored report. Paused and
stopped runs remain suspended until explicitly resumed. `repair-events` rebuilds
the event projection from SQLite-backed state. `restart-agent` invalidates a
task result and resumes the run through the same static workflow document.

## Verification

```bash
cargo fmt --all -- --check
cargo test
cargo build --release
cargo run -- preview examples/hello.flowdex.json
cargo run -- preview examples/code-audit.flowdex.json
```
