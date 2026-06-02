# Flowdex

Flowdex is a Rust-built workflow runtime for durable Codex-style fanout.

It runs static workflow documents, stores resumable run state, prepares native
Codex worker dispatch packages, validates worker result envelopes, and produces
host-verified reports from collected evidence.

## Install

```bash
npm install -g flowdex
flowdex --help
```

The npm package currently builds the Rust CLI during install. The installing
machine needs:

- Node.js 18 or newer
- Rust and Cargo

Install the optional Codex skill after the CLI is available:

```bash
flowdex skill install
```

By default this copies the bundled skill to `$CODEX_HOME/skills/flowdex` when
`CODEX_HOME` is set, otherwise to `~/.codex/skills/flowdex`. To install into a
specific skill directory:

```bash
flowdex skill install --target /path/to/skills/flowdex
```

To install from a local checkout:

```bash
npm install -g .
flowdex --help
```

## Quick Start

Create and preview a reusable workflow document:

```bash
mkdir -p flowdex-demo
cd flowdex-demo
flowdex init code-audit code-audit.flowdex.json
flowdex preview code-audit.flowdex.json
```

Start the workflow:

```bash
flowdex run code-audit.flowdex.json --yes
```

The run command prints JSON containing `runId`. When the run needs Codex
workers, lease the next batch:

```bash
flowdex next <run-id> --json --files
```

Run workers from the generated instruction files, write each result to its
generated `resultPath`, then collect and continue:

```bash
flowdex collect-results <run-id> --continue --json
flowdex report <run-id>
```

## What Flowdex Provides

- static workflow validation before approval
- durable run state in SQLite under `.flowdex/runs`
- rebuildable event projections with `repair-events`
- host command execution through explicit allowlists
- native dispatch packages for Codex workers
- exact `AdapterResult` envelope validation
- host-verified reports with claim-backed evidence
- explicit patch integration through manifest write permissions

## Workflow Documents

Workflow source is a static `.flowdex.json` document. It is data, not executable
workflow code.

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
        {
          "id": "runtime",
          "phase": "review",
          "mode": "read-only",
          "prompt": "Review runtime risks. Return AdapterResult JSON."
        }
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

Supported step types:

- `hostCommand`
- `agent`
- `fanout`
- `integrate`
- `claim`
- `report`

References are explicit data objects:

```json
{ "$result": "hostCommand:hello.run", "path": ["data", "stdoutArtifactId"] }
```

The evaluator resolves references over `ctx.input`, current time, and completed
operation results.

## Native Dispatch

`codex-native` is a durable bridge for Codex workers. Flowdex does not spawn or
complete child sessions by itself.

The normal loop is:

```bash
flowdex run code-audit.flowdex.json --yes
flowdex next <run-id> --json --files
# run workers from the generated instructions and write each adapter-result file
flowdex collect-results <run-id> --continue --json
```

`next` leases six active workers by default. Treat that as a batch size, not a
workflow size limit. After `collect-results --continue`, run `next --files`
again to roll through later batches.

## Worker Results

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

## Commands

```bash
flowdex preview <workflow.flowdex.json>
flowdex run <workflow.flowdex.json> [--input JSON|@file] [--yes]
flowdex init <code-audit|parallel-review|implementation-fanout> <workflow.flowdex.json>
flowdex skill install [--target <skill-dir>] [--json]
flowdex list
flowdex resume <run-id>
flowdex continue <run-id>
flowdex inspect <run-id>
flowdex report <run-id> [--path json.path] [--raw] [--paths]
flowdex next <run-id> --json [--files] [--limit N]
flowdex attach-agent <run-id> <child-key> --lease-token <token> --agent-ref <id>
flowdex complete-agent <run-id> <child-key> --lease-token <token> --result @file
flowdex collect-results <run-id> [--continue] [--json]
flowdex status <run-id> [--json] [--compact]
flowdex watch <run-id>
flowdex pause <run-id>
flowdex stop <run-id>
flowdex repair-events <run-id>
flowdex restart-agent <run-id> <op-key>
flowdex save <run-id> <name>
flowdex workflow list
```

## Saved Workflows

```bash
flowdex save <run-id> <name>
flowdex workflow list
flowdex init code-audit .flowdex/workflows/code-audit.flowdex.json
```

## Development

Use Cargo directly when developing Flowdex:

```bash
cargo fmt --all -- --check
cargo test
cargo build --release --locked
cargo run -- preview examples/hello.flowdex.json
cargo run -- preview examples/code-audit.flowdex.json
```

The npm package surface is intentionally thin: `bin/flowdex.js` launches the
native binary built by `scripts/npm-postinstall.js`.

Bundled examples are available from a source checkout:

```bash
flowdex preview examples/hello.flowdex.json
flowdex run examples/hello.flowdex.json --yes
flowdex preview examples/code-audit.flowdex.json
```
