import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { VWCE, WBIT } from "../../src/test/fixture";
import type { Context } from "./data";
import { chartButtons, chartCaption, chartCard, chartTargets, chartText, findTarget, sparkline } from "./chart";
import { chartSvg } from "./chartImage";
import { buildChartRows } from "../../src/lib/priceChart";
import { contextAt } from "./testContext";
import { runHandler, type Deps, type HubResponse } from "./tg-app";

afterEach(() => vi.useRealTimers());

const WED: [number, number, number, number] = [2026, 10, 14, 10];
const wave = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + Math.sin(i / 5) * 2);

/** The fixture's quotes have no curves: give EUR and VWCE one. */
function withCurves(): Context {
  const ctx = contextAt(WED);
  const day = (key: string) => {
    const q = ctx.liveQuotes[key];
    q.prevDay = wave(100, q.prevClose ?? q.price);
    q.intraday = wave(40, q.price);
  };
  day("EUR");
  day(VWCE);
  return ctx;
}

describe("sparkline", () => {
  it("is empty without a today curve", () => {
    expect(sparkline({ price: 1 })).toBe("");
  });

  it("puts the previous session left of │ and spans the scale from ▁ to █", () => {
    const line = sparkline({ price: 5, prevDay: [1, 2, 3, 4, 5], intraday: [5, 4, 3, 2, 1], session: { start: 0, end: 5 * 5 * 60_000 } });
    const [left, right] = line.split("│");
    expect(left.startsWith("▁")).toBe(true);
    expect(left).toContain("█");
    expect(right.startsWith("█")).toBe(true);
  });

  it("a half-finished session fills only part of today's half", () => {
    const session = { start: 0, end: 100 * 5 * 60_000 };
    const half = sparkline({ price: 1, intraday: wave(50, 10), session });
    const full = sparkline({ price: 1, intraday: wave(100, 10), session });
    expect(half.length).toBeLessThan(full.length);
  });

  it("a flat curve does not divide by zero", () => {
    expect(sparkline({ price: 1, intraday: [3, 3, 3] })).toMatch(/^[▁-█]+$/);
  });
});

describe("/chart", () => {
  // A stand-in for Chromium: the "PNG" is the SVG's bytes.
  const fakePng = async (svg: string) => Buffer.from(svg);
  let renderPng: Deps["renderPng"] = fakePng;
  beforeEach(() => {
    renderPng = fakePng;
  });
  const depsFor = (ctx: Context): Deps => ({
    renderPng: (svg) => renderPng!(svg),
    load: async () => ctx,
    stateFile: "unused",
    env: { bigMovePct: 2, positionMovePct: 5, wealthStepHuf: 1_000_000, drawdownStepPct: 5 },
  });
  const base = { v: 1, id: "r", app: "portfolio", now: "" };
  const call = async (req: object, ctx: Context) =>
    JSON.parse(await runHandler(JSON.stringify({ ...base, ...req }), depsFor(ctx))) as HubResponse;

  it("targets are the cards with a curve (the other holding has none)", () => {
    const keys = chartTargets(withCurves()).map((t) => t.key);
    expect(keys).toEqual(["EUR", VWCE]);
    expect(keys).not.toContain(WBIT);
  });

  it("findTarget takes ticker, label and key in any case", () => {
    const targets = chartTargets(withCurves());
    expect(findTarget(targets, "vwce")?.key).toBe(VWCE);
    expect(findTarget(targets, "eur/huf")?.key).toBe("EUR");
    expect(findTarget(targets, "eur")?.key).toBe("EUR");
    expect(findTarget(targets, "nincs")).toBeUndefined();
  });

  it("no argument → menu with a button per card, callback data within 64 bytes", async () => {
    const r = await call({ type: "command", command: "chart", args: "" }, withCurves());
    const buttons = r.messages![0].buttons!.flat();
    expect(buttons.map((b) => b.data)).toEqual(["chart:EUR", `chart:${VWCE}`]);
    expect(r.editOriginal).toBeUndefined();
  });

  it("/chart vwce → a photo with a caption and the buttons, the open card marked", async () => {
    const r = await call({ type: "command", command: "chart", args: "vwce" }, withCurves());
    const m = r.messages![0];
    expect(m.html).toContain("VWCE");
    expect(m.html).not.toContain("<pre>");
    const svg = Buffer.from(m.photo!.base64, "base64").toString();
    expect(svg).toContain("<svg");
    expect(svg).toContain("előző zárás");
    expect(m.buttons!.flat().find((b) => b.data === `chart:${VWCE}`)!.text).toMatch(/^▸ /);
  });

  it("a rendering failure falls back to the text chart", async () => {
    renderPng = async () => {
      throw new Error("no chromium");
    };
    const r = await call({ type: "command", command: "chart", args: "vwce" }, withCurves());
    const m = r.messages![0];
    expect(m.photo).toBeUndefined();
    expect(m.html).toContain("<pre>");
    expect(m.buttons).toBeDefined();
  });

  it("a button press edits the pressed message", async () => {
    const r = await call({ type: "callback", data: "chart:EUR" }, withCurves());
    expect(r.editOriginal).toBe(true);
    expect(r.messages![0].html).toContain("EUR/HUF");
    expect(r.messages![0].photo).toBeDefined();
  });

  it("an unknown name says so and offers the menu", async () => {
    const r = await call({ type: "command", command: "chart", args: "xyz" }, withCurves());
    expect(r.messages![0].html).toContain("Nem találom");
    expect(r.messages![0].buttons).toBeDefined();
  });

  it("a weekend quote's change carries its day, not 'ma'", () => {
    const ctx = withCurves();
    // Friday's last trade, seen on Wednesday: labelled with the day.
    ctx.liveQuotes[VWCE].marketTime = new Date(2026, 9, 9, 17).getTime();
    expect(chartText(ctx, { key: VWCE, label: "VWCE" })).toContain("péntek:");
  });

  it("chartButtons lays out three to a row", () => {
    const t = Array.from({ length: 7 }, (_, i) => ({ key: `K${i}`, label: `L${i}` }));
    expect(chartButtons(t).map((r) => r.length)).toEqual([3, 3, 1]);
  });
});

