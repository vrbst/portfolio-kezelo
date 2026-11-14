// Starts the local bridge of the "Új elemzés" button (see bridge.ts):  npm run ai-bridge
// Logs go to stderr, like every notifier process.

import "../logToStderr";
import { loadEnv } from "../env";
import { analysisNow, defaultDeps } from "../tg-app";
import { askChat } from "../chat/job";
import { BRIDGE_PORT, createBridge, defaultOrigins } from "./bridge";

const deps = defaultDeps();
const chatDeps = deps.chat;
const server = createBridge({
  run: () => analysisNow(deps),
  // The app's chat: the same AI as the Telegram conversation, its own history (kept in the browser).
  chat: chatDeps ? (req) => askChat(chatDeps(), req) : undefined,
  origins: defaultOrigins(loadEnv().appUrl),
});
server.on("error", (e) => {
  console.error(`bridge: cannot listen on 127.0.0.1:${BRIDGE_PORT}:`, (e as Error).message);
  process.exit(1);
});
server.listen(BRIDGE_PORT, "127.0.0.1", () => {
  console.error(`bridge: http://127.0.0.1:${BRIDGE_PORT} (Új elemzés és chat a hubon át)`);
});
