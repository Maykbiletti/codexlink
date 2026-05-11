#!/usr/bin/env node
import { injectNext } from "./lib/bridge.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_INJECT_INTERVAL_MS || "1500", 10) || 1500;
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  stopping = true;
});

process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  while (!stopping) {
    try {
      const result = await injectNext("");
      if (result.status !== "empty") {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "inject", result }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        kind: "error",
        error: `${error}`
      }));
    }
    await sleep(intervalMs);
  }
}

await main();
