import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import type { ValuePoint } from '../lib/portfolio'
import { formatMoney, formatCompact } from '../lib/format'
import { usePortfolio } from '../lib/store'

const MASK = '•••'

const tooltipStyle = {
  background: '#141a2e',
  border: '1px solid #232b45',
  borderRadius: 12,
  color: '#e8ecf8',
} as const

function formatMonth(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('hu-HU', {
    year: '2-digit',
    month: 'short',
  }).format(d)
}

function formatDay(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** Month-start timestamps across [min,max], thinned to at most `maxLabels`. */
function monthTicks(min: number, max: number, maxLabels = 8): number[] {
  const ticks: number[] = []
  const d = new Date(min)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  if (d.getTime() < min) d.setMonth(d.getMonth() + 1)
  while (d.getTime() <= max) {
    ticks.push(d.getTime())
    d.setMonth(d.getMonth() + 1)
  }
  const step = Math.max(1, Math.ceil(ticks.length / maxLabels))
  return ticks.filter((_, i) => i % step === 0)
}

/** Portfolio value over time, with the invested-capital line for reference. */
export default function ValueChart({ data }: { data: ValuePoint[] }) {
  // Privacy mode: SVG <text> doesn't reliably take a CSS blur filter, so we mask
  // the Y-axis amounts and the tooltip value at the formatter level instead.
  const privacy = usePortfolio((s) => s.privacy)
  // Real time axis: x is the timestamp so points are spaced by actual elapsed
  // time (not evenly per sample) and month ticks land correctly.
  const chartData = data.map((d) => ({ ...d, ts: new Date(d.date).getTime() }))
  const min = chartData[0]?.ts ?? 0
  const max = chartData[chartData.length - 1]?.ts ?? 0
  const ticks = monthTicks(min, max)
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
        >
          <defs>
            <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#232b45" vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[min, max]}
            ticks={ticks}
            tickFormatter={formatMonth}
            tick={{ fill: '#8b93a7', fontSize: 12 }}
            stroke="#232b45"
          />
          <YAxis
            tickFormatter={(v) => (privacy ? MASK : formatCompact(v))}
            tick={{ fill: '#8b93a7', fontSize: 12 }}
            stroke="#232b45"
            width={52}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(l) => formatDay(Number(l))}
            formatter={(v, name) => [
              privacy ? MASK : formatMoney(Number(v)),
              name === 'value' ? 'Érték' : 'Befektetett tőke',
            ]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#6366f1"
            strokeWidth={2}
            fill="url(#valueFill)"
            dot={false}
            name="value"
          />
          <Line
            type="monotone"
            dataKey="invested"
            stroke="#8b93a7"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            name="invested"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
