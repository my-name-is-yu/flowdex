import { spawnSync } from "node:child_process";

export function applyPatch(repoRoot: string, patch: string, allowedGlobs: string[]): void {
  const changedPaths = patchChangedPaths(repoRoot, patch);
  validateWriteAllowlist(changedPaths, allowedGlobs);
  const result = spawnSync("git", ["apply", "--3way", "-"], { cwd: repoRoot, input: patch, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

export function patchChangedPaths(repoRoot: string, patch: string): string[] {
  const result = spawnSync("git", ["apply", "--numstat", "-"], { cwd: repoRoot, input: patch, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t").at(-1) ?? "")
    .filter(Boolean);
}

function validateWriteAllowlist(changedPaths: string[], allowedGlobs: string[]): void {
  for (const changedPath of changedPaths) {
    if (!allowedGlobs.some((glob) => pathMatches(changedPath, glob))) {
      throw new Error(`patch changes path outside manifest.permissions.write: ${changedPath}`);
    }
  }
}

function pathMatches(file: string, glob: string): boolean {
  if (glob === "**") return true;
  if (glob.endsWith("/**")) return file.startsWith(glob.slice(0, -2));
  if (!glob.includes("*")) return file === glob;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(file);
}
