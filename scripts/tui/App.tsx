// Terminal view of the portfolio (Ink): the same Context the Telegram bot
// builds (scripts/notify/data.ts), rendered read-only.

import { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { loadEnv } from "../notify/env";
import { loadContext, type Context } from "../notify/data";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { CHART_RANGES } from "./ranges";
import {
  forecastText,
  glideText,
  liquidationText,
  planText,
  returnsText,
  tbszText,
} from "../notify/reports";
import { Chart, Goals, Overview, Positions, Report, Todos } from "./views";

const TABS = ["Állás", "Pozíciók", "Teendők", "Célok", "Grafikon", "Hozam", "Előrejelzés", "TBSZ", "Terv", "Pálya", "Eladás"] as const;

// Tabs 6+ show the Telegram bot report of the same name as plain text.
const REPORTS: Record<number, (ctx: Context) => string> = {
  5: returnsText,
  6: forecastText,
  7: tbszText,
  8: planText,
  9: glideText,
  10: liquidationText,
};

export function App() {
  const { exit } = useApp();
  const [ctx, setCtx] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hide, setHide] = useState(true);
  const [run, setRun] = useState(0);
  const [tab, setTab] = useState(0);
  const [offset, setOffset] = useState(0);
  const [range, setRange] = useState(1);

  useEffect(() => {
    let live = true;
    loadContext(loadEnv())
      .then((c) => live && setCtx(c))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [run]);

  const reload = useCallback(() => {
    setError(null);
    setCtx(null);
    setRun((n) => n + 1);
  }, []);

  const { rows: termRows, columns: termCols } = useWindowSize();
  const listRows = Math.max(5, termRows - 8);
  const holdingCount = ctx ? consolidatedHoldings(ctx.summary).length : 0;

  useInput((input, key) => {
    if (input === "q") exit();
    else if (input === "p") setHide((h) => !h);
    else if (input === "r") reload();
    else if (key.tab) setTab((t) => (t + (key.shift ? TABS.length - 1 : 1)) % TABS.length);
    else if (key.rightArrow) setTab((t) => (t + 1) % TABS.length);
    else if (key.leftArrow) setTab((t) => (t + TABS.length - 1) % TABS.length);
    else if (/^[1-9]$/.test(input)) setTab(Number(input) - 1);
    else if (tab === 1 && key.downArrow)
      setOffset((o) => Math.min(Math.max(0, holdingCount - listRows), o + 1));
    else if (tab === 1 && key.upArrow) setOffset((o) => Math.max(0, o - 1));
    else if (tab === 4 && input === "t") setRange((x) => (x + 1) % CHART_RANGES.length);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexWrap="wrap">
        {TABS.map((t, i) => (
          <Box key={t} marginRight={1}>
            <Text inverse={i === tab} bold={i === tab}>
              {` ${i + 1} ${t} `}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {error ? (
          <Text color="red">Hiba: {error}</Text>
        ) : !ctx ? (
          <Text dimColor>Betöltés…</Text>
        ) : tab === 0 ? (
          <Overview ctx={ctx} hide={hide} />
        ) : tab === 1 ? (
          <Positions ctx={ctx} hide={hide} offset={offset} rows={listRows} />
        ) : tab === 2 ? (
          <Todos ctx={ctx} hide={hide} />
        ) : tab === 3 ? (
          <Goals ctx={ctx} hide={hide} />
        ) : tab === 4 ? (
          <Chart ctx={ctx} hide={hide} range={range} width={Math.max(20, termCols - 4)} />
        ) : (
          <Report text={REPORTS[tab](ctx)} hide={hide} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Tab/←→/1–9: fül · p: összegek {hide ? "mutatása" : "elrejtése"} · r: újratöltés
          {tab === 4 ? " · t: időszak" : ""} · q: kilépés
        </Text>
      </Box>
    </Box>
  );
}