describe("chart image", () => {
  it("the card has the dashboard tile's title, value and HUF equivalent", () => {
    const ctx = withCurves();
    const card = chartCard(ctx, { key: VWCE, label: "VWCE" })!;
    expect(card.title).toContain("VWCE");
    expect(card.value).toMatch(/€|EUR/);
    expect(card.sub).toMatch(/^≈ .*Ft/);
    expect(chartCard(ctx, { key: "EUR", label: "EUR/HUF" })).toMatchObject({ title: "EUR/HUF", sub: "Euró árfolyam" });
    expect(chartCard(ctx, { key: WBIT, label: "WBIT" })).toBeUndefined();
  });

  it("the caption is short and escaped", () => {
    const card = chartCard(withCurves(), { key: VWCE, label: "VWCE" })!;
    const caption = chartCaption({ ...card, title: "A<B>&C" });
    expect(caption).toContain("A&lt;B&gt;&amp;C");
    expect(caption.length).toBeLessThan(200);
  });

  const timed = (live: boolean, price = 101) => {
    const ctx = withCurves();
    const bar = 5 * 60_000;
    const t0 = new Date(2026, 9, 14, 9).getTime();
    const q = ctx.liveQuotes[VWCE];
    q.price = price;
    q.prevClose = 100;
    q.prevDay = wave(20, 100);
    q.prevDayT = q.prevDay.map((_, i) => t0 - 86_400_000 + i * bar);
    q.intraday = wave(10, 100);
    q.intradayT = q.intraday.map((_, i) => t0 + i * bar);
    q.session = { start: t0, end: t0 + 20 * bar };
    return { ctx, card: { ...chartCard(ctx, { key: VWCE, label: "VWCE" })!, live } };
  };

  it("draws both curves, the previous close and the day divider; no NaN", () => {
    const svg = chartSvg(timed(true).card);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain("előző zárás");
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it("colours follow the day's direction, and grey when the market is closed", () => {
    expect(chartSvg(timed(true, 101).card)).toContain('stroke="#34d399" stroke-width="2.6"');
    expect(chartSvg(timed(true, 99).card)).toContain('stroke="#fb7185" stroke-width="2.6"');
    const closed = chartSvg(timed(false).card);
    expect(closed).toContain('stroke="#8a93b2" stroke-width="2.6"');
    expect(closed).toContain("Most nincs aktív kereskedés.");
  });

  it("a flat curve gets a scale, not a division by zero", () => {
    const { card } = timed(true);
    card.quote = { ...card.quote, prevDay: undefined, prevDayT: undefined, intraday: [5, 5, 5], intradayT: [1, 2, 3].map((i) => i * 300_000), session: undefined, prevClose: 5, price: 5 };
    expect(chartSvg(card)).not.toMatch(/NaN|Infinity/);
  });

  it("pads today to the end of the session, like the dialog", () => {
    const { card } = timed(true);
    const { rows, split } = buildChartRows(card.quote);
    expect(split).toBe(20);
    expect(rows).toHaveLength(20 + 20);
    expect(rows.slice(30).every((r) => r.today === undefined)).toBe(true);
  });
});
