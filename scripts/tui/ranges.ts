// Time ranges of the chart tab (days back from today; 0 = everything).
export const CHART_RANGES = [
  { label: "1 hónap", days: 30 },
  { label: "3 hónap", days: 91 },
  { label: "1 év", days: 365 },
  { label: "Mind", days: 0 },
] as const;
