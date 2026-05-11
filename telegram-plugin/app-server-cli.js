#!/usr/bin/env node
import { listLoadedThreadsOverWs, readThreadOverWs, startTextTurnOverWs, startThreadOverWs } from "./lib/app-server-client.js";

function writeLine(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const args = { _: [], command };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "start-thread") {
    const result = await startThreadOverWs({
      wsUrl: args["ws-url"],
      cwd: args.cwd,
      model: args.model,
      sandbox: args.sandbox,
      approvalPolicy: args["approval-policy"],
      personality: args.personality,
      timeoutMs: args["timeout-ms"]
    });
    await writeLine(process.stdout, `${JSON.stringify(result)}\n`);
    return 0;
  }

  if (args.command === "start-turn") {
    const result = await startTextTurnOverWs({
      wsUrl: args["ws-url"],
      threadId: args["thread-id"],
      text: args.text || "",
      model: args.model,
      effort: args.effort,
      personality: args.personality,
      timeoutMs: args["timeout-ms"]
    });
    await writeLine(process.stdout, `${JSON.stringify(result)}\n`);
    return 0;
  }

  if (args.command === "read-thread") {
    const result = await readThreadOverWs({
      wsUrl: args["ws-url"],
      threadId: args["thread-id"],
      timeoutMs: args["timeout-ms"]
    });
    await writeLine(process.stdout, `${JSON.stringify(result)}\n`);
    return 0;
  }

  if (args.command === "list-loaded") {
    const result = await listLoadedThreadsOverWs({
      wsUrl: args["ws-url"],
      timeoutMs: args["timeout-ms"]
    });
    await writeLine(process.stdout, `${JSON.stringify(result)}\n`);
    return 0;
  }

  await writeLine(process.stderr, "Usage: node app-server-cli.js <start-thread|start-turn|read-thread|list-loaded> [--key value]\n");
  return 1;
}

try {
  const code = await main();
  process.exit(typeof code === "number" ? code : 0);
} catch (error) {
  const message = error?.stack || error?.message || String(error);
  await writeLine(process.stderr, `${message}\n`);
  process.exit(1);
}
