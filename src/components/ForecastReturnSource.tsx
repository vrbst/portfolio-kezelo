import type { ForecastReturnStatus } from "../lib/useEffectiveForecast";
import type { ReturnSourceMode } from "../lib/forecast";
import { formatDate, formatNumber } from "../lib/format";
import type { AssetEstimate, OutlookReturnEstimate } from "../lib/outlookReturns";
import { ASSET_CLASS_LABEL } from "../lib/outlookView";

const pct = (v: number, d = 1) => `${formatNumber(v * 100, d)}%`;

const BASIS_LABEL: Record<AssetEstimate["basis"], string> = {
  views: "hozamvárakozások",
  targets: "célárak",
  manual: "kézi érték",
};

/**
 * The "Hozam forrása" switch of the Feltételezések card: typed in by hand, or
 * derived from the Kilátások. The derived numbers are shown, never stored.
 */
export default function ForecastReturnSource({
  mode,
  status,
  estimate,
  onChange,
}: {
  mode: ReturnSourceMode;
  status: ForecastReturnStatus;
  estimate: OutlookReturnEstimate | null;
  onChange: (mode: ReturnSourceMode) => void;
}) {
  const options = [
    ["manual", "Kézi"],
    ["outlook", "Kilátások alapján"],
  ] as const;
  return (
    <div className="mt-3" data-testid="return-source">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-[var(--color-muted)]">Hozam forrása</span>
        <div role="group" aria-label="Hozam forrása" className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5 text-xs">
          {options.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => onChange(key)}
              className={`rounded-md px-2.5 py-1 transition ${
                mode === key
                  ? "bg-[var(--color-brand)]/20 text-[var(--color-text)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "manual" && estimate?.usable && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          A Kilátások szerint: {pct(estimate.scenarios.pess)} / {pct(estimate.scenarios.real)} / {pct(estimate.scenarios.opt)}
          {" "}(szórás {pct(estimate.sigma, 0)}), a tartott értékpapírok {Math.round(estimate.coveredShare * 100)}%-ára van adat.
        </p>
      )}

      {mode === "outlook" && status === "loading" && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">A Kilátások betöltése… addig a kézi értékek számítanak.</p>
      )}
      {mode === "outlook" && status === "missing" && (
        <p className="mt-2 text-xs text-[var(--color-warning)]">
          Nincs használható kilátás-adat, ezért a kézi értékek számítanak.
          {estimate?.warnings[0] ? ` ${estimate.warnings[0]}` : ""}
        </p>
      )}
      {mode === "outlook" && status === "ready" && estimate && (
        <div className="mt-2 space-y-1 text-xs text-[var(--color-muted)]">
          <p>
            Az értékpapírok értékének {Math.round(estimate.coveredShare * 100)}%-ára van adat; a többire a kézi hozam számít. A
            mezők a levezetett értékeket mutatják, a kézi értékeid megmaradnak.
          </p>
          {estimate.warnings.map((w) => (
            <p key={w} className="text-[var(--color-warning)]">
              {w}
            </p>
          ))}
          <Breakdown estimate={estimate} />
        </div>
      )}
    </div>
  );
}

function Breakdown({ estimate }: { estimate: OutlookReturnEstimate }) {
  return (
    <details className="rounded-lg border border-[var(--color-border)] px-3 py-2" data-testid="return-breakdown">
      <summary className="cursor-pointer text-[var(--color-text)]">Honnan jön?</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[22rem] text-xs tabular-nums">
          <thead className="text-[var(--color-muted)]">
            <tr>
              <th className="text-left font-normal">Eszköz</th>
              <th className="pl-3 text-right font-normal">Súly</th>
              <th className="pl-3 text-right font-normal">Pessz.</th>
              <th className="pl-3 text-right font-normal">Reális</th>
              <th className="pl-3 text-right font-normal">Opt.</th>
              <th className="pl-3 text-right font-normal">σ</th>
            </tr>
          </thead>
          <tbody>
            {estimate.assets.map((a) => (
              <tr key={a.key} className="align-top">
                <td className="py-1 pr-2">
                  <div className="font-medium text-[var(--color-text)]">{a.name}</div>
                  <div className="text-[var(--color-muted)]">
                    {ASSET_CLASS_LABEL[a.cls]} · {BASIS_LABEL[a.basis]}
                    {a.basis === "views" && Math.abs(a.fxAdjPp) >= 0.05 && (
                      <> · deviza-korr. {a.fxAdjPp > 0 ? "+" : ""}{formatNumber(a.fxAdjPp, 1)} pp</>
                    )}
                  </div>
                  {a.sources.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {a.sources.map((s, i) => (
                        <li key={`${s.label}-${i}`} className={s.stale ? "opacity-60" : undefined}>
                          {s.url ? (
                            <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                              {s.label}
                            </a>
                          ) : (
                            s.label
                          )}{" "}
                          {s.detail}
                          {s.asOf ? `, ${formatDate(s.asOf)}` : ""}
                          {s.stale ? " (régi)" : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-1 pl-3 text-right">
                  <span className="amt">{pct(a.weight, 0)}</span>
                </td>
                <td className="py-1 pl-3 text-right">{pct(a.scenarios.pess)}</td>
                <td className="py-1 pl-3 text-right">{pct(a.scenarios.real)}</td>
                <td className="py-1 pl-3 text-right">{pct(a.scenarios.opt)}</td>
                <td className="py-1 pl-3 text-right">{pct(a.sigma, 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-[var(--color-border)] text-[var(--color-text)]">
            <tr>
              <td className="pt-1 font-medium">Együtt</td>
              <td />
              <td className="pt-1 pl-3 text-right">{pct(estimate.scenarios.pess)}</td>
              <td className="pt-1 pl-3 text-right">{pct(estimate.scenarios.real)}</td>
              <td className="pt-1 pl-3 text-right">{pct(estimate.scenarios.opt)}</td>
              <td className="pt-1 pl-3 text-right">{pct(estimate.sigma, 0)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2">
        Az ETF-ek hosszú távú hozamvárakozásait átvesszük; az 1 éves célárak csak mérsékelten húzzák a kézi értéket (a hosszabb
        időtávon még kevésbé). A devizás hozamok forintra vannak igazítva az inflációs különbséggel; a rövid távú
        árfolyamingadozás nincs benne. A szórás az opciós piacból (kripto) és eszközosztályonkénti értékekből jön.
      </p>
      <p className="mt-1 text-[var(--color-warning)]">Tippek, nem befektetési tanács.</p>
    </details>
  );
}
