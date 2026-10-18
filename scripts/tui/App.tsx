// Terminal view of the portfolio (Ink): the same Context the Telegram bot
// builds (scripts/notify/data.ts), rendered read-only.

import { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { loadEnv, newsGithubToken } from "../notify/env";
import { latestDigest, repoStore } from "../notify/news/job";
import type { NewsDigest } from "../../src/lib/newsSchema";
import { loadContext, type Context } from "../notify/data";
import { consolidatedHoldings } from "../../src/lib/portfolio";
import { CHART_RANGES } from "./ranges";
import { ALLOC_MODES, CHART_IDS, FORECAST_YEARS } from "./charts";
import { ChartsView } from "./ChartsView";
import {
  forecastText,
  glideText,
  liquidationText,
  planText,
  newsText,
  returnsText,
  tbszText,
} from "../notify/reports";
import { Goals, Overview, Positions, Report, Todos } from "./views";

const TABS = ["Állás", "Pozíciók", "Teendők", "Célok", "Grafikon", "Hozam", "Előrejelzés", "TBSZ", "Terv", "Pálya", "Eladás", "Hírek"] as const;

// Tabs 6+ show the Telegram bot report of the same name as plain text.
const REPORTS: Record<number, (ctx: Context) => string> = {
  5: returnsText,
  6: forecastText,
  7: tbszText,
  8: planText,
  9: glideText,
  10: liquidationText,
};
const NEWS_TAB = 11;

/** The latest news digest, or why there is none (the other tabs do not depend on it). */
type News = { digest: NewsDigest | null; appUrl: string; error?: string };

export function App() {
  const { exit } = useApp();
  const [ctx, setCtx] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [news, setNews] = useState<News | null>(null);
  const [hide, setHide] = useState(true);
  const [run, setRun] = useState(0);
  const [tab, setTab] = useState(0);
  const [offset, setOffset] = useState(0);
  const [chart, setChart] = useState(0);
  const [range, setRange] = useState(1);
  const [forecastRange, setForecastRange] = useState(3);
  const [mode, setMode] = useState(0);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    let live = true;
    const env = loadEnv();
    loadContext(env)
      .then((c) => live && setCtx(c))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    latestDigest(repoStore(env.syncRepo, newsGithubToken))
      .then((digest) => live && setNews({ digest, appUrl: env.appUrl }))
      .catch((e: unknown) =>
        live &&
        setNews({ digest: null, appUrl: env.appUrl, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [run]);

  const reload = useCallback(() => {
    setError(null);
    setCtx(null);
    setNews(null);
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
    else if (tab === 4 && input === "c") setChart((x) => (x + 1) % CHART_IDS.length);
    else if (tab === 4 && input === "C") setChart((x) => (x + CHART_IDS.length - 1) % CHART_IDS.length);
    else if (tab === 4 && input === "t") {
      if (CHART_IDS[chart] === "forecast") setForecastRange((x) => (x + 1) % FORECAST_YEARS.length);
      else setRange((x) => (x + 1) % CHART_RANGES.length);
    } else if (tab === 4 && input === "m") setMode((x) => (x + 1) % ALLOC_MODES.length);
    else if (tab === 4 && key.downArrow) setPick((x) => x + 1);
    else if (tab === 4 && key.upArrow) setPick((x) => x - 1);
  });

  return (
    <Box flexDirection="column" paddingX={1} height={Math.max(5, termRows - 1)}>
      <Box flexWrap="wrap">
        {TABS.map((t, i) => (
          <Box key={t} marginRight={1}>
            <Text inverse={i === tab} bold={i === tab}>
              {` ${i + 1} ${t} `}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column" flexGrow={1}>
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
          <ChartsView
            ctx={ctx}
            chart={CHART_IDS[chart]}
            options={{
              range: CHART_IDS[chart] === "forecast" ? forecastRange : range,
              mode,
              pick,
              hide,
            }}
            columns={Math.max(30, termCols - 4)}
            height={Math.max(6, termRows - 17)}
          />
        ) : tab === NEWS_TAB ? (
          !news ? (
            <Text dimColor>Hírek betöltése…</Text>
          ) : news.error ? (
            <Text color="red">A hírek nem olvashatók: {news.error}</Text>
          ) : news.digest ? (
            <Report text={newsText(news.digest, ctx, news.appUrl)} hide={hide} />
          ) : (
            <Text dimColor>Még nincs hírösszefoglaló.</Text>
          )
        ) : (
          <Report text={REPORTS[tab](ctx)} hide={hide} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Tab/←→/1–9: fül · p: összegek {hide ? "mutatása" : "elrejtése"} · r: újratöltés
          {tab === 4 ? " · c: grafikon" : ""} · q: kilépés
        </Text>
      </Box>
    </Box>
  );
}
