import { useMemo } from "react";
import { PieChart } from "lucide-react";
import { usePortfolioSummary } from "../lib/store";
import { consolidatedHoldings } from "../lib/holdings";
import { sectorExposure, sectorLabel } from "../lib/fundamentals";
import { useFundamentalsFile } from "../lib/fundamentalsStore";
import { formatNumber } from "../lib/format";
import { Card } from "./ui";
import InfoTip from "./InfoTip";
import { WeightBars } from "./holdings/FundamentalsSection";

export default function SectorExposureCard() {
  const summary = usePortfolioSummary();
  const file = useFundamentalsFile();
  const exposure = useMemo(
    () =>
      sectorExposure(
        consolidatedHoldings(summary).map((h) => ({ key: h.instrumentKey, valueHuf: h.marketValueHuf })),
        file,
      ),
    [summary, file],
  );
  if (!file || exposure.coveredHuf <= 0 || !exposure.sectors.length) return null;
  const share = summary.totalValueHuf > 0 ? exposure.coveredHuf / summary.totalValueHuf : 0;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <PieChart className="h-5 w-5 text-[var(--color-brand)]" />
        <h2 className="text-lg font-semibold">Szektor-kitettség</h2>
        <InfoTip>
          Az ETF-eken átnézve: minden alapot a saját szektor-súlyai szerint, minden
          részvényt a saját szektorában számol, a pozíciók értékével súlyozva. Az
          állampapír, a készpénz és az adat nélküli papír (pl. kripto-ETP) kimarad.
          Forrás: Yahoo Finance, a bot naponta frissíti.
        </InfoTip>
      </div>
      <div data-privacy="public">
        <WeightBars items={exposure.sectors} label={sectorLabel} limit={8} />
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          A portfólió {formatNumber(share * 100, 0)}%-a alapján.
        </p>
      </div>
    </Card>
  );
}
