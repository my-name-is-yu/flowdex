import { spawnSync } from "node:child_process";

export function applyPatch(repoRoot: string, patch: string, allowedGlobs: string[]): void {
  applyPatches(repoRoot, [patch], allowedGlobs);
}

export function applyPatches(repoRoot: string, patches: string[], allowedGlobs: string[]): void {
  if (patches.length === 0) return;
  const combined = patches.join("\n");
  const changedPaths = patchChangedPaths(repoRoot, combined);
  validateWriteAllowlist(changedPaths, allowedGlobs);
  const check = spawnSync("git", ["apply", "--check", "--3way", "-"], { cwd: repoRoot, input: combined, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (check.status !== 0) throw new Error(check.stderr || check.stdout);
  const apply = spawnSync("git", ["apply", "--3way", "-"], { cwd: repoRoot, input: combined, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (apply.status !== 0) throw new Error(apply.stderr || apply.stdout);
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
