use crate::types::{CanonicalValue, ScheduledOperation, TickResult};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

pub fn operation_key(operation: &ScheduledOperation) -> String {
    format!("{}:{}", operation.kind, operation.id)
}

pub fn run_sandbox_tick(
    workflow_body: &str,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> TickResult {
    let script = build_harness(workflow_body, input, now, results);
    let mut child = match Command::new("deno")
        .args([
            "run",
            "--no-prompt",
            "--no-config",
            "--no-lock",
            "--no-npm",
            "--no-remote",
            "--v8-flags=--max-old-space-size=128",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return TickResult::Failed {
                error: error.to_string(),
            };
        }
    };

    if let Some(stdin) = child.stdin.as_mut()
        && let Err(error) = stdin.write_all(script.as_bytes())
    {
        return TickResult::Failed {
            error: error.to_string(),
        };
    }
    drop(child.stdin.take());

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return TickResult::Failed {
                error: error.to_string(),
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let Some(line) = stdout.trim().lines().last() else {
        return TickResult::Failed {
            error: if stderr.is_empty() {
                "workflow produced no result".to_string()
            } else {
                stderr.into_owned()
            },
        };
    };
    serde_json::from_str::<TickResult>(line).unwrap_or_else(|error| TickResult::Failed {
        error: format!("invalid sandbox result: {error}; stderr={stderr}"),
    })
}

fn build_harness(
    workflow_body: &str,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> String {
    let tick_input = json!({
        "input": input,
        "now": now,
        "results": results
    });
    let serialized_input = serde_json::to_string(&tick_input)
        .unwrap_or_else(|_| "{}".to_string())
        .replace('<', "\\u003c");
    format!(
        r#"
const __flowdexStdoutWrite = globalThis.Deno?.stdout?.writeSync?.bind(globalThis.Deno.stdout);
const __forbiddenGlobals = ["Deno", "process", "require", "module", "window", "self", "document", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "localStorage", "sessionStorage", "performance", "Date", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "WebAssembly", "Worker", "SharedWorker", "console"];
for (const name of __forbiddenGlobals) {{
  try {{ Object.defineProperty(globalThis, name, {{ value: undefined, writable: false, configurable: false }}); }} catch {{}}
}}
{runtime_source}
const __flowdexWorkflow = {{ callback: async (ctx) => {{
{workflow_body}
}} }};
const __tickInput = {serialized_input};
const __staged = {{ claims: [], artifacts: [], reports: [] }};
const __scheduled = [];
let __suspended = false;
class FlowdexPending extends Error {{
  constructor(operation) {{
    super("FlowdexPending");
    this.name = "FlowdexPending";
    this.__flowdexPending = true;
    this.operation = operation;
  }}
}}
function __opKey(kind, id) {{
  return kind + ":" + id;
}}
function __ensureNotSuspended() {{
  if (__suspended) throw new FlowdexPending({{ kind: "suspended", id: "suspended", phase: "suspended", args: null }});
}}
function __schedule(kind, args) {{
  const canonicalArgs = __canonical(args);
  const id = canonicalArgs && canonicalArgs.id;
  const phase = canonicalArgs && canonicalArgs.phase;
  if (typeof id !== "string" || typeof phase !== "string") {{
    throw new Error(kind + " requires string id and phase");
  }}
  const operation = {{ kind, id, phase, args: canonicalArgs }};
  __scheduled.push(operation);
  __suspended = true;
  throw new FlowdexPending(operation);
}}
const ctx = Object.freeze({{
  input: __deepFreeze(__canonical(__tickInput.input)),
  now: () => __tickInput.now,
  pendingSignal: "FlowdexPending",
  isFlowdexPending: (error) => !!(error && error.__flowdexPending),
  agent: (args) => {{
    __ensureNotSuspended();
    const key = __opKey("agent", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("agent", args);
  }},
  fanout: (args) => {{
    __ensureNotSuspended();
    const key = __opKey("fanout", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("fanout", args);
  }},
  hostCommand: (args) => {{
    __ensureNotSuspended();
    const key = __opKey("hostCommand", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("hostCommand", args);
  }},
  integrate: (args) => {{
    __ensureNotSuspended();
    const key = __opKey("integrate", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("integrate", args);
  }},
  claim: (claim) => {{
    __ensureNotSuspended();
    __staged.claims.push(__canonical(claim));
  }},
  report: (report) => {{
    __ensureNotSuspended();
    const canonicalReport = __canonical(report);
    __staged.reports.push(canonicalReport);
    return canonicalReport;
  }}
}});
(async () => {{
  try {{
    const value = await __flowdexWorkflow.callback(ctx);
    const result = {{ status: "completed", value: __canonical(value ?? null), staged: __canonical(__staged) }};
    globalThis.__flowdexWrite(JSON.stringify(result));
  }} catch (error) {{
    if (error && error.__flowdexPending) {{
      globalThis.__flowdexWrite(JSON.stringify({{ status: "pending", scheduled: __canonical(__scheduled) }}));
      return;
    }}
    globalThis.__flowdexWrite(JSON.stringify({{ status: "failed", error: String(error && error.stack ? error.stack : error) }}));
  }}
}})();
"#,
        runtime_source = canonical_runtime_source(),
        workflow_body = workflow_body,
        serialized_input = serialized_input
    )
}

fn canonical_runtime_source() -> &'static str {
    r#"
function __flowdexWrite(text) {
  const bytes = new TextEncoder().encode(text + "\n");
  return __flowdexStdoutWrite ? __flowdexStdoutWrite(bytes) : undefined;
}
globalThis.__flowdexWrite = __flowdexWrite;
function __canonical(value, seen = new WeakSet()) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number cannot cross Flowdex boundary");
    return value;
  }
  if (kind === "undefined" || kind === "bigint" || kind === "symbol" || kind === "function") {
    throw new Error(kind + " cannot cross Flowdex boundary");
  }
  if (kind !== "object") throw new Error("unsupported boundary value");
  if (seen.has(value)) throw new Error("cyclic value cannot cross Flowdex boundary");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => __canonical(item, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("prototype-bearing object cannot cross Flowdex boundary");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (!descriptor || "get" in descriptor || "set" in descriptor) throw new Error("accessor property cannot cross Flowdex boundary");
    result[key] = __canonical(descriptor.value, seen);
  }
  return result;
}
function __deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) __deepFreeze(item);
  }
  return value;
}
"#
}
