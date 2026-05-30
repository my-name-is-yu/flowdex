import { spawn } from "node:child_process";
import type { HostCommandSpec } from "../types.js";
import type { ArtifactStore } from "../store/artifacts.js";

const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export async function runHostCommand(spec: HostCommandSpec, cwd: string, artifactStore: ArtifactStore, inheritEnv: string[] = []): Promise<{
  status: "completed" | "failed";
  artifacts: Awaited<ReturnType<ArtifactStore["write"]>>[];
  data: {
    command: string[];
    exitCode: number | null;
    stdoutArtifactId: string;
    stderrArtifactId: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    maxOutputBytes: number;
  };
}> {
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const result = await runProcess(spec.argv[0]!, spec.argv.slice(1), cwd, spec.timeoutMs ?? 60_000, maxOutputBytes, buildEnv(inheritEnv));
  const stdout = await artifactStore.write(result.stdout, "text/plain", `hostCommand:${spec.id}:stdout`);
  const stderr = await artifactStore.write(result.stderr, "text/plain", `hostCommand:${spec.id}:stderr`);
  return {
    status: result.exitCode === 0 && !result.outputLimitExceeded ? "completed" : "failed",
    artifacts: [stdout, stderr],
    data: {
      command: spec.argv,
      exitCode: result.exitCode,
      stdoutArtifactId: stdout.id,
      stderrArtifactId: stderr.id,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      maxOutputBytes
    }
  };
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  env: NodeJS.ProcessEnv
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputLimitExceeded: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: false,
      detached: true
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputLimitExceeded = false;
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = appendBounded(stdout, Buffer.from(chunk), maxOutputBytes);
      stdout = next.value;
      stdoutTruncated = stdoutTruncated || next.truncated;
      if (next.truncated) killForOutputLimit();
    });
    child.stderr.on("data", (chunk) => {
      const next = appendBounded(stderr, Buffer.from(chunk), maxOutputBytes);
      stderr = next.value;
      stderrTruncated = stderrTruncated || next.truncated;
      if (next.truncated) killForOutputLimit();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const errorBuffer = Buffer.from(`\n${error.message}`, "utf8");
      const next = appendBounded(stderr, errorBuffer, maxOutputBytes);
      resolve({
        exitCode: null,
        stdout: stdout.toString("utf8"),
        stderr: next.value.toString("utf8"),
        stdoutTruncated,
        stderrTruncated: stderrTruncated || next.truncated,
        outputLimitExceeded
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutTruncated,
        stderrTruncated,
        outputLimitExceeded
      });
    });

    function killForOutputLimit(): void {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });
}

function buildEnv(inherit: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  for (const key of inherit) {
    if (key === "PATH") continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function appendBounded(current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, maxBytes: number): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.length >= maxBytes) return { value: current, truncated: chunk.length > 0 };
  const remaining = maxBytes - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}
