// Portfolio Tracker — Telegram bot. One long-running process:
//   • answers commands (long polling, no open port needed),
//   • every 5 minutes recomputes the portfolio with live quotes (like the
//     app) and sends what's new: new alerts, big daily moves (portfolio and
//     single positions), stale data, weekly / monthly reports.
// Only the owner's chat (TELEGRAM_CHAT_ID) is ever answered; anyone else is
// ignored and reported to the owner, and the bot leaves any group at once.
// Non-urgent messages wait out the quiet hours.
//
//   npx tsx scripts/notify/bot.ts          # run (Task Scheduler starts it)
//   npx tsx scripts/notify/bot.ts --once   # one check round, then exit

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, NOTIFY_DIR, type NotifyEnv } from "./env";
import { loadContext, type Context } from "./data";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { Telegram, esc, type TgMessage } from "./telegram";
import {
  HELP,
  alertLine,
  alertsText,
  eventsText,
  forecastText,
  ft,
  goalsText,
  monthlyText,
  pct,
  sft,
  statusText,
  weeklyText,
} from "./reports";

const TICK_MS = 5 * 60_000;
/** A cached context younger than this answers commands without a reload. */
const FRESH_MS = 2 * 60_000;
const STATE_FILE = resolve(NOTIFY_DIR, "state.json");

interface State {
  offset: number;
  /** Alert id → when it was first sent. Pruned when the alert resolves. */
  sentAlerts: Record<string, string>;
  lastWeekly?: string; // YYYY-MM-DD of the Sunday it was sent
  lastMonthly?: string; // YYYY-MM
  /**
   * Today's already-reported move levels (level = |move| / threshold, floored):
   * a new message goes out only when a level is crossed, so a 2% day pings
   * once, and again if it deepens to 4%.
   */
  moves?: { day: string; total: number; pos: Record<string, number> };
  /** Strangers who wrote to the bot: chat id → last reported ISO. */
  strangers?: Record<string, string>;
  /** Stale-data warnings: key → last sent ISO (re-sent at most daily). */
  warned: Record<string, string>;
  lastBeat?: string;
  lastErrorAt?: string;
  /** Messages held back during quiet hours. */
  queue: string[];
}

