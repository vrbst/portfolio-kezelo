// The "inflows" path as it is measured: moved by the money that actually came
// in, never by the prices. The frozen inflowPath (glideProjection.ts) is only
// the plan; an extra deposit would otherwise put the allocation AHEAD of it,
// and that lead would swallow the next market drop — with the same fall, the
// band would only warn much later than without the deposit.
//
// From the save day, between two consecutive days with transactions:
//   • price effect — the weights of the previous day's holdings at the new
//     prices minus the previous day's weights; it adds to the bucket's "lag"
//     (actual − path), which is what the band measures;
//   • flow effect — the weights after the day's transactions minus the
//     weights before them; money that works against the lag first closes it
//     (buying a bucket that fell behind), only the rest moves the path.
// The path is actual − lag, never past the final weight. A missed payment
// does not put a bucket behind (the medium-term goals flag that); a market
// fall shows the same however much was paid in before it. Ahead of today the
// frozen path continues, the day's offset fading out by its last point.

import type { GlideConfig, InflowPoint } from "./glidePath";
import { isCashKey, isInflowMode, latestConfig } from "./glidePath";
import type { Account, Instrument, Transaction } from "./model";
import type { HistoryFile } from "./prices";
import type { PortfolioSummary } from "./portfolio";
import { summariesOnDays } from "./portfolio";
import type { Position } from "./rebalance";
import { inflowTarget, positionsFromSummary } from "./rebalance";
import { loadBrokerFees, type BrokerFees } from "./planPrefs";
import { addDaysIso, txDay } from "./day";

