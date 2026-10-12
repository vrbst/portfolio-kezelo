// The enlarged price chart (PriceChartDialog) as an image for Telegram: the
// same rows (src/lib/priceChart.ts), colours (the classic skin's CHART) and
// layout as the dialog, drawn as SVG and rendered to PNG by Chromium.

import { chromium } from "@playwright/test";
import { formatPercent } from "../../src/lib/format";
import { buildChartRows } from "../../src/lib/priceChart";
import { lastSessionLabel, type LiveQuote } from "../../src/lib/prices";

// The classic skin (src/lib/skin.ts CHART, src/index.css) — the bot has no skin.
const C = {
  surface: "#141a2e",
  surface2: "#1a2138",
  border: "#232b45",
  grid: "#232b45",
  axis: "#8b93a7",
  muted: "#8a93b2",
  text: "#e8ecf8",
  positive: "#34d399",
  negative: "#fb7185",
};

const W = 800;
const H = 520;
const PAD = 24;
const PLOT = { left: PAD + 64, right: W - PAD - 8, top: 118, bottom: H - 64 };

export interface ChartCard {
  title: string;
  /** Formatted current price, as on the tile. */
  value: string;
  sub?: string;
  quote: LiveQuote;
  decimals?: number;
  /** The "today" curve is the session running now; otherwise it is drawn grey. */
  live: boolean;
  now: Date;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hhmm = (t: number) =>
  new Intl.DateTimeFormat("hu-HU", { hour: "2-digit", minute: "2-digit" }).format(t);
const dayLabel = (t: number) =>
  new Intl.DateTimeFormat("hu-HU", { month: "short", day: "numeric" }).format(t);

/** ~`count` round tick values covering [min, max]. */
function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
  return out;
}

