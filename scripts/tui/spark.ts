// Unicode sparkline helpers for the terminal chart.

const BLOCKS = "▁▂▃▄▅▆▇█";

/** Down-sample to at most `width` points (last value of each bucket). */
export function resample(values: number[], width: number): number[] {
  if (width <= 0) return [];
  if (values.length <= width) return values;
  const out: number[] = [];
  for (let i = 0; i < width; i++) {
    const end = Math.round(((i + 1) * values.length) / width);
    out.push(values[Math.max(0, end - 1)]);
  }
  return out;
}

/** One block character per value, scaled between the min and max. */
export function sparkline(values: number[], width: number): string {
  const v = resample(values.filter(Number.isFinite), width);
  if (!v.length) return "";
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (max === min) return BLOCKS[3].repeat(v.length);
  return v
    .map((x) => BLOCKS[Math.round(((x - min) / (max - min)) * (BLOCKS.length - 1))])
    .join("");
}
