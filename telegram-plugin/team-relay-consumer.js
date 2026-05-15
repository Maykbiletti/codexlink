#!/usr/bin/env node
import { consumeTeamRelayOnce } from "./lib/bridge.js";
import { isCurrentSidecarPid } from "./lib/singleton.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_TEAM_RELAY_INTERVAL_MS || "700", 10) || 700;
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
    if (!isCurrentSidecarPid("teamRelay")) {
      break;
    }
    try {
      const result = await consumeTeamRelayOnce();
      if (result.captured > 0 || result.ignored > 0) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "team_relay", result }));
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
