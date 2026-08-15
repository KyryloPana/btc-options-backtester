import type { ExitResult, RetrievedSpread } from "./backtester";

export type ChartMetric = "pnl" | "values";

export function valuationChartTitle(metric: ChartMetric) {
  return metric === "pnl"
    ? "Estimated 4H valuation path · PnL · USD"
    : "Estimated 4H valuation path · Contract values · BTC/contract";
}
export type ChartSeriesKey = "diagnosticRawUnrealizedPnlUsd" | "diagnosticIvUnrealizedPnlUsd" | "rawSoldLegPrice" | "rawBoughtLegPrice" | "rawSpreadValue" | "ivSoldLegPrice" | "ivBoughtLegPrice" | "ivSpreadValue";

export const CHART_SERIES: Record<ChartSeriesKey, { label: string; metric: ChartMetric }> = {
  diagnosticRawUnrealizedPnlUsd: { label: "Raw diagnostic unrealized · USD", metric: "pnl" },
  diagnosticIvUnrealizedPnlUsd: { label: "IV diagnostic unrealized · USD", metric: "pnl" },
  rawSoldLegPrice: { label: "Sold-leg Raw price", metric: "values" },
  rawBoughtLegPrice: { label: "Bought-leg Raw price", metric: "values" },
  rawSpreadValue: { label: "Raw net spread value", metric: "values" },
  ivSoldLegPrice: { label: "Sold-leg IV-normalized price", metric: "values" },
  ivBoughtLegPrice: { label: "Bought-leg IV-normalized price", metric: "values" },
  ivSpreadValue: { label: "IV-normalized net spread value", metric: "values" },
};

// Plot bounds leave room inside the viewBox for both Y-axis values and the
// centered first/last timestamp labels. The SVG then scales with its panel.
export const CHART_GEOMETRY = { width: 960, height: 280, plotLeft: 76, plotRight: 910, plotTop: 22, plotBottom: 224 } as const;

export function timeX(timestamp: number, start: number, end: number, left: number, right: number) {
  return end === start ? left : left + ((timestamp - start) / (end - start)) * (right - left);
}

export function timestampAtX(x: number, start: number, end: number, left: number, right: number) {
  return start + Math.max(0, Math.min(1, (x - left) / (right - left))) * (end - start);
}

export function visibleMatrixSpreads(spreads: RetrievedSpread[], hideRed: boolean) {
  return hideRed ? spreads.filter(spread => spread.entryLiquidityQuality !== "red") : spreads;
}

export function nearestPoint<T extends { timestamp: number }>(points: T[], timestamp: number) {
  return points.reduce((nearest, point) => Math.abs(point.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp) ? point : nearest, points[0]);
}

/** Preserve the source grid: an absent value terminates, rather than bridges, a line. */
export function splitSeriesAtMissing<T extends { timestamp: number }>(points: T[], key: keyof T) {
  const segments: T[][] = [];
  let segment: T[] = [];
  for (const point of points) {
    if (typeof point[key] === "number") segment.push(point);
    else if (segment.length) { segments.push(segment); segment = []; }
  }
  if (segment.length) segments.push(segment);
  return segments;
}

export function hitExitGroups(exits: ExitResult[]) {
  const groups = new Map<number, string[]>();
  exits.filter(exit => exit.status === "hit" && exit.timestamp !== undefined).forEach(exit => groups.set(exit.timestamp!, [...(groups.get(exit.timestamp!) ?? []), exit.rule]));
  return [...groups].map(([timestamp, labels]) => ({ timestamp, labels }));
}
