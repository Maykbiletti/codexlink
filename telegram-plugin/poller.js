#!/usr/bin/env node
import { pollOnce } from "./lib/bridge.js";
import { loadConfig } from "./lib/env.js";
import { isCurrentSidecarPid, isCurrentTokenPoller } from "./lib/singleton.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_POLL_INTERVAL_MS || "700", 10) || 700;
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
  const config = loadConfig();
  while (!stopping) {
    if (!isCurrentSidecarPid("poller") || !isCurrentTokenPoller(config)) {
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
