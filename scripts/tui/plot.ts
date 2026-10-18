// Terminal plotting primitives (pure, no Ink): a braille line plot, vertical
// bars around a zero line and horizontal bars. They return rows of coloured
// text runs, which the views turn into <Text> elements.

export interface Run {
  text: string;
  color?: string;
}
export type Row = Run[];

export interface LineSeries {
  values: number[];
  color: string;
}

export interface LinePlot {
  rows: Row[];
  min: number;
  max: number;
}

// Braille dot (x 0..1, y 0..3) -> bit of the U+2800 block.
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

const finite = (xs: number[]) => xs.filter(Number.isFinite);

/** Merge neighbouring runs of the same colour. */
function compact(row: Run[]): Row {
  const out: Row = [];
  for (const r of row) {
    const last = out[out.length - 1];
    if (last && last.color === r.color) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

/** Bresenham line between two dots, calling `set` for every dot on it. */
function line(x0: number, y0: number, x1: number, y1: number, set: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    set(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Lines on a shared y scale, `width` x `height` character cells (each cell is
 * 2x4 braille dots). A series is stretched over the full width; where series
 * share a cell the later one's colour wins. `domain` fixes the y range.
 */
export function linePlot(
  series: LineSeries[],
  width: number,
  height: number,
  domain?: [number, number],
): LinePlot {
  const all = finite(series.flatMap((s) => s.values));
  if (!all.length || width < 1 || height < 1) return { rows: [], min: 0, max: 0 };
  let min = domain ? domain[0] : Math.min(...all);
  let max = domain ? domain[1] : Math.max(...all);
  if (max === min) {
    min -= 1;
    max += 1;
  }
  const W = width * 2;
  const H = height * 4;
  const mask = new Uint8Array(width * height);
  const owner = new Int16Array(width * height).fill(-1);
  const set = (si: number) => (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const cell = Math.floor(y / 4) * width + Math.floor(x / 2);
    mask[cell] |= DOT[x % 2][y % 4];
    owner[cell] = si;
  };
  series.forEach((s, si) => {
    const n = s.values.length;
    const px = (i: number) => (n === 1 ? 0 : Math.round((i / (n - 1)) * (W - 1)));
    const py = (v: number) => Math.round(((max - v) / (max - min)) * (H - 1));
    let prev: [number, number] | null = null;
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        prev = null;
        return;
      }
      const cur: [number, number] = [px(i), py(v)];
      if (prev) line(prev[0], prev[1], cur[0], cur[1], set(si));
      else set(si)(cur[0], cur[1]);
      prev = cur;
    });
  });
  const rows: Row[] = [];
  for (let r = 0; r < height; r++) {
    const runs: Run[] = [];
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      runs.push(
        mask[i]
          ? { text: String.fromCharCode(0x2800 + mask[i]), color: series[owner[i]].color }
          : { text: " " },
      );
    }
    rows.push(compact(runs));
  }
  return { rows, min, max };
}

export interface Bar {
  value: number;
  color?: string;
}

const UP = " ▁▂▃▄▅▆▇█";

/**
 * Vertical bars around a zero line: positive ones grow up (eighth-block
 * resolution), negative ones down (whole rows). Each bar takes `barWidth`
 * cells and `gap` blank ones; returns `height` rows (plus a zero row when
 * there are negative bars and positive ones both).
 */
export function verticalBars(bars: Bar[], height: number, barWidth = 1, gap = 1): Row[] {
  if (!bars.length || height < 1) return [];
  const pos = Math.max(0, ...bars.map((b) => b.value));
  const neg = Math.max(0, ...bars.map((b) => -b.value));
  if (pos === 0 && neg === 0) return [[{ text: "─".repeat(bars.length * (barWidth + gap)) }]];
  const total = pos + neg;
  let up = neg === 0 ? height : pos === 0 ? 0 : Math.round((height * pos) / total);
  if (pos > 0) up = Math.max(1, up);
  let down = height - up;
  if (neg > 0 && down < 1) {
    down = 1;
    up = Math.max(0, height - 1);
  }
  const unit = Math.max(pos / Math.max(up, 1), neg / Math.max(down, 1));
  const rows: Row[] = [];
  for (let r = up; r >= 1; r--) {
    const runs: Run[] = [];
    for (const b of bars) {
      // Eighths of a row this bar fills in row r (counted from the zero line).
      let eighths = Math.round((Math.max(0, b.value) / unit - (r - 1)) * 8);
      // A bar that exists never vanishes: at least the thinnest block.
      if (r === 1 && b.value > 0 && eighths < 1) eighths = 1;
      const ch = eighths >= 8 ? "█" : eighths <= 0 ? " " : UP[eighths];
      runs.push({ text: ch.repeat(barWidth), color: b.color }, { text: " ".repeat(gap) });
    }
    rows.push(compact(runs));
  }
  if (up > 0 && down > 0)
    rows.push([{ text: "─".repeat(bars.length * (barWidth + gap)) }]);
  for (let r = 1; r <= down; r++) {
    const runs: Run[] = [];
    for (const b of bars) {
      const filled = b.value < 0 && -b.value / unit > r - 0.5;
      runs.push({ text: (filled ? "█" : " ").repeat(barWidth), color: b.color }, { text: " ".repeat(gap) });
    }
    rows.push(compact(runs));
  }
  return rows;
}

export interface HBar {
  label: string;
  value: number;
  color?: string;
  /** Text after the bar (percent, amount…). */
  note?: string;
}

const LEFT = " ▏▎▍▌▋▊▉";

/** Horizontal bars: label column, bar scaled to the largest value, note. */
export function horizontalBars(items: HBar[], barWidth: number): { label: string; bar: Run; note: string }[] {
  const max = Math.max(0, ...items.map((i) => i.value));
  const labelW = Math.max(0, ...items.map((i) => [...i.label].length));
  return items.map((i) => {
    const eighths = max > 0 ? Math.round((Math.max(0, i.value) / max) * barWidth * 8) : 0;
    const full = Math.floor(eighths / 8);
    const part = eighths % 8;
    return {
      label: i.label + " ".repeat(labelW - [...i.label].length),
      bar: { text: "█".repeat(full) + (part ? LEFT[part] : ""), color: i.color },
      note: i.note ?? "",
    };
  });
}
