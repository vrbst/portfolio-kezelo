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

const tooltipStyle = {
  background: '#141a2e',
  border: '1px solid #232b45',
  borderRadius: 12,
  color: '#e8ecf8',
} as const

function formatMonth(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('hu-HU', {
    year: '2-digit',
    month: 'short',
  }).format(d)
}

/** Portfolio value over time, with the invested-capital line for reference. */
export default function ValueChart({ data }: { data: ValuePoint[] }) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
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
            dataKey="date"
            tickFormatter={formatMonth}
            tick={{ fill: '#8b93a7', fontSize: 12 }}
            stroke="#232b45"
            minTickGap={32}
          />
          <YAxis
            tickFormatter={formatCompact}
            tick={{ fill: '#8b93a7', fontSize: 12 }}
            stroke="#232b45"
            width={52}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(l) => formatMonth(String(l))}
            formatter={(v, name) => [
              formatMoney(Number(v)),
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
