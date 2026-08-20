import type { DiagnosticValuationPoint, ExitResult, RetrievedSpread } from "./backtester";
import type { EstimatedOutcome, EstimatedPathPoint } from "./research-valuation";

export type ChartMetric = "pnl" | "values";
export type ResearchChartMetric = "pnl-usd" | "pnl-btc" | "contract-values" | "btc-index";
export type PresentationMetric = ChartMetric | ResearchChartMetric;

export interface PresentationPoint {
  timestamp: number;
  values: Record<string, number | undefined>;
  source: unknown;
}

export interface PresentationSeries { key:string; label:string; metric:PresentationMetric; color:string }

/** Research USD inspection is intentionally strict: a priced point owns its conversion index. */
export function researchPnlUsd(point: EstimatedPathPoint) {
  if (point.status !== "priced" || point.estimatedNetPnlBtc === undefined) return undefined;
  if (point.targetIndex === undefined || !Number.isFinite(point.targetIndex) || point.targetIndex <= 0) throw new Error("Priced Research point is missing a valid targetIndex.");
  return point.estimatedNetPnlBtc * point.targetIndex;
}

/** Stored spread value is closing cash flow (long proceeds minus short cost); presentation shows positive economic closing cost. */
export function researchNetClosingCostBtc(point: EstimatedPathPoint) {
  if (point.shortModelPriceBtc !== undefined && point.longModelPriceBtc !== undefined) return point.shortModelPriceBtc - point.longModelPriceBtc;
  return point.closingSpreadValueBtcPerContract === undefined ? undefined : -point.closingSpreadValueBtcPerContract;
}

export const RESEARCH_CHART_SERIES: PresentationSeries[] = [
  {key:"researchPnlUsd",label:"Model-reconstructed estimate",metric:"pnl-usd",color:"#2a78d6"},
  {key:"researchPnlBtc",label:"Model-reconstructed estimate",metric:"pnl-btc",color:"#2a78d6"},
  {key:"netClosingCostBtc",label:"Net spread closing cost / contract",metric:"contract-values",color:"#3987e5"},
  {key:"shortTheoreticalBtc",label:"Short theoretical option price",metric:"contract-values",color:"#c58a00"},
  {key:"longTheoreticalBtc",label:"Long theoretical option price",metric:"contract-values",color:"#e66767"},
  {key:"targetIndex",label:"BTC index",metric:"btc-index",color:"#26a269"},
];

export function adaptResearchPath(path: EstimatedPathPoint[]): PresentationPoint[] {
  return path.map(point => ({timestamp:point.timestamp, source:point, values:{
    researchPnlUsd:researchPnlUsd(point), researchPnlBtc:point.estimatedNetPnlBtc,
    netClosingCostBtc:researchNetClosingCostBtc(point), shortTheoreticalBtc:point.shortModelPriceBtc,
    longTheoreticalBtc:point.longModelPriceBtc, targetIndex:point.targetIndex,
  }}));
}

export function adaptConservativePath(path: DiagnosticValuationPoint[]): PresentationPoint[] {
  return path.map(point => ({timestamp:point.timestamp,source:point,values:Object.fromEntries(Object.keys(CHART_SERIES).map(key=>[key,point[key as ChartSeriesKey]]))}));
}

export function researchOutcomeGroups(outcomes:EstimatedOutcome[], expiry?:number, entryTimestamp?:number) {
  const groups=new Map<number,string[]>();
  const add=(timestamp:number,label:string)=>groups.set(timestamp,[...(groups.get(timestamp)??[]),label]);
  if(entryTimestamp!==undefined&&(expiry===undefined||entryTimestamp<=expiry))add(entryTimestamp,"Entry");
  outcomes.filter(o=>o.status==="estimated"&&o.valuationTimestamp!==undefined&&(expiry===undefined||o.valuationTimestamp<=expiry)).forEach(o=>add(o.valuationTimestamp!,o.label));
  return [...groups].sort((a,b)=>a[0]-b[0]).map(([timestamp,labels])=>({timestamp,labels}));
}

export function rawResearchObservations(path:EstimatedPathPoint[]){return path.filter(point=>point.rawEstimate?.priceSource==="direct-vwap");}

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

export function visibleMatrixSpreads(spreads: RetrievedSpread[], hideRed: boolean, hideDataUnavailable=false) {
  return !hideRed&&!hideDataUnavailable?spreads:spreads.filter(spread=>(!hideRed||spread.entryLiquidityQuality!=="red")&&(!hideDataUnavailable||spread.dataStatus!=="data-unavailable"));
}

/** Collapse generation attempts only for economic evaluation/rendering; the caller retains the original array for availability provenance. */
export function uniqueCanonicalSpreads(spreads:RetrievedSpread[]):RetrievedSpread[]{
 const byId=new Map<string,RetrievedSpread>();
 for(const spread of spreads)if(!byId.has(spread.id))byId.set(spread.id,spread);
 return [...byId.values()];
}

export interface ResearchPathStatistics {status:"available"|"unavailable";reason:string|null;pricedPoints:number;worstObservedPnlUsd:number|null;maeBeforeProfitUsd:number|null}
/** Evidence inclusion is mechanical: valid, point-index-convertible marks from an entry-inclusive path; no outcome-based trimming. */
export function researchPathStatistics(path:EstimatedPathPoint[],entryTimestamp:number):ResearchPathStatistics{
 const entry=path.find(p=>p.timestamp===entryTimestamp);
 if(!entry||entry.status!=="priced")return{status:"unavailable",reason:"The valuation path has no priced entry observation; adverse statistics cannot be entry-inclusive.",pricedPoints:0,worstObservedPnlUsd:null,maeBeforeProfitUsd:null};
 const marks=path.filter(p=>p.timestamp>=entryTimestamp&&p.status==="priced").map(p=>({t:p.timestamp,pnl:researchPnlUsd(p)!})).filter(p=>Number.isFinite(p.pnl)).sort((a,b)=>a.t-b.t);
 if(!marks.length)return{status:"unavailable",reason:"No valid point-level index-convertible marks exist at or after entry.",pricedPoints:0,worstObservedPnlUsd:null,maeBeforeProfitUsd:null};
 const firstProfit=marks.find(m=>m.pnl>0),mae=firstProfit?Math.min(...marks.filter(m=>m.t<=firstProfit.t).map(m=>m.pnl)):null;
 return{status:"available",reason:null,pricedPoints:marks.length,worstObservedPnlUsd:Math.min(...marks.map(m=>m.pnl)),maeBeforeProfitUsd:mae};
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
