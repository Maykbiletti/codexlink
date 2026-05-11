#!/usr/bin/env node
import { relayRepliesOnce } from "./lib/bridge.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_REPLY_INTERVAL_MS || "1500", 10) || 1500;
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
      const result = await relayRepliesOnce();
      if (result.status !== "empty" && result.delivered > 0) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "reply", result }));
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
