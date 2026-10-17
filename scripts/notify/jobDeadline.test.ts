import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEADLINE_JOBS, DEADLINE_MARGIN_MS, deadlineForJob, jobDeadline, jobTimeoutMs, parseDuration } from "./jobDeadline";
import { ROOT } from "./env";
import { ENGINE_TIMEOUT_MS } from "./news/engine";

describe("jobDeadline", () => {
  it("parses the tg-hub descriptor's durations", () => {
    expect(parseDuration("25m")).toBe(25 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("6h15m")).toBe(6 * 3_600_000 + 15 * 60_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("6h 15")).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });

  it("the latest start = job start + job timeout − the longest call − the margin", () => {
    const start = Date.UTC(2026, 9, 14, 5, 45);
    // 25 min − 12 min − 3 min = 10 minutes of queue time
    expect(jobDeadline(start, 25 * 60_000).getTime() - start).toBe(25 * 60_000 - ENGINE_TIMEOUT_MS - DEADLINE_MARGIN_MS);
    expect(jobDeadline(start, 25 * 60_000).getTime() - start).toBe(10 * 60_000);
  });

  it("every time-windowed job of the real tg-hub.app.json leaves room to queue", () => {
    for (const job of DEADLINE_JOBS) {
      const t = jobTimeoutMs(job);
      expect(t, `${job} timeout`).toBeDefined();
      expect(t! - ENGINE_TIMEOUT_MS - DEADLINE_MARGIN_MS, `${job} queue window`).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });

  it("the approved timeouts are in place", () => {
    const min = (job: string) => jobTimeoutMs(job)! / 60_000;
    expect(["news-morning", "news-evening", "news-event", "news-why"].map(min)).toEqual([25, 25, 25, 25]);
    expect(min("analysis")).toBe(30);
    expect(["outlook-ai", "outlook-ai-retry"].map(min)).toEqual([35, 35]);
  });

  it("every AI job in the descriptor has a deadline (none forgotten)", () => {
    const d = JSON.parse(readFileSync(resolve(ROOT, "tg-hub.app.json"), "utf8")) as { jobs: { id: string }[] };
    const withoutAi = ["tick", "fundamentals", "outlook"];
    for (const j of d.jobs.filter((x) => !withoutAi.includes(x.id)))
      expect(DEADLINE_JOBS as readonly string[], j.id).toContain(j.id);
  });

  it("commands, the tick and unknown jobs get no deadline", () => {
    const now = Date.now();
    expect(deadlineForJob(undefined, now)).toBeUndefined();
    expect(deadlineForJob("tick", now)).toBeUndefined();
    expect(deadlineForJob("news-morning", now)).toBeInstanceOf(Date);
  });
});
