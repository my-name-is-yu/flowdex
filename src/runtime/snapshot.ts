import { copyFile, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sha256Bytes } from "../util/hash.js";

export interface SnapshotFile {
  path: string;
  mode: number;
  sha256: string;
  sourceKind: "file";
  size: number;
  lineCount: number;
}

export interface SnapshotManifest {
  root: string;
  files: SnapshotFile[];
  hash: string;
}

export interface SnapshotOptions {
  root: string;
  globs: string[];
  outDir: string;
  maxFiles?: number;
  maxBytes?: number;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

export async function buildSnapshot(options: SnapshotOptions): Promise<SnapshotManifest> {
  const root = path.resolve(options.root);
  const maxFiles = options.maxFiles ?? 10_000;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const files: SnapshotFile[] = [];
  const seenCaseFold = new Set<string>();
  let totalBytes = 0;
  await mkdir(options.outDir, { recursive: true });

  for await (const absolutePath of walk(root)) {
    const relative = normalizeRelative(root, absolutePath);
    if (!matchesAny(relative, options.globs)) continue;
    const caseFold = relative.toLocaleLowerCase("en-US").normalize("NFC");
    if (seenCaseFold.has(caseFold)) throw new SnapshotError(`case-fold collision in snapshot: ${relative}`);
    seenCaseFold.add(caseFold);

    const first = await lstat(absolutePath);
    if (first.isSymbolicLink()) throw new SnapshotError(`symlink rejected: ${relative}`);
    if (!first.isFile()) throw new SnapshotError(`special file rejected: ${relative}`);

    const before = await stat(absolutePath);
    const content = await readFile(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      const retryBefore = await stat(absolutePath);
      const retryContent = await readFile(absolutePath);
      const retryAfter = await stat(absolutePath);
      if (retryBefore.size !== retryAfter.size || retryBefore.mtimeMs !== retryAfter.mtimeMs || retryBefore.ino !== retryAfter.ino) {
        throw new SnapshotError(`snapshot-race: ${relative}`);
      }
      await materialize(options.outDir, relative, absolutePath);
      const sha256 = sha256Bytes(retryContent);
      files.push({ path: relative, mode: retryAfter.mode, sha256, sourceKind: "file", size: retryContent.length, lineCount: countLines(retryContent) });
      totalBytes += retryContent.length;
    } else {
      await materialize(options.outDir, relative, absolutePath);
      const sha256 = sha256Bytes(content);
      files.push({ path: relative, mode: after.mode, sha256, sourceKind: "file", size: content.length, lineCount: countLines(content) });
      totalBytes += content.length;
    }

    if (files.length > maxFiles) throw new SnapshotError(`snapshot file cap exceeded: ${maxFiles}`);
    if (totalBytes > maxBytes) throw new SnapshotError(`snapshot byte cap exceeded: ${maxBytes}`);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: options.outDir,
    files,
    hash: sha256Bytes(JSON.stringify(files.map((file) => [file.path, file.mode, file.sha256, file.size, file.lineCount])))
  };
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (const byte of content) {
    if (byte === 10) lines++;
  }
  return content.at(-1) === 10 ? lines - 1 : lines;
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".flowdex" || entry.name === "node_modules") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(absolute);
    } else {
      yield absolute;
    }
  }
}

function normalizeRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new SnapshotError(`invalid snapshot path: ${relative}`);
  }
  for (const segment of relative.split("/")) {
    if (!segment || segment === "." || segment === "..") throw new SnapshotError(`invalid snapshot segment: ${relative}`);
  }
  return relative.normalize("NFC");
}

async function materialize(outDir: string, relative: string, sourcePath: string): Promise<void> {
  const target = path.join(outDir, ...relative.split("/"));
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(outDir);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new SnapshotError(`snapshot materialization escaped root: ${relative}`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourcePath, target);
}

function matchesAny(relative: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(relative, glob));
}

function matchesGlob(relative: string, glob: string): boolean {
  if (glob === "**") return true;
  if (glob.endsWith("/**")) return relative === glob.slice(0, -3) || relative.startsWith(glob.slice(0, -2));
  if (glob.startsWith("**/*.")) return relative.endsWith(glob.slice(4));
  if (!glob.includes("*")) return relative === glob;
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(relative);
}
