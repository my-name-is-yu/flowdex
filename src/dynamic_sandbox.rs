use crate::canonical::{canonicalize, stable_stringify};
use crate::types::{CanonicalValue, TickResult};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 10_000;

pub fn run_dynamic_workflow_tick(
    transformed_source: &str,
    input: &CanonicalValue,
    now: &str,
    results: &BTreeMap<String, CanonicalValue>,
) -> Result<TickResult> {
    let tick_input = canonicalize(&json!({
        "input": input,
        "now": now,
        "results": results
    }))?;
    let script = build_harness(transformed_source, &tick_input)?;
    run_deno_script(&script, DEFAULT_TIMEOUT_MS)
}

fn run_deno_script(script: &str, timeout_ms: u64) -> Result<TickResult> {
    let mut child = match Command::new("deno")
        .args([
            "run",
            "--quiet",
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
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Ok(TickResult::Failed {
                error: format!("workflow.ts requires deno on PATH: {error}"),
            });
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(script.as_bytes())?;
    }

    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(TickResult::FailedTimeout {
                error: format!("workflow tick exceeded {timeout_ms}ms"),
            });
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_string(&mut stdout)?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_string(&mut stderr)?;
    }
    let Some(line) = stdout.trim().lines().last() else {
        return Ok(TickResult::Failed {
            error: if stderr.trim().is_empty() {
                "workflow produced no result".to_string()
            } else {
                stderr
            },
        });
    };
    serde_json::from_str::<TickResult>(line).map_err(|error| {
        anyhow!("invalid dynamic workflow result: {error}; stdout={stdout}; stderr={stderr}")
    })
}

fn build_harness(transformed_source: &str, tick_input: &Value) -> Result<String> {
    let serialized_input = stable_stringify(tick_input)?.replace('<', "\\u003c");
    Ok(format!(
        r#"
const __flowdexStdoutWrite = globalThis.Deno?.stdout?.writeSync?.bind(globalThis.Deno.stdout);
const __forbiddenGlobals = ["Deno", "process", "require", "module", "window", "self", "document", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "localStorage", "sessionStorage", "performance", "Date", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "WebAssembly", "Worker", "SharedWorker", "console"];
for (const name of __forbiddenGlobals) {{
  try {{ Object.defineProperty(globalThis, name, {{ value: undefined, writable: false, configurable: false }}); }} catch {{}}
}}
try {{ Object.defineProperty(Math, "random", {{ value: undefined, writable: false, configurable: false }}); }} catch {{}}
{runtime_source}
{transformed_source}
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
        transformed_source = transformed_source,
        serialized_input = serialized_input,
    ))
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
