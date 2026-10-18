import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { contextAt } from "../notify/testContext";
import {
  forecastText,
  glideText,
  liquidationText,
  planText,
  returnsText,
  tbszText,
} from "../notify/reports";
import { Chart, Goals, Overview, Positions, Report, Todos } from "./views";

afterEach(() => vi.useRealTimers());

const frame = (el: React.ReactElement) => {
  const { lastFrame, unmount } = render(el);
  const out = lastFrame() ?? "";
  unmount();
  return out;
};

const ctx = () => contextAt([2026, 5, 15, 10]);

// A personal Ft/EUR amount like "1 234 567 Ft" or "35,93 M Ft".
const AMOUNT = /\d[\d\s,.]*\s?(M )?Ft/;

describe("terminal views", () => {
  it("show the amounts when not hidden", () => {
    const c = ctx();
    expect(frame(<Overview ctx={c} hide={false} />)).toMatch(AMOUNT);
    expect(frame(<Positions ctx={c} hide={false} offset={0} rows={20} />)).toMatch(AMOUNT);
  });

  it("hide every personal amount in privacy mode, on every tab", () => {
    const c = ctx();
    const views = [
      <Overview key="o" ctx={c} hide />,
      <Positions key="p" ctx={c} hide offset={0} rows={20} />,
      <Todos key="t" ctx={c} hide />,
      <Goals key="g" ctx={c} hide />,
      <Chart key="c" ctx={c} hide range={3} width={60} />,
    ];
    for (const v of views) expect(frame(v)).not.toMatch(AMOUNT);
  });

  it("show the bot reports as plain text and hide their amounts in privacy mode", () => {
    const c = ctx();
    const texts = [returnsText, forecastText, tbszText, planText, glideText, liquidationText];
    for (const text of texts.map((t) => t(c))) {
      const shown = frame(<Report text={text} hide={false} />);
      expect(shown).not.toMatch(/<\/?[a-z]+>/);
      expect(frame(<Report text={text} hide />)).not.toMatch(AMOUNT);
    }
    expect(frame(<Report text={forecastText(c)} hide={false} />)).toMatch(AMOUNT);
  });

  it("hide the goal names in privacy mode", () => {
    const c = ctx();
    const names = c.savings.map((p) => p.goal.name);
    expect(names.length).toBeGreaterThan(0);
    const shown = frame(<Goals ctx={c} hide={false} />);
    const hidden = frame(<Goals ctx={c} hide />);
    for (const n of names) {
      expect(shown).toContain(n);
      expect(hidden).not.toContain(n);
    }
  });

  it("scroll the positions list from the offset", () => {
    const c = ctx();
    const first = frame(<Positions ctx={c} hide={false} offset={0} rows={1} />);
    const second = frame(<Positions ctx={c} hide={false} offset={1} rows={1} />);
    expect(first).not.toEqual(second);
  });

  it("draw a sparkline in the chart tab", () => {
    expect(frame(<Chart ctx={ctx()} hide={false} range={3} width={60} />)).toMatch(/[▁-█]{5}/);
  });
});
