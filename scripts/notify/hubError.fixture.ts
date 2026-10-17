// Hub errors for the tests: the typed classes of the official client (vendor/hub-client),
// built the way the client builds them — from the hub's error body — and the two
// client-side codes (unreachable, connection_lost) with their own classes.

import { ConnectionLostError, HubUnreachableError } from "../../vendor/hub-client/index.js";
import { errorFromResponse, type HubClientError } from "./hubClient";

export function hubError(
  code: string,
  o: { message?: string; status?: number; callId?: number; resetAt?: Date | null; exitCode?: number; stderrTail?: string; cliJson?: object } = {},
): HubClientError {
  const message = o.message ?? `hiba: ${code}`;
  if (code === "unreachable") return new HubUnreachableError(message);
  if (code === "connection_lost") return new ConnectionLostError(message);
  return errorFromResponse(o.status ?? 502, {
    error: {
      code,
      message,
      ...(o.callId !== undefined ? { call_id: o.callId } : {}),
      ...(o.resetAt ? { reset_at: o.resetAt.toISOString() } : {}),
      ...(o.exitCode !== undefined ? { exit_code: o.exitCode } : {}),
      ...(o.stderrTail !== undefined ? { stderr_tail: o.stderrTail } : {}),
      ...(o.cliJson ? { cli_json: o.cliJson } : {}),
    },
  });
}
