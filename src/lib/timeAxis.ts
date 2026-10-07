function monthStarts(min: number, max: number): number[] {
  const ticks: number[] = [];
  const d = new Date(min);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  if (d.getTime() < min) d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= max) {
    ticks.push(d.getTime());
    d.setMonth(d.getMonth() + 1);
  }
  return ticks;
}

function dayStarts(min: number, max: number, maxLabels: number): number[] {
  const d = new Date(min);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < min) d.setDate(d.getDate() + 1);
  const spanDays = Math.max(1, Math.round((max - d.getTime()) / 86_400_000) + 1);
  const step = Math.max(1, Math.ceil(spanDays / maxLabels));
  const ticks: number[] = [];
  while (d.getTime() <= max) {
    ticks.push(d.getTime());
    d.setDate(d.getDate() + step);
  }
  return ticks;
}

export function timeTicks(
  min: number,
  max: number,
  maxLabels = 8,
): { ticks: number[]; daily: boolean } {
  const months = monthStarts(min, max);
  if (months.length >= 3) {
    const step = Math.max(1, Math.ceil(months.length / maxLabels));
    return { ticks: months.filter((_, i) => i % step === 0), daily: false };
  }
  return { ticks: dayStarts(min, max, Math.min(maxLabels, 6)), daily: true };
}

export function formatTimeTick(ms: number, daily: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(
    "hu-HU",
    daily ? { month: "2-digit", day: "2-digit" } : { year: "2-digit", month: "short" },
  ).format(d);
}
