import { spawn } from "node:child_process";
import type { HostCommandSpec } from "../types.js";
import type { ArtifactStore } from "../store/artifacts.js";

export async function runHostCommand(spec: HostCommandSpec, cwd: string, artifactStore: ArtifactStore): Promise<{
  status: "completed" | "failed";
  artifacts: Awaited<ReturnType<ArtifactStore["write"]>>[];
  data: {
    command: string[];
    exitCode: number | null;
    stdoutArtifactId: string;
    stderrArtifactId: string;
  };
}> {
  const result = await runProcess(spec.argv[0]!, spec.argv.slice(1), cwd, spec.timeoutMs ?? 60_000);
  const stdout = await artifactStore.write(result.stdout, "text/plain", `hostCommand:${spec.id}:stdout`);
  const stderr = await artifactStore.write(result.stderr, "text/plain", `hostCommand:${spec.id}:stderr`);
  return {
    status: result.exitCode === 0 ? "completed" : "failed",
    artifacts: [stdout, stderr],
    data: {
      command: spec.argv,
      exitCode: result.exitCode,
      stdoutArtifactId: stdout.id,
      stderrArtifactId: stderr.id
    }
  };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      detached: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
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
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}
