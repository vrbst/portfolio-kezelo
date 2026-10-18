// Draws a ChartData (charts.ts) with Ink: braille lines, bars, legend, captions.

import { useMemo } from "react";
import { Box, Text } from "ink";
import type { Context } from "../notify/data";
import { horizontalBars, linePlot, verticalBarsScaled } from "./plot";
import {
  CHART_CONTROLS,
  CHART_IDS,
  CHART_TITLES,
  buildChart,
  type ChartData,
  type ChartId,
  type ChartOptions,
} from "./charts";

/** First and last label at the two ends of a `width` wide plot. */
const xAxis = (first: string, last: string, width: number) =>
  first + " ".repeat(Math.max(1, width - first.length - last.length)) + last;

function Legend({ data }: { data: Extract<ChartData, { kind: "line" }> }) {
  return (
    <Text>
      {data.legend.map((l, i) => (
        <Text key={l.name}>
          {i ? "  " : ""}
          <Text color={l.color}>━</Text> {l.name}
        </Text>
      ))}
    </Text>
  );
}

function Body({
  data,
  columns,
  height,
}: {
  data: ChartData;
  columns: number;
  height: number;
}) {
  if (data.kind === "empty") return <Text dimColor>{data.message}</Text>;

  if (data.kind === "line") {
    const probe = linePlot(data.series, 4, 4, data.domain);
    const labels = [probe.max, (probe.max + probe.min) / 2, probe.min].map(data.yLabel);
    const gutter = Math.max(...labels.map((l) => l.length)) + 1;
    const width = Math.max(10, columns - gutter - 2);
    const plot = linePlot(data.series, width, height, data.domain);
    const labelRows = new Map<number, string>([
      [0, data.yLabel(plot.max)],
      [Math.floor((height - 1) / 2), data.yLabel((plot.max + plot.min) / 2)],
      [height - 1, data.yLabel(plot.min)],
    ]);
    return (
      <Box flexDirection="column">
        <Legend data={data} />
        <Box flexDirection="column">
          {plot.rows.map((row, i) => (
            <Text key={i}>
              <Text dimColor>{(labelRows.get(i) ?? "").padStart(gutter - 1)} │</Text>
              {row.map((run, j) => (
                <Text key={j} color={run.color}>
                  {run.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Text dimColor>
          {" ".repeat(gutter + 1)}
          {xAxis(data.xFirst, data.xLast, width)}
        </Text>
      </Box>
    );
  }

  if (data.kind === "vbars") {
    const { rows, ticks } = verticalBarsScaled(data.bars, height);
    const labelRows = new Map(ticks.map((t) => [t.row, t.value === 0 ? "0" : data.yLabel(t.value)]));
    const gutter = Math.max(1, ...[...labelRows.values()].map((l) => l.length)) + 1;
    const width = data.bars.length * 2;
    return (
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <Text key={i}>
            <Text dimColor>{(labelRows.get(i) ?? "").padStart(gutter - 1)} │</Text>
            {row.map((run, j) => (
              <Text key={j} color={run.color}>
                {run.text}
              </Text>
            ))}
          </Text>
        ))}
        <Text dimColor>
          {" ".repeat(gutter + 1)}
          {xAxis(data.xFirst, data.xLast, width)}
        </Text>
      </Box>
    );
  }

  const noteW = Math.max(0, ...data.items.map((i) => (i.note ?? "").length));
  const labelW = Math.max(0, ...data.items.map((i) => [...i.label].length));
  const bars = horizontalBars(data.items, Math.max(8, columns - labelW - noteW - 4));
  return (
    <Box flexDirection="column">
      {bars.map((b, i) => (
        <Text key={i}>
          {b.label} <Text color={b.bar.color}>{b.bar.text}</Text> <Text dimColor>{b.note}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** The chart picker line: every chart's name, the open one highlighted. */
export function ChartMenu({ chart }: { chart: ChartId }) {
  return (
    <Box flexWrap="wrap">
      {CHART_IDS.map((id) => (
        <Box key={id} marginRight={1}>
          <Text inverse={id === chart} bold={id === chart} dimColor={id !== chart}>
            {` ${CHART_TITLES[id]} `}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function ChartsView({
  ctx,
  chart,
  options,
  columns,
  height,
}: {
  ctx: Context;
  chart: ChartId;
  options: Omit<ChartOptions, "columns">;
  columns: number;
  height: number;
}) {
  const { range, mode, pick, hide } = options;
  // Some charts re-mark the whole history: build once per setting, not per redraw.
  const data = useMemo(
    () => buildChart(chart, ctx, { range, mode, pick, hide, columns: Math.max(10, columns - 2) }),
    [chart, ctx, range, mode, pick, hide, columns],
  );
  return (
    <Box flexDirection="column">
      <ChartMenu chart={chart} />
      <Box marginTop={1} flexDirection="column">
        <Text bold>{data.title}</Text>
        <Body data={data} columns={columns} height={height} />
        {data.kind !== "empty" && data.summary.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            {data.summary.map((l) => (
              <Text key={l}>{l}</Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>c/C: grafikon{CHART_CONTROLS[chart] ? ` · ${CHART_CONTROLS[chart]}` : ""}</Text>
        </Box>
      </Box>
    </Box>
  );
}
