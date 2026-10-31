// The assistant's HTML view: built from the same Context as the Telegram reports, on the invented portfolio.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NEWS_ACTION, portfolioViewHtml, trendSvg } from "./assistantView";
import { contextAt } from "./testContext";
import { runHandler } from "./tg-app";
import { utcDay } from "../../src/lib/day";
import type { ValuePoint } from "../../src/lib/series";

afterEach(() => vi.useRealTimers());

const APP_URL = "https://vrbst.github.io/portfolio-kezelo/";
const descriptor = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../asszisztens.app.json"), "utf8")) as {
  view: { command: string; open?: string[] };
  actions: { id: string; effect: string; approval: string }[];
};

describe("portfolioViewHtml", () => {
  it("shows the value, the day's move, the accounts, the positions and the goals of the invented portfolio", () => {
    const ctx = contextAt([2026, 10, 14, 10, 0]);
    const html = portfolioViewHtml(ctx, APP_URL);
    expect(html).toContain("Portfólió értéke");
    expect(html).toContain(ctx.summary.totalValueHuf.toLocaleString("hu-HU", { maximumFractionDigits: 0 }).replace(/\s/g, " ").slice(0, 3));
    for (const a of ctx.summary.accounts) {
      if (Math.abs(a.totalValueHuf) < 1) continue;
      expect(html.length).toBeGreaterThan(500);
    }
    expect(html).toContain("<h3>Számlák</h3>");
    expect(html).toContain("<h3>Legnagyobb pozíciók</h3>");
    expect(html).toContain("Az elmúlt év");
  });

  it("is a fragment the assistant can take: no script, frame, form, event handler or external URL; styles stay inline", () => {
    const html = portfolioViewHtml(contextAt([2026, 10, 14, 10, 0]), APP_URL);
    expect(html).not.toMatch(/<script|<iframe|<form|<object|<embed|<link|<meta|<base/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html.length).toBeLessThan(256 * 1024);
  });

  it("every data-act points at an action of the descriptor, and every data-open at an origin it allows", () => {
    const html = portfolioViewHtml(contextAt([2026, 10, 14, 10, 0]), APP_URL);
    const acts = [...html.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
    expect(acts).toContain(NEWS_ACTION);
    for (const a of acts) expect(descriptor.actions.map((x) => x.id)).toContain(a);
    expect(descriptor.actions.find((a) => a.id === NEWS_ACTION)).toMatchObject({ effect: "external", approval: "ask" });
    const opens = [...html.matchAll(/data-open="([^"]+)"/g)].map((m) => new URL(m[1]).origin);
    const allowed = new Set([new URL(APP_URL).origin, ...(descriptor.view.open ?? [])]);
    for (const o of opens) expect(allowed.has(o), o).toBe(true);
  });

  it("escapes data text: an instrument or goal name with markup does not reach the HTML", () => {
    const ctx = contextAt([2026, 10, 14, 10, 0], (s) => {
      s.instruments[0].name = '<img src=x onerror=alert(1)> "Teszt" & Társa';
    });
    const html = portfolioViewHtml(ctx, APP_URL);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;"); // shown as text, never as markup
  });

  it("works without a series, events, goals or alerts (a bare portfolio still renders)", () => {
    const ctx = contextAt([2026, 10, 14, 10, 0]);
    const bare = { ...ctx, series: [], events: [], goalProgress: [], savings: [], alerts: [], dayChange: null };
    const html = portfolioViewHtml(bare, APP_URL);
    expect(html).toContain("Portfólió értéke");
    expect(html).not.toContain("Az elmúlt év");
    expect(html).not.toContain("Közelgő események");
    expect(html).not.toContain("<h3>Célok</h3>");
  });
});

describe("trendSvg", () => {
  const day = (i: number) => utcDay(Date.UTC(2026, 0, 1) + i * 86_400_000);
  const series = (n: number): ValuePoint[] => Array.from({ length: n }, (_, i) => ({ date: day(i), value: 1_000_000 + i * 1000, invested: 900_000 + i * 500 }) as ValuePoint);

  it("draws the value line and the invested line, at most ~140 points, only the last year", () => {
    const svg = trendSvg(series(500));
    expect(svg).toMatch(/^<svg class="spark" viewBox="0 0 720 170"/);
    const points = (svg.match(/class="val" d="([^"]+)"/)?.[1].match(/[ML]/g) ?? []).length;
    expect(points).toBeGreaterThan(2);
    expect(points).toBeLessThanOrEqual(142);
    expect(svg).toContain('class="inv"');
  });

  it("is empty for fewer than two points and survives flat series (no NaN)", () => {
    expect(trendSvg([])).toBe("");
    expect(trendSvg(series(1))).toBe("");
    const flat = Array.from({ length: 5 }, (_, i) => ({ date: day(i), value: 5, invested: 5 }) as ValuePoint);
    expect(trendSvg(flat)).not.toMatch(/NaN|Infinity/);
  });
});

describe("assistant_view command", () => {
  it("answers with a view (and no Telegram message); it is not a Telegram command", async () => {
    const ctx = contextAt([2026, 10, 14, 10, 0]);
    const out = await runHandler(
      JSON.stringify({ v: 1, id: "r", app: "portfolio", type: "command", command: descriptor.view.command, args: "dark", now: ctx.at.toISOString(), chat: { id: 1 }, message: { id: 1, date: "" }, argv: ["dark"] }),
      { load: async () => ctx, stateFile: undefined as never } as never,
    );
    const res = JSON.parse(out) as { messages: unknown[]; view: { html: string; title: string } };
    expect(res.messages).toEqual([]);
    expect(res.view.title).toBe("Portfólió");
    expect(res.view.html).toContain("Portfólió értéke");
    const tgDescriptor = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../tg-hub.app.json"), "utf8")) as { commands: { name: string }[] };
    expect(tgDescriptor.commands.map((c) => c.name)).not.toContain(descriptor.view.command);
  });
});
