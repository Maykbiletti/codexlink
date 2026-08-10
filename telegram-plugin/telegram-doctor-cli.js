#!/usr/bin/env node
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { runTelegramDoctor } from "./lib/doctor.js";

ensureStateLayout();
const args = new Set(process.argv.slice(2));
const report = await runTelegramDoctor(loadConfig(), {
  repair: args.has("--repair")
});
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.ok ? 0 : 2;
