import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeEngine, type EngineRun } from "./engine";
import { HubError, hubErrorCode, type HubAskOptions, type HubAskResult } from "../hubClient";
import { NEWS_JSON_SCHEMA } from "../../../src/lib/newsSchema";

// No real hub and no real claude: askImpl / directImpl record what they get.
const hubAnswer = (over: Partial<HubAskResult> = {}): HubAskResult => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "szöveg",
  structured_output: { ok: 1 },
  total_cost_usd: 0.25,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  call_id: 9,
  queued_ms: 0,
  run_ms: 1,
  stderr: "ZAJ",
  ...over,
});
const conn = { baseUrl: "http://127.0.0.1:7420", apiKey: "k" };
const recorder = (answer: HubAskResult | Error) => {
  const calls: HubAskOptions[] = [];
  return {
    calls,
    askImpl: async (o: HubAskOptions) => {
      calls.push(o);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};
const hubErr = (code: string, status = 500) => new HubError(code, status, `hiba: ${code}`);

afterEach(() => vi.restoreAllMocks());

describe("claudeCodeEngine → the hub", () => {
  it("sends the model, the web tools, the schema, the run limit, priority and run_id", async () => {
    const r = recorder(hubAnswer());
    const out = await claudeCodeEngine({ model: "opus", hub: conn, runId: "r_abc", priority: "background", askImpl: r.askImpl }).run("kérdés");
    expect(r.calls).toEqual([
      {
        prompt: "kérdés",
        model: "opus",
        tools: ["WebSearch", "WebFetch"],
        allowed_tools: ["WebSearch", "WebFetch"],
        json_schema: NEWS_JSON_SCHEMA,
        timeout_s: 720,
        priority: "background",
        run_id: "r_abc",
      },
    ]);
    // The structured answer wins over the text; the cost is the CLI's; stderr never mixes in.
    expect(out).toEqual({ output: { ok: 1 }, costUsd: 0.25 });
  });

  it('tools: "" means no tools at all and no allowed_tools', async () => {
    const r = recorder(hubAnswer());
    await claudeCodeEngine({ model: "opus", tools: "", hub: conn, askImpl: r.askImpl }).run("p");
    expect(r.calls[0].tools).toEqual([]);
    expect(r.calls[0]).not.toHaveProperty("allowed_tools");
  });

  it("the answer falls back to the plain text; the deadline goes to the hub as given", async () => {
    const r = recorder(hubAnswer({ structured_output: undefined }));
    const deadline = new Date(Date.now() + 3_600_000);
    const out = await claudeCodeEngine({ model: "opus", hub: conn, deadline, askImpl: r.askImpl }).run("p");
    expect(out.output).toBe("szöveg");
    expect(r.calls[0].deadline).toBe(deadline);
  });

  it("reports the run with its usage", async () => {
    const runs: EngineRun[] = [];
    await claudeCodeEngine({ model: "opus", hub: conn, askImpl: recorder(hubAnswer()).askImpl, onRun: (x) => runs.push(x) }).run("p");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("a CLI error with JSON still reports its usage", async () => {
    const runs: EngineRun[] = [];
    const e = new HubError("cli_error", 502, "a claude hibával állt le", {
      cliJson: { usage: { input_tokens: 7, output_tokens: 3 }, total_cost_usd: 0.1 },
    });
    await expect(
      claudeCodeEngine({ model: "opus", hub: conn, askImpl: recorder(e).askImpl, onRun: (x) => runs.push(x) }).run("p"),
    ).rejects.toBe(e);
    expect(runs[0]).toMatchObject({ ok: false, error: "a claude hibával állt le", usage: { inputTokens: 7 } });
  });

  it("an expired deadline never reaches the hub", async () => {
    const r = recorder(hubAnswer());
    const runs: EngineRun[] = [];
    const e = await claudeCodeEngine({
      model: "opus",
      hub: conn,
      deadline: new Date(1_000),
      now: () => 2_000,
      askImpl: r.askImpl,
      onRun: (x) => runs.push(x),
    })
      .run("p")
      .catch((x) => x as Error);
    expect(hubErrorCode(e)).toBe("deadline_missed");
    expect(r.calls).toEqual([]);
    expect(runs[0].ok).toBe(false);
  });

  it("each call of a job is checked against the same absolute deadline", async () => {
    let now = 1_000;
    const r = recorder(hubAnswer());
    const engine = claudeCodeEngine({ model: "opus", hub: conn, deadline: new Date(5_000), now: () => now, askImpl: r.askImpl });
    await engine.run("első");
    now = 6_000; // the first call took long: the second no longer fits
    const e = await engine.run("második").catch((x) => x as Error);
    expect(hubErrorCode(e)).toBe("deadline_missed");
    expect(r.calls.map((c) => c.prompt)).toEqual(["első"]);
  });
});

describe("claudeCodeEngine: no direct claude fallback", () => {
  // Since 2026-10-17 the hub is the only way: even an unreachable hub is just an error.
  it.each(["unreachable", "quota_exhausted", "rate_limited", "timeout", "deadline_missed", "cli_error", "forbidden", "unauthorized", "unavailable", "connection_lost"])(
    "%s comes back with its own code",
    async (code) => {
      const r = recorder(hubErr(code));
      const e = await claudeCodeEngine({ model: "opus", hub: conn, askImpl: r.askImpl }).run("p").catch((x) => x as Error);
      expect(hubErrorCode(e)).toBe(code);
      expect(r.calls).toHaveLength(1);
    },
  );
});
