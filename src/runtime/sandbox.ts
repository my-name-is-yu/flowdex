import { spawn } from "node:child_process";
import type { ScheduledOperation, TickInput, TickResult } from "../types.js";
import { canonicalClone } from "../util/canonical.js";

export interface SandboxOptions {
  denoPath?: string;
  timeoutMs?: number;
}

export async function runSandboxTick(transformedJavaScript: string, input: TickInput, options: SandboxOptions = {}): Promise<TickResult> {
  const denoPath = options.denoPath ?? "deno";
  const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? 10_000;
  const tickInput = canonicalClone({
    input: input.input,
    now: input.now,
    results: input.results
  });
  const script = buildHarness(transformedJavaScript, tickInput);

  return await new Promise<TickResult>((resolve) => {
    const child = spawn(
      denoPath,
      [
        "run",
        "--no-prompt",
        "--no-config",
        "--no-lock",
        "--no-npm",
        "--no-remote",
        "--v8-flags=--max-old-space-size=128",
        "-"
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: { PATH: process.env.PATH ?? "" }
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      resolve({ status: "failed-timeout", error: `workflow tick exceeded ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "failed", error: error.message });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).at(-1);
      if (!line) {
        resolve({ status: "failed", error: stderr || "workflow produced no result" });
        return;
      }
      try {
        resolve(canonicalClone(JSON.parse(line)) as TickResult);
      } catch (error) {
        resolve({
          status: "failed",
          error: `invalid sandbox result: ${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`
        });
      }
    });
    child.stdin.end(script);
  });
}

function buildHarness(transformedJavaScript: string, tickInput: unknown): string {
  const serializedInput = JSON.stringify(tickInput).replace(/</g, "\\u003c");
  return `
const __flowdexStdoutWrite = globalThis.Deno?.stdout?.writeSync?.bind(globalThis.Deno.stdout);
const __forbiddenGlobals = ["Deno", "process", "require", "module", "window", "self", "document", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "localStorage", "sessionStorage", "performance", "Date", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "WebAssembly", "Worker", "SharedWorker", "console"];
for (const name of __forbiddenGlobals) {
  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
}
${canonicalRuntimeSource()}
${transformedJavaScript}
const __tickInput = ${serializedInput};
const __staged = { claims: [], artifacts: [], reports: [] };
const __scheduled = [];
let __suspended = false;
class FlowdexPending extends Error {
  constructor(operation) {
    super("FlowdexPending");
    this.name = "FlowdexPending";
    this.__flowdexPending = true;
    this.operation = operation;
  }
}
function __opKey(kind, id) {
  return kind + ":" + id;
}
function __ensureNotSuspended() {
  if (__suspended) throw new FlowdexPending({ kind: "suspended", id: "suspended", phase: "suspended", args: null });
}
function __schedule(kind, args) {
  const canonicalArgs = __canonical(args);
  const id = canonicalArgs && canonicalArgs.id;
  const phase = canonicalArgs && canonicalArgs.phase;
  if (typeof id !== "string" || typeof phase !== "string") {
    throw new Error(kind + " requires string id and phase");
  }
  const operation = { kind, id, phase, args: canonicalArgs };
  __scheduled.push(operation);
  __suspended = true;
  throw new FlowdexPending(operation);
}
const ctx = Object.freeze({
  input: __deepFreeze(__canonical(__tickInput.input)),
  now: () => __tickInput.now,
  pendingSignal: "FlowdexPending",
  isFlowdexPending: (error) => !!(error && error.__flowdexPending),
  agent: (args) => {
    __ensureNotSuspended();
    const key = __opKey("agent", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("agent", args);
  },
  fanout: (args) => {
    __ensureNotSuspended();
    const key = __opKey("fanout", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("fanout", args);
  },
  hostCommand: (args) => {
    __ensureNotSuspended();
    const key = __opKey("hostCommand", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("hostCommand", args);
  },
  integrate: (args) => {
    __ensureNotSuspended();
    const key = __opKey("integrate", args && args.id);
    if (Object.prototype.hasOwnProperty.call(__tickInput.results, key)) return __deepFreeze(__canonical(__tickInput.results[key]));
    return __schedule("integrate", args);
  },
  claim: (claim) => {
    __ensureNotSuspended();
    __staged.claims.push(__canonical(claim));
  },
  artifact: (artifact) => {
    __ensureNotSuspended();
    __staged.artifacts.push(__canonical(artifact));
  },
  report: (report) => {
    __ensureNotSuspended();
    const canonicalReport = __canonical(report);
    __staged.reports.push(canonicalReport);
    return canonicalReport;
  }
});
(async () => {
  try {
    const internalPromise = __flowdexWorkflow.callback(ctx);
    const value = await internalPromise;
    const result = { status: "completed", value: __canonical(value ?? null), staged: __canonical(__staged) };
    globalThis.__flowdexWrite(JSON.stringify(result));
  } catch (error) {
    if (error && error.__flowdexPending) {
      globalThis.__flowdexWrite(JSON.stringify({ status: "pending", scheduled: __canonical(__scheduled) }));
      return;
    }
    globalThis.__flowdexWrite(JSON.stringify({ status: "failed", error: String(error && error.stack ? error.stack : error) }));
  }
})();
`;
}

function canonicalRuntimeSource(): string {
  return `
function __flowdexWrite(text) {
  const bytes = new TextEncoder().encode(text + "\\n");
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
`;
}

export function operationKey(operation: Pick<ScheduledOperation, "kind" | "id">): string {
  return `${operation.kind}:${operation.id}`;
}
