# Flowdex

Flowdex is a Rust-built dynamic workflow runtime for durable Codex-style fanout.

It runs `workflow.ts` files through a permissionless Deno harness, stores
resumable run state, prepares native Codex worker dispatch packages, validates
worker result envelopes, and produces host-verified reports from collected
evidence.

## Install

```bash
npm install -g flowdex
flowdex --help
```

The npm package currently builds the Rust CLI during install. The installing
machine needs:

- Node.js 18 or newer
- Rust and Cargo
- Deno for dynamic `workflow.ts` execution

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

Create and preview a reusable dynamic workflow:

```bash
mkdir -p flowdex-demo
cd flowdex-demo
flowdex init code-audit code-audit.ts
flowdex preview code-audit.ts
```

Start the workflow:

```bash
flowdex run code-audit.ts --yes
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

- dynamic `workflow.ts` validation before approval
- permissionless Deno tick execution for workflow code
- durable run state in SQLite under `.flowdex/runs`
- rebuildable event projections with `repair-events`
- host command execution through explicit allowlists
- native dispatch packages for Codex workers
- exact `AdapterResult` envelope validation
- host-verified reports with claim-backed evidence
- explicit patch integration through manifest write permissions

## Dynamic Workflows

Workflow source is a constrained TypeScript file. Flowdex reads the manifest
statically, then executes the callback one durable tick at a time. Calls to
`ctx.hostCommand`, `ctx.agent`, `ctx.fanout`, and `ctx.integrate` suspend the
tick until the operation result exists in SQLite, so ordinary TypeScript
branches and loops become resumable workflow control flow.

```ts
import { workflow } from "@flowdex/runtime";

export default workflow({
  name: "example",
  maxAgents: 4,
  maxConcurrency: 4,
  defaultAdapter: "codex-native",
  permissions: {
    read: ["src/**", "tests/**"],
    write: [],
    hostCommands: [],
    network: "none",
    env: { inherit: [] }
  },
  phases: [{ id: "review", maxAgents: 4 }]
}, async (ctx) => {
  const results = await ctx.fanout({
    id: "review",
    phase: "review",
    tasks: [
      {
        id: "runtime",
        phase: "review",
        mode: "read-only",
        prompt: "Review runtime risks. Return AdapterResult JSON."
      }
    ]
  });
  return ctx.report({ title: "Review", results });
});
```

Supported durable operations:

- `hostCommand`
- `agent`
- `fanout`
- `integrate`
- `claim`
- `report`

The only allowed import is `import { workflow } from "@flowdex/runtime"`.
Workflow code runs without filesystem, network, shell, npm, or remote module
permissions.

## Native Dispatch

`codex-native` is a durable bridge for Codex workers. Flowdex does not spawn or
complete child sessions by itself.

The normal loop is:

```bash
flowdex run code-audit.ts --yes
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
task result and resumes the run through the same stored workflow source.

## Commands

```bash
flowdex preview <workflow.ts>
flowdex run <workflow.ts> [--input JSON|@file] [--yes]
flowdex init <code-audit|parallel-review|implementation-fanout> <workflow.ts>
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
flowdex init code-audit .flowdex/workflows/code-audit.ts
```

## Development

Use Cargo directly when developing Flowdex:

```bash
cargo fmt --all -- --check
cargo test
cargo build --release --locked
cargo run -- preview examples/hello.ts
cargo run -- preview examples/code-audit.ts
```

The npm package surface is intentionally thin: `bin/flowdex.js` launches the
native binary built by `scripts/npm-postinstall.js`.

Bundled examples are available from a source checkout:

```bash
flowdex preview examples/hello.ts
flowdex run examples/hello.ts --yes
flowdex preview examples/code-audit.ts
```
