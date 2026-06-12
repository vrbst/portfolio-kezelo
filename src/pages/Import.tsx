import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { UploadCloud, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { parseFiles, type ParsedImport } from '../lib/parsers'
import { usePortfolio } from '../lib/store'
import { PageHeader, Card, Badge } from '../components/ui'
import { formatDate } from '../lib/format'

export default function Import() {
  const navigate = useNavigate()
  const importParsed = usePortfolio((s) => s.importParsed)
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [preview, setPreview] = useState<ParsedImport | null>(null)
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(
    null,
  )

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setParsing(true)
    setDone(null)
    try {
      const parsed = await parseFiles(Array.from(fileList))
      setPreview(parsed)
    } finally {
      setParsing(false)
    }
  }

  async function confirmImport() {
    if (!preview) return
    const res = await importParsed(preview)
    setDone(res)
    setPreview(null)
  }

  return (
    <div>
      <PageHeader
        title="Importálás"
        subtitle="Húzd ide a Lightyear (.csv) és Magyar Államkincstár (.xls) kivonataidat."
      />

      <motion.div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        animate={{ scale: dragging ? 1.01 : 1 }}
        className={`card flex cursor-pointer flex-col items-center justify-center gap-3 border-2 border-dashed px-6 py-16 text-center transition-colors ${
          dragging
            ? 'border-[var(--color-brand)] bg-[var(--color-brand)]/5'
            : 'border-[var(--color-border)]'
        }`}
      >
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-[var(--color-brand)]/20 to-[var(--color-brand-2)]/20">
          <UploadCloud className="h-7 w-7 text-[var(--color-brand)]" />
        </div>
        <div className="text-lg font-medium">
          {parsing ? 'Feldolgozás…' : 'Húzd ide a fájlokat, vagy kattints a tallózáshoz'}
        </div>
        <div className="text-sm text-[var(--color-muted)]">
          Támogatott: Lightyear CSV, Magyar Államkincstár XLS/XLSX
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.xls,.xlsx"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </motion.div>

      {done && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-6"
        >
          <Card className="flex items-center gap-3 p-5">
            <CheckCircle2 className="h-6 w-6 text-[var(--color-positive)]" />
            <div className="flex-1">
              <div className="font-medium">Sikeres importálás</div>
              <div className="text-sm text-[var(--color-muted)]">
                {done.added} új tranzakció hozzáadva
                {done.skipped > 0 && `, ${done.skipped} már létezett (kihagyva)`}.
              </div>
            </div>
            <button className="btn-primary" onClick={() => navigate('/')}>
              Áttekintés megnyitása
            </button>
          </Card>
        </motion.div>
      )}

      {preview && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-6 space-y-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Előnézet</h2>
            <Badge tone="brand">{preview.accounts.length} számla</Badge>
            <Badge tone="brand">{preview.transactions.length} tranzakció</Badge>
            <Badge tone="brand">{preview.instruments.length} értékpapír</Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {preview.accounts.map((a) => {
              const count = preview.transactions.filter(
                (t) => t.accountId === a.id,
              ).length
              return (
                <Card key={a.id} className="flex items-center gap-3 p-4">
                  <FileSpreadsheet className="h-5 w-5 text-[var(--color-brand)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{a.name}</div>
                    <div className="text-xs text-[var(--color-muted)]">
                      {count} tranzakció · {a.provider}
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>

          {preview.warnings.length > 0 && (
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2 text-[var(--color-warning)]">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm font-medium">
                  {preview.warnings.length} figyelmeztetés
                </span>
              </div>
              <ul className="max-h-32 space-y-1 overflow-auto text-xs text-[var(--color-muted)]">
                {preview.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="overflow-hidden">
            <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-medium">
              Első tranzakciók
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-[var(--color-muted)]">
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="px-4 py-2 font-medium">Dátum</th>
                    <th className="px-4 py-2 font-medium">Típus</th>
                    <th className="px-4 py-2 font-medium">Eszköz</th>
                    <th className="px-4 py-2 text-right font-medium">Összeg</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.transactions.slice(0, 10).map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-[var(--color-border)]/50 last:border-0"
                    >
                      <td className="px-4 py-2">{formatDate(t.date)}</td>
                      <td className="px-4 py-2">{t.type}</td>
                      <td className="px-4 py-2 text-[var(--color-muted)]">
                        {t.instrumentKey ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {t.grossAmount?.toLocaleString('hu-HU') ?? '—'}{' '}
                        {t.currency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex justify-end gap-3">
            <button className="btn-ghost" onClick={() => setPreview(null)}>
              Mégse
            </button>
            <button className="btn-primary" onClick={confirmImport}>
              Importálás megerősítése
            </button>
          </div>
        </motion.div>
      )}
    </div>
  )
}