/** The positions at the end of one day (the last sample: today, live). */
export interface FlowSample {
  day: string;
  positions: Position[];
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * `cfg` with its inflowPath replaced by the flow-adjusted one, from samples
 * on the save day, every later day with transactions and today (the last).
 * Unchanged outside "inflows" mode or without a frozen path.
 */
export function flowAdjustedConfig(cfg: GlideConfig, samples: FlowSample[]): GlideConfig {
  const frozen = cfg.inflowPath;
  if (!isInflowMode(cfg) || !frozen?.length || samples.length < 2) return cfg;
  const ids = cfg.buckets.map((b) => b.id);

  const weightsOf = (values: Map<string, number>) => {
    const total = ids.reduce((s, id) => s + (values.get(id) ?? 0), 0);
    if (total <= 0) return null;
    return new Map(ids.map((id) => [id, (values.get(id) ?? 0) / total]));
  };
  const bucketValues = (keys: Iterable<string>, valueOf: (key: string) => number) => {
    const m = new Map<string, number>();
    for (const key of keys) {
      const id = cfg.instruments[key]?.bucketId;
      if (id != null) m.set(id, (m.get(id) ?? 0) + valueOf(key));
    }
    return m;
  };
  const byKey = (ps: Position[]) => new Map(ps.map((p) => [p.key, p]));

  // Never past the final weight on the side the bucket is heading to.
  const clamp = (id: string, w: number) => {
    const b = cfg.buckets.find((x) => x.id === id)!;
    const start = frozen[0].weights[id] ?? b.finalWeight;
    let v = w;
    if (b.finalWeight > start) v = Math.min(v, b.finalWeight);
    else if (b.finalWeight < start) v = Math.max(v, b.finalWeight);
    return Math.min(1, Math.max(0, v));
  };

  const lag = new Map(ids.map((id) => [id, 0]));
  const points: InflowPoint[] = [frozen[0]];
  let lastTarget: Record<string, number> = frozen[0].weights;
  let prev = byKey(samples[0].positions);
  let prevW = weightsOf(bucketValues(prev.keys(), (k) => prev.get(k)!.valueHuf));

  for (const s of samples.slice(1)) {
    const cur = byKey(s.positions);
    const post = weightsOf(bucketValues(cur.keys(), (k) => cur.get(k)!.valueHuf));
    if (!post) {
      prev = cur;
      continue;
    }
    // The previous day's holdings at this day's prices. Cash keeps its value;
    // a position sold out (no price today) keeps yesterday's.
    const pre = weightsOf(
      bucketValues(prev.keys(), (k) => {
        const old = prev.get(k)!;
        const now = cur.get(k);
        if (isCashKey(k) || old.quantity == null || now?.unitPriceHuf == null)
          return old.valueHuf;
        return old.quantity * now.unitPriceHuf;
      }),
    );
    if (prevW && pre) {
      for (const id of ids) {
        let l = lag.get(id)! + (pre.get(id)! - prevW.get(id)!);
        const flow = post.get(id)! - pre.get(id)!;
        if (l * flow < 0) l -= Math.sign(l) * Math.min(Math.abs(flow), Math.abs(l));
        lag.set(id, l);
      }
    }
    const target: Record<string, number> = {};
    for (const id of ids) target[id] = clamp(id, post.get(id)! - lag.get(id)!);
    // The path only moves on the day of a flow: hold it until the day before.
    const lastDay = points[points.length - 1].day;
    const dayBefore = addDaysIso(s.day, -1);
    if (dayBefore > lastDay) points.push({ day: dayBefore, weights: lastTarget });
    if (s.day > lastDay) points.push({ day: s.day, weights: target });
    lastTarget = target;
    prev = cur;
    prevW = post;
  }

  // Ahead: the frozen plan, today's offset fading out by its last point.
  const today = samples[samples.length - 1].day;
  const ahead = frozen.filter((p) => p.day > today);
  if (ahead.length === 0)
    // The plan has run out: the path stays where it is today.
    return { ...cfg, inflowPath: points, inflowReached: false };
  const shift = new Map(
    cfg.buckets.map((b) => [b.id, (lastTarget[b.id] ?? 0) - inflowTarget(cfg, b, today)]),
  );
  const end = dayMs(ahead[ahead.length - 1].day);
  const span = end - dayMs(today);
  for (const p of ahead) {
    const fade = span > 0 ? (end - dayMs(p.day)) / span : 0;
    const weights: Record<string, number> = {};
    for (const id of ids)
      weights[id] = clamp(id, (p.weights[id] ?? 0) + shift.get(id)! * fade);
    points.push({ day: p.day, weights });
  }
  return { ...cfg, inflowPath: points };
}

export interface FlowData {
  accounts: Account[];
  transactions: Transaction[];
  instruments: Map<string, Instrument>;
  fx: Record<string, number>;
  history: HistoryFile | null | undefined;
  /** Today's portfolio (live prices). */
  summary: PortfolioSummary;
  today: string;
  brokerFees?: BrokerFees;
  /** Cash set aside for savings goals, per account (as in glideStateFrom). */
  reserved?: Map<string, number>;
}

/**
 * `versions` with the newest one's inflow path flow-adjusted up to today —
 * what the band, the alerts, the bot and the chart measure against. The
 * stored versions stay the plan (edit and save those, never these).
 */
export function liveGlideVersions(versions: GlideConfig[], d: FlowData): GlideConfig[] {
  const cfg = latestConfig(versions);
  const anchor = cfg?.inflowPath?.[0]?.day;
  if (!cfg || !isInflowMode(cfg) || !anchor || anchor >= d.today) return versions;
  const days = [
    ...new Set(
      d.transactions
        .filter((t) => !t.internal)
        .map((t) => txDay(t.date))
        .filter((day) => day > anchor && day < d.today),
    ),
  ].sort();
  const fees = d.brokerFees ?? loadBrokerFees();
  const samples: FlowSample[] = [
    ...summariesOnDays(d.accounts, d.transactions, d.instruments, d.fx, d.history, [
      anchor,
      ...days,
    ]).map((s) => ({
      day: s.day,
      positions: positionsFromSummary(s.summary, s.fx, cfg.bondsAtFace, s.day, fees),
    })),
    {
      day: d.today,
      positions: positionsFromSummary(d.summary, d.fx, cfg.bondsAtFace, d.today, fees, d.reserved),
    },
  ];
  const live = flowAdjustedConfig(cfg, samples);
  return versions.map((v) => (v === cfg ? live : v));
}
