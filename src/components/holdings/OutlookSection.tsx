import type { ReactNode } from "react";
import { formatDate, formatNumber, formatPercent } from "../../lib/format";
import { isStaleView, type Consensus, type ImpliedBand, type Outlook, type OutlookProfile } from "../../lib/outlook";
import type { FetchError } from "../../lib/fundamentals";
import {
  ASSET_CLASS_LABEL,
  PROFILE_SOURCE_LABEL,
  bandChanges,
  horizonMonths,
  rangeScale,
  upside,
  viewText,
} from "../../lib/outlookView";

const tone = (v: number) => (v >= 0 ? "text-[var(--color-positive)]" : "text-[var(--color-negative)]");

function SubTitle({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-xs font-medium text-[var(--color-muted)]">{children}</div>;
}

function ConsensusBlock({ c, price, currency }: { c: Consensus; price?: number; currency: string }) {
  const same = c.currency.toUpperCase() === currency.toUpperCase();
  const scale = rangeScale(c.target, price, same);
  const up = upside(c.target, price, c.currency, currency);
  const fmt = (v: number) => formatNumber(v, c.currency === "HUF" ? 0 : 2);
  const label = c.source === "issuer" ? "Kibocsátói elemzői konszenzus" : "Elemzői célár (Yahoo)";
  return (
    <div>
      <SubTitle>
        {label}
        {c.target.count ? `, ${c.target.count} elemző` : ""}
      </SubTitle>
      <div className="flex justify-between text-xs text-[var(--color-muted)]">
        <span>
          min {fmt(c.target.min)} {c.currency}
        </span>
        <span>
          max {fmt(c.target.max)} {c.currency}
        </span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-[var(--color-surface-2)]">
        <span
          className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-[var(--color-brand)]"
          style={{ left: `${scale.avg * 100}%` }}
          title={`átlag ${fmt(c.target.avg)} ${c.currency}`}
        />
        {scale.price != null && (
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--color-surface)] bg-[var(--color-muted)]"
            style={{ left: `${scale.price * 100}%` }}
            title="mai árfolyam"
          />
        )}
      </div>
      <div className="mt-2 text-sm">
        átlag <span className="font-medium tabular-nums">{fmt(c.target.avg)} {c.currency}</span>
        {up != null && <span className={`ml-1.5 text-xs ${tone(up)}`}>{formatPercent(up, 1)} a mai árhoz képest</span>}
      </div>
      {c.recent && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          a legfrissebb {c.recent.count ? `${c.recent.count} becslés` : "becslések"} átlaga: {fmt(c.recent.avg)} {c.currency}
        </div>
      )}
      {c.ratings && (
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          Vétel {c.ratings.buy} · Tartás {c.ratings.hold} · Eladás {c.ratings.sell}
        </div>
      )}
      {c.estimates && c.estimates.length > 0 && (
        <table className="mt-2 w-full text-xs tabular-nums">
          <thead className="text-[var(--color-muted)]">
            <tr>
              <th className="text-left font-normal">Év</th>
              <th className="text-right font-normal">EPS</th>
              <th className="text-right font-normal">Osztalék</th>
            </tr>
          </thead>
          <tbody>
            {c.estimates.map((e) => (
              <tr key={e.year}>
                <td>{e.year}</td>
                <td className="text-right">{e.eps != null ? fmt(e.eps) : "—"}</td>
                <td className="text-right">{e.dps != null ? fmt(e.dps) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {c.url ? (
          <a className="underline" href={c.url} target="_blank" rel="noopener noreferrer">
            forrás
          </a>
        ) : (
          "forrás: Yahoo Finance"
        )}
        , {formatDate(c.asOf)}
      </p>
    </div>
  );
}

function BandsBlock({ bands }: { bands: ImpliedBand[] }) {
  const u = bands[0].underlying;
  return (
    <div>
      <SubTitle>Az opciós piac várakozása ({u}-opciók, Deribit)</SubTitle>
      <table className="w-full text-xs tabular-nums">
        <thead className="text-[var(--color-muted)]">
          <tr>
            <th className="text-left font-normal">Táv</th>
            <th className="text-right font-normal">Alsó 10%</th>
            <th className="text-right font-normal">Medián</th>
            <th className="text-right font-normal">Felső 10%</th>
            <th className="text-right font-normal">Emelkedés</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b) => {
            const c = bandChanges(b);
            return (
              <tr key={b.expiry} title={`${u} ${formatNumber(b.p10, 0)}–${formatNumber(b.p90, 0)} USD, lejárat ${formatDate(b.expiry)}`}>
                <td>~{horizonMonths(b.horizonDays)} hó</td>
                <td className={`text-right ${tone(c.p10)}`}>{formatPercent(c.p10, 0)}</td>
                <td className={`text-right ${tone(c.p50)}`}>{formatPercent(c.p50, 0)}</td>
                <td className={`text-right ${tone(c.p90)}`}>{formatPercent(c.p90, 0)}</td>
                <td className="text-right">{formatNumber(b.probUp * 100, 0)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Nem vélemény: a piac által beárazott sáv a mögöttes érme dollár-árfolyamára, {formatDate(bands[0].asOf)}.
      </p>
    </div>
  );
}

export default function OutlookSection({
  profile,
  outlook,
  error,
  price,
  currency,
  now = new Date(),
}: {
  profile?: OutlookProfile;
  outlook?: Outlook;
  error?: FetchError;
  price?: number;
  currency: string;
  now?: Date;
}) {
  if (!outlook) return null;
  const { consensus, implied, views } = outlook;
  if (!consensus?.length && !implied?.length && !views?.length) return null;
  return (
    <section className="border-t border-[var(--color-border)] px-5 py-4" data-privacy="public">
      <h3 className="mb-3 text-sm font-semibold">Kilátások</h3>
      <div className="space-y-4">
        {consensus?.map((c) => (
          <ConsensusBlock key={`${c.source}-${c.asOf}`} c={c} price={price} currency={currency} />
        ))}
        {implied && implied.length > 0 && <BandsBlock bands={implied} />}
        {views && views.length > 0 && (
          <div>
            <SubTitle>Nevesített előrejelzések</SubTitle>
            <ul className="space-y-1.5 text-xs">
              {views.map((v) => (
                <li
                  key={`${v.house}-${v.kind}-${v.horizon ?? ""}`}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 ${isStaleView(v, now) ? "opacity-60" : ""}`}
                >
                  <span className="min-w-0 truncate">
                    {v.house}
                    {v.horizon ? `, ${v.horizon}` : ""}
                    {v.note ? <span className="text-[var(--color-muted)]"> · {v.note}</span> : null}
                  </span>
                  <span className="text-right tabular-nums">
                    <span className="font-medium">{viewText(v)}</span>{" "}
                    <a className="text-[var(--color-muted)] underline" href={v.url} target="_blank" rel="noopener noreferrer">
                      {formatDate(v.publishedAt)}
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        {profile ? `Besorolás: ${ASSET_CLASS_LABEL[profile.assetClass]}${profile.underlying ? ` (${profile.underlying})` : ""}, ${PROFILE_SOURCE_LABEL[profile.source]}. ` : ""}
        Nem befektetési tanács: az elemzői célárak gyakran tévednek.
        {error && (
          <span className="text-[var(--color-warning)]">
            {" "}
            — a frissítés {formatDate(error.since)} óta nem sikerül, ez a legutóbbi sikeres adat
          </span>
        )}
      </p>
    </section>
  );
}
