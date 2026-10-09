export interface ReturnParts {
  total: number;
  totalPct?: number;
  currency: string;
  ccyReturn?: number;
  ccyPct?: number;
  fxEffect?: number;
  fxPct?: number;
}

export function returnParts(
  h: {
    currency: string;
    unrealizedPlHuf?: number;
    costBasisHuf: number;
    costBasisCcy: number;
    marketValueCcy?: number;
  },
  fx: Record<string, number>,
): ReturnParts | null {
  const total = h.unrealizedPlHuf;
  if (total == null || Math.abs(total) <= 0.5) return null;
  const totalPct = h.costBasisHuf > 0 ? total / h.costBasisHuf : undefined;
  const isFx = h.currency !== "HUF" && h.marketValueCcy != null;
  if (!isFx) return { total, totalPct, currency: h.currency };
  const ccyReturn = h.marketValueCcy! - h.costBasisCcy;
  const rateNow = fx[h.currency] ?? 0;
  const fxEffect = rateNow > 0 ? h.costBasisCcy * rateNow - h.costBasisHuf : undefined;
  return {
    total,
    totalPct,
    currency: h.currency,
    ccyReturn,
    ccyPct: h.costBasisCcy > 0 ? ccyReturn / h.costBasisCcy : undefined,
    fxEffect,
    fxPct: fxEffect != null && h.costBasisHuf > 0 ? fxEffect / h.costBasisHuf : undefined,
  };
}
