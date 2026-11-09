// Starts the local bridge of the "Új elemzés" button (see bridge.ts):  npm run ai-bridge
// Logs go to stderr, like every notifier process.

import "../logToStderr";
import { loadEnv } from "../env";
import { analysisNow, defaultDeps } from "../tg-app";
import { BRIDGE_PORT, createBridge, defaultOrigins } from "./bridge";

const deps = defaultDeps();
const server = createBridge({
  run: () => analysisNow(deps),
  origins: defaultOrigins(loadEnv().appUrl),
});
server.on("error", (e) => {
  console.error(`bridge: cannot listen on 127.0.0.1:${BRIDGE_PORT}:`, (e as Error).message);
  process.exit(1);
});
server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.error(`bridge: http://127.0.0.1:${BRIDGE_PORT} (Új elemzés a hubon át)`);
});