function loadState(): State {
  const base: State = { offset: 0, sentAlerts: {}, warned: {}, queue: [] };
  try {
    return existsSync(STATE_FILE)
      ? { ...base, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }
      : base;
  } catch {
    return base;
  }
}
function saveState(s: State) {
  mkdirSync(NOTIFY_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(0, 19), ...a);

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
const hoursSince = (iso: string | undefined, now = Date.now()) =>
  iso ? (now - Date.parse(iso)) / 3_600_000 : Infinity;

function isQuiet(env: NotifyEnv, d = new Date()): boolean {
  const [start, end] = env.quiet;
  const m = minutesOfDay(d);
  return start > end ? m >= start || m < end : m >= start && m < end;
}

const COMMANDS = [
  { command: "allas", description: "Aktuális vagyon, napi változás" },
  { command: "teendok", description: "Aktív figyelmeztetések" },
  { command: "esemenyek", description: "Következő 30 nap eseményei" },
  { command: "cel", description: "Célok állása" },
  { command: "elorejelzes", description: "1–20 éves előrejelzés" },
  { command: "heti", description: "Heti összefoglaló most" },
  { command: "havi", description: "Előző havi zárás most" },
  { command: "help", description: "Súgó" },
];

class Bot {
  private env = loadEnv();
  private tg = new Telegram(this.env.botToken);
  private state = loadState();
  private ctx: Context | null = null;
  private loading: Promise<Context> | null = null;

  /** Load (or reuse a fresh) context; concurrent callers share one load. */
  private async context(maxAgeMs = FRESH_MS): Promise<Context> {
    if (this.ctx && Date.now() - this.ctx.at.getTime() < maxAgeMs)
      return this.ctx;
    this.loading ??= loadContext(this.env).finally(() => {
      this.loading = null;
    });
    this.ctx = await this.loading;
    return this.ctx;
  }

  private async say(html: string) {
    await this.tg.send(this.env.chatId, html);
  }

  /** Urgent → now; otherwise held back during quiet hours. */
  private async notify(html: string, urgent = false) {
    if (!urgent && isQuiet(this.env)) {
      this.state.queue.push(html);
      saveState(this.state);
      return;
    }
    await this.say(html);
  }

  // ---- commands -----------------------------------------------------------

  private async onMessage(m: TgMessage) {
    const text = (m.text ?? "").trim();
    if (String(m.chat.id) !== this.env.chatId) {
      await this.onStranger(m);
      return;
    }
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    const handlers: Record<string, (c: Context) => string> = {
      "/allas": statusText,
      "/teendok": alertsText,
      "/esemenyek": (c) => eventsText(c, 30),
      "/cel": goalsText,
      "/elorejelzes": forecastText,
      "/heti": weeklyText,
      "/havi": monthlyText,
    };
    if (cmd === "/start" || cmd === "/help" || !handlers[cmd]) {
      await this.say(HELP);
      return;
    }
    await this.tg.typing(this.env.chatId).catch(() => {});
    try {
      await this.say(handlers[cmd](await this.context()));
    } catch (e) {
      await this.say(`❌ Nem sikerült: ${esc((e as Error).message)}`);
    }
  }

  /** Never answer a stranger; leave groups; tell the owner (once a day each). */
  private async onStranger(m: TgMessage) {
    const who = m.from?.username
      ? `@${m.from.username}`
      : (m.from?.first_name ?? String(m.chat.id));
    log("ignored message from", m.chat.id, who);
    if (m.chat.type !== "private")
      await this.tg.leaveChat(m.chat.id).catch(() => {});
    const seen = (this.state.strangers ??= {});
    const key = String(m.chat.id);
    if (hoursSince(seen[key]) < 24) return;
    seen[key] = new Date().toISOString();
    saveState(this.state);
    await this.say(
      m.chat.type === "private"
        ? `🛡 Valaki írt a botnak (${esc(who)}, id ${m.chat.id}). Nem válaszoltam neki, semmilyen adatot nem kapott.`
        : `🛡 ${esc(who)} felvett egy csoportba („${esc((m.chat as { title?: string }).title ?? "?")}"). Azonnal kiléptem belőle.`,
    );
  }

  private async pollLoop() {
    for (;;) {
      try {
        const updates = await this.tg.getUpdates(this.state.offset);
        for (const u of updates) {
          this.state.offset = u.update_id + 1;
          saveState(this.state);
          if (u.message) await this.onMessage(u.message);
        }
      } catch (e) {
        log("poll error:", (e as Error).message);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  // ---- scheduled checks ---------------------------------------------------

  async tick() {
    const now = new Date();
    const st = this.state;

    // Coming back after an outage (machine off, crash) → say so, once.
    const down = hoursSince(st.lastBeat);
    if (st.lastBeat && down > 3)
      await this.notify(
        `🔌 Újra futok – ${Math.round(down)} órán át nem figyeltem. Közben lemaradt értesítéseket most pótolom.`,
      );

    let ctx: Context;
    try {
      ctx = await this.context(0);
    } catch (e) {
      const msg = (e as Error & { status?: number }).message;
      log("load error:", msg);
      if (hoursSince(st.lastErrorAt) > 6) {
        st.lastErrorAt = now.toISOString();
        const auth = /\b(401|403)\b/.test(msg);
        await this.notify(
          auth
            ? "🔑 Nem érem el a szinkron-repót (a GitHub-token lejárt vagy hibás). Frissítsd a .notify/.env-ben a GITHUB_TOKEN-t."
            : `❌ Nem sikerült frissíteni az adatokat: ${esc(msg)}`,
          true,
        );
      }
      st.lastBeat = now.toISOString();
      saveState(st);
      return;
    }

    // 1) New alerts (the app's own rules, dismissed ones skipped).
    const active = new Set(ctx.alerts.map((a) => a.id));
    const fresh = ctx.alerts.filter((a) => !st.sentAlerts[a.id]);
    if (fresh.length) {
      const head =
        fresh.length === 1 ? "⚠️ <b>Új teendő</b>" : `⚠️ <b>${fresh.length} új teendő</b>`;
      await this.notify(
        [head, ...fresh.map(alertLine)].join("\n\n"),
        fresh.some((a) => a.severity === "high"),
      );
      for (const a of fresh) st.sentAlerts[a.id] = now.toISOString();
    }
    // Resolved alerts are forgotten, so a later re-trigger is new again.
    for (const id of Object.keys(st.sentAlerts))
      if (!active.has(id)) delete st.sentAlerts[id];

    // 2) Big daily moves: the whole portfolio and single positions, each
    //    re-reported only when it crosses the next threshold level.
    const today = localDay(now);
    if (st.moves?.day !== today) st.moves = { day: today, total: 0, pos: {} };
    const moves = st.moves;
    const level = (x: number, step: number) =>
      Math.floor((Math.abs(x) * 100 + 1e-9) / step);
    const dc = ctx.dayChange;
    if (dc?.pct != null && dc.note === "ma") {
      const lv = level(dc.pct, this.env.bigMovePct);
      if (lv > moves.total) {
        moves.total = lv;
        await this.notify(
          `${dc.abs > 0 ? "🚀" : "🔻"} <b>Nagy mozgás ma: ${pct(dc.pct, 2)}</b> (${sft(dc.abs)})\nVagyon: ${ft(ctx.summary.totalValueHuf)}`,
        );
      }
    }
    const posLines: string[] = [];
    for (const h of consolidatedHoldings(ctx.summary)) {
      const q = ctx.liveQuotes[h.instrumentKey];
      if (!q?.prevClose || !q.price) continue;
      const ch = q.price / q.prevClose - 1;
      const lv = level(ch, this.env.positionMovePct);
      if (lv > (moves.pos[h.instrumentKey] ?? 0)) {
        moves.pos[h.instrumentKey] = lv;
        // HUF move of the position today: value now minus value at prev close.
        const move = h.marketValueHuf - h.marketValueHuf / (1 + ch);
        posLines.push(
          `${ch > 0 ? "🚀" : "🔻"} <b>${esc(h.instrument?.name ?? h.instrumentKey)}: ${pct(ch, 1)}</b> ma (${sft(move)}, pozíció: ${ft(h.marketValueHuf)})`,
        );
      }
    }
    if (posLines.length) await this.notify(posLines.join("\n"));

    // 3) Stale data: no sync in 2 weeks, price file 3+ days old.
    const stale: [string, number, string][] = [
      [
        "sync",
        hoursSince(ctx.snapshot.exportedAt) / 24,
        "📥 Több mint 14 napja nem szinkronizált az app – ha volt új kivonat, importáld, különben a jelentések elavultak.",
      ],
      [
        "prices",
        hoursSince(ctx.priceFile?.updatedAt) / 24,
        "📉 Az árfolyamfájl 3+ napja nem frissült – lehet, hogy a GitHub Actions árfrissítés hibára futott.",
      ],
    ];
    for (const [key, days, msg] of stale) {
      const limit = key === "sync" ? 14 : 3;
      if (days > limit && hoursSince(st.warned[key]) > 24 * 7) {
        st.warned[key] = now.toISOString();
        await this.notify(msg);
      } else if (days <= limit) delete st.warned[key];
    }

    // 4) Weekly (Sunday from 18:00) and monthly (the 1st from 08:00) reports.
    if (now.getDay() === 0 && now.getHours() >= 18 && st.lastWeekly !== today) {
      st.lastWeekly = today;
      await this.notify(weeklyText(ctx));
    }
    const ym = today.slice(0, 7);
    if (now.getHours() >= 8 && st.lastMonthly !== ym) {
      // First run ever: don't fire a report for a month we joined halfway.
      if (st.lastMonthly) await this.notify(monthlyText(ctx));
      st.lastMonthly = ym;
    }

    st.lastBeat = now.toISOString();
    saveState(st);
  }

  /** Flush messages held back during quiet hours. */
  private async flushQueue() {
    if (!this.state.queue.length || isQuiet(this.env)) return;
    const q = this.state.queue;
    this.state.queue = [];
    saveState(this.state);
    for (const html of q) await this.say(html);
  }

  async run(once: boolean) {
    // No owner → refuse to run, rather than answering whoever writes first.
    if (!/^-?\d+$/.test(this.env.chatId))
      throw new Error(
        "Hiányzik a TELEGRAM_CHAT_ID a .notify/.env-ből – a bot nem indul el tulajdonos nélkül.",
      );
    log("start");
    if (!this.state.lastWeekly) {
      // Don't send a report for the current week/month on the very first run.
      this.state.lastWeekly = localDay(new Date());
    }
    if (once) {
      await this.tick();
      await this.flushQueue();
      return;
    }
    await this.tg.setCommands(COMMANDS).catch((e) => log(e.message));
    void this.pollLoop();
    const round = async () => {
      try {
        await this.tick();
        await this.flushQueue();
      } catch (e) {
        log("tick error:", (e as Error).message);
      }
    };
    await round();
    setInterval(round, TICK_MS);
  }
}

await new Bot().run(process.argv.includes("--once"));
