import type { ExitResult, RetrievedSpread, ValuationPoint } from "./backtester";

export type ChartMetric = "pnl" | "values";
export type ChartSeriesKey = "rawPnlUsd" | "ivPnlUsd" | "rawSoldLegPrice" | "rawBoughtLegPrice" | "rawSpreadValue" | "ivSoldLegPrice" | "ivBoughtLegPrice" | "ivSpreadValue";

export const CHART_SERIES: Record<ChartSeriesKey, { label: string; metric: ChartMetric }> = {
  rawPnlUsd: { label: "Raw unrealized PnL · USD", metric: "pnl" },
  ivPnlUsd: { label: "IV-normalized unrealized PnL · USD", metric: "pnl" },
  rawSoldLegPrice: { label: "Sold-leg Raw price", metric: "values" },
  rawBoughtLegPrice: { label: "Bought-leg Raw price", metric: "values" },
  rawSpreadValue: { label: "Raw net spread value", metric: "values" },
  ivSoldLegPrice: { label: "Sold-leg IV-normalized price", metric: "values" },
  ivBoughtLegPrice: { label: "Bought-leg IV-normalized price", metric: "values" },
  ivSpreadValue: { label: "IV-normalized net spread value", metric: "values" },
};

export const CHART_GEOMETRY = { width: 960, height: 280, plotLeft: 68, plotRight: 946, plotTop: 18, plotBottom: 224 } as const;

export function timeX(timestamp: number, start: number, end: number, left: number, right: number) {
  return end === start ? left : left + ((timestamp - start) / (end - start)) * (right - left);
}

export function timestampAtX(x: number, start: number, end: number, left: number, right: number) {
  return start + Math.max(0, Math.min(1, (x - left) / (right - left))) * (end - start);
}

export function visibleMatrixSpreads(spreads: RetrievedSpread[], hideRed: boolean) {
  return hideRed ? spreads.filter(spread => spread.entryLiquidityQuality !== "red") : spreads;
}

export function nearestPoint(points: ValuationPoint[], timestamp: number) {
  return points.reduce((nearest, point) => Math.abs(point.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp) ? point : nearest, points[0]);
}

export function hitExitGroups(exits: ExitResult[]) {
  const groups = new Map<number, string[]>();
  exits.filter(exit => exit.status === "hit" && exit.timestamp !== undefined).forEach(exit => groups.set(exit.timestamp!, [...(groups.get(exit.timestamp!) ?? []), exit.rule]));
  return [...groups].map(([timestamp, labels]) => ({ timestamp, labels }));
}
