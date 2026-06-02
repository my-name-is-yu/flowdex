#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const binaryName = process.platform === "win32" ? "flowdex.exe" : "flowdex";
const releaseBinary = path.join(root, "target", "release", binaryName);

if (process.env.FLOWDEX_SKIP_BUILD === "1") {
  console.log("flowdex: skipping Cargo build because FLOWDEX_SKIP_BUILD=1");
  process.exit(0);
}

if (fs.existsSync(releaseBinary) && process.env.FLOWDEX_FORCE_REBUILD !== "1") {
  process.exit(0);
}

const cargo = process.env.CARGO || "cargo";
const result = spawnSync(cargo, ["build", "--release", "--locked"], {
  cwd: root,
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.error("flowdex requires Rust/Cargo to build during npm install.");
    console.error("Install Rust from https://rustup.rs/ and retry `npm install -g flowdex`.");
  } else {
    console.error(`failed to run Cargo: ${result.error.message}`);
  }
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(releaseBinary)) {
  console.error(`Cargo build completed, but ${releaseBinary} was not created.`);
  process.exit(1);
}