export function chartSvg(card: ChartCard): string {
  const { quote, live, now } = card;
  const decimals = card.decimals ?? 2;
  const fmt = (v: number) =>
    v.toLocaleString("hu-HU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // A borrowed curve is in the proxy's own price scale (see PriceChartDialog).
  const prevClose = quote.intradayFrom ? quote.prevDay?.at(-1) : quote.prevClose;
  const change = quote.prevClose != null ? quote.price / quote.prevClose - 1 : undefined;
  const up = (change ?? 0) >= 0;
  const session = lastSessionLabel(quote, now);
  const color = !live ? C.muted : up ? C.positive : C.negative;

  const { rows, split, ticks } = buildChartRows(quote);
  const values = [
    ...rows.flatMap((r) => [r.prev, r.today]).filter((v): v is number => v != null),
    ...(prevClose != null ? [prevClose] : []),
  ];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.06;
  const yMin = lo - pad;
  const yMax = hi + pad;
  const px = (i: number) =>
    PLOT.left + (i / Math.max(1, rows.length - 1)) * (PLOT.right - PLOT.left);
  const py = (v: number) =>
    PLOT.bottom - ((v - yMin) / (yMax - yMin)) * (PLOT.bottom - PLOT.top);
  const path = (pick: (r: (typeof rows)[number]) => number | undefined) =>
    rows
      .filter((r) => pick(r) != null)
      .map((r, k) => `${k === 0 ? "M" : "L"}${px(r.i).toFixed(1)},${py(pick(r)!).toFixed(1)}`)
      .join(" ");

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" rx="22" fill="${C.surface}" stroke="${C.border}"/>`,
    `<text x="${PAD}" y="${PAD + 18}" font-size="17" font-weight="500" fill="${C.muted}">${xml(card.title)}</text>`,
  );
  // Price, change pill, sub line.
  const valueY = PAD + 58;
  out.push(
    `<text x="${PAD}" y="${valueY}" font-size="38" font-weight="600" fill="${C.text}">${xml(card.value)}</text>`,
  );
  if (change != null) {
    const label = `${session ? `${session}: ` : ""}${formatPercent(change)}`;
    const valueW = card.value.length * 19 + 10;
    const pillW = label.length * 9 + 22;
    const pillFill = session ? C.surface2 : up ? C.positive : C.negative;
    out.push(
      `<rect x="${PAD + valueW}" y="${valueY - 27}" width="${pillW}" height="32" rx="16" fill="${pillFill}" fill-opacity="${session ? 1 : 0.14}"/>`,
      `<text x="${PAD + valueW + pillW / 2}" y="${valueY - 5}" font-size="17" font-weight="500" text-anchor="middle" fill="${session ? C.muted : up ? C.positive : C.negative}">${xml(label)}</text>`,
    );
  }
  if (card.sub)
    out.push(`<text x="${PAD}" y="${valueY + 26}" font-size="16" fill="${C.muted}">${xml(card.sub)}</text>`);

  // Grid + y labels.
  for (const v of niceTicks(yMin, yMax, 5)) {
    const y = py(v);
    out.push(
      `<line x1="${PLOT.left}" x2="${PLOT.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.grid}"/>`,
      `<text x="${PLOT.left - 8}" y="${(y + 5).toFixed(1)}" font-size="13" text-anchor="end" fill="${C.axis}">${xml(fmt(v))}</text>`,
    );
  }
  // x labels.
  for (const i of ticks) {
    const t = rows[i]?.t;
    if (t) out.push(`<text x="${px(i).toFixed(1)}" y="${PLOT.bottom + 22}" font-size="13" text-anchor="middle" fill="${C.axis}">${hhmm(t)}</text>`);
  }
  out.push(`<line x1="${PLOT.left}" x2="${PLOT.right}" y1="${PLOT.bottom}" y2="${PLOT.bottom}" stroke="${C.grid}"/>`);

  // Day divider, previous close.
  if (split > 0) {
    const x = px(split - 0.5);
    out.push(
      `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${PLOT.top}" y2="${PLOT.bottom}" stroke="${C.axis}" stroke-opacity="0.5"/>`,
      `<text x="${(x - 6).toFixed(1)}" y="${PLOT.top + 16}" font-size="13" text-anchor="end" fill="${C.axis}">${rows[split]?.t ? xml(dayLabel(rows[split].t)) : "ma"}</text>`,
    );
  }
  if (prevClose != null) {
    const y = py(prevClose);
    out.push(
      `<line x1="${PLOT.left}" x2="${PLOT.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.axis}" stroke-dasharray="5 5"/>`,
      `<text x="${PLOT.left + 6}" y="${(y + 18).toFixed(1)}" font-size="13" fill="${C.axis}">${xml(`előző zárás ${fmt(prevClose)}`)}</text>`,
    );
  }
  // Curves: yesterday faded, today in the card's colour.
  out.push(
    `<path d="${path((r) => r.prev)}" fill="none" stroke="${C.axis}" stroke-opacity="0.7" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="${path((r) => r.today)}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`,
  );
  // Footer notes.
  const notes = [
    !live && "Most nincs aktív kereskedés.",
    quote.intradayFrom && `A görbe a(z) ${quote.intradayFrom} árfolyamát mutatja (ennek a jegyzésnek nincs napközbeni adata).`,
  ].filter(Boolean);
  notes.forEach((n, k) =>
    out.push(`<text x="${PAD}" y="${H - 22 - (notes.length - 1 - k) * 18}" font-size="13" fill="${C.muted}">${xml(String(n))}</text>`),
  );
  out.push("</svg>");
  return out.join("");
}

/** SVG → PNG with headless Chromium (PW_CHROMIUM_PATH picks a specific one). */
export async function svgToPng(svg: string): Promise<Buffer> {
  const browser = await chromium.launch({
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(`<body style="margin:0;background:${C.surface}">${svg}</body>`);
    return await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H }, omitBackground: true });
  } finally {
    await browser.close();
  }
}
