// Minimal Telegram Bot API client (HTML messages + long polling).

const LIMIT = 4000; // Telegram's hard cap is 4096 chars per message

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/** Escape user/data text for parse_mode=HTML. */
export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class Telegram {
  private token: string;
  constructor(token: string) {
    this.token = token;
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const data = (await res.json()) as {
      ok: boolean;
      result: T;
      description?: string;
    };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  /** Send HTML text, split on line boundaries if it's over the size limit. */
  async send(chatId: string | number, html: string) {
    const parts: string[] = [];
    let cur = "";
    for (const line of html.split("\n")) {
      if (cur.length + line.length + 1 > LIMIT && cur) {
        parts.push(cur);
        cur = "";
      }
      cur += (cur ? "\n" : "") + line;
    }
    if (cur) parts.push(cur);
    for (const text of parts)
      await this.call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
  }

  async typing(chatId: string | number) {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  /** Long poll: resolves after `timeout` s or as soon as updates arrive. */
  getUpdates(offset: number, timeout = 50): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout, allowed_updates: ["message"] },
      (timeout + 15) * 1000,
    );
  }

  leaveChat(chatId: string | number) {
    return this.call("leaveChat", { chat_id: chatId });
  }

  setCommands(commands: { command: string; description: string }[]) {
    return this.call("setMyCommands", { commands });
  }
}
