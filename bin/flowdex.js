#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "flowdex.exe" : "flowdex";
const candidates = [
  process.env.FLOWDEX_BINARY,
  path.join(root, "target", "release", binaryName),
  path.join(root, "target", "debug", binaryName)
].filter(Boolean);

const binaryPath = candidates.find((candidate) => fs.existsSync(candidate));

if (!binaryPath) {
  console.error("flowdex native binary was not found.");
  console.error("Run `npm rebuild -g flowdex` or install again with Rust/Cargo available.");
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`failed to start flowdex: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
