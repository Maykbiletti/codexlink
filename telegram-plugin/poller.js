#!/usr/bin/env node
import { pollOnce } from "./lib/bridge.js";
import { isCurrentSidecarPid } from "./lib/singleton.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_POLL_INTERVAL_MS || "1500", 10) || 1500;
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
    if (!isCurrentSidecarPid("poller")) {
      break;
    }
    try {
      const result = await pollOnce();
      if (result.captured > 0 || result.ignored > 0) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "poll", result }));
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
