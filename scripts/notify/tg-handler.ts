// tg-hub handler process (tg-hub.app.json): a JSON request on stdin, the JSON
// response on stdout, logs on stderr. The logic is in tg-app.ts.
//
//   '{"v":1,"id":"t","app":"portfolio","now":"","type":"command","command":"allas","args":""}' |
//     node node_modules/tsx/dist/cli.mjs scripts/notify/tg-handler.ts

import "./logToStderr"; // first: nothing but the response may reach stdout
import { readFileSync } from "node:fs";
import { defaultDeps, runHandler } from "./tg-app";

const out = await runHandler(readFileSync(0, "utf8"), defaultDeps());
// Exit once it's written: a slow live-quote request still in flight must not
// keep the process (and the hub's "typing…") waiting.
process.stdout.write(out + "\n", () => process.exit(0));
