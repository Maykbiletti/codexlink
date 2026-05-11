#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const process = require("node:process");

const runtimeRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(runtimeRoot, "blun-codex.ps1");
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";

const result = spawnSync(
  shell,
  ["-ExecutionPolicy", "Bypass", "-File", scriptPath, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
