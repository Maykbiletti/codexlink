#!/usr/bin/env node
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { ensureBackgroundSidecars } from "./lib/sidecars.js";

ensureStateLayout();
const result = ensureBackgroundSidecars(loadConfig());
process.stdout.write(`${JSON.stringify(result)}\n`);
