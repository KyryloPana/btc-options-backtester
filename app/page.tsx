"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { InfoTooltip } from "./components/info-tooltip";
import { durationSummary } from "./data";
import { canLeaveDirty, validateTradeDataset, type ConflictResolution, type ImportMode, type ImportSummary, type TradeDataset, type TradeDatasetSummary } from "./lib/trade-datasets";
import {
  type BacktestEvent,
  type Candle,
  type ContractCandidateManifest,
  type ContractSeries,
  type DteTolerance,
  type ExecutionMode,
  type ExpirySelectionMode,
  type ExitResult,
  type EntryLedgers,
  type QualityFlag,
  type RetrievedSpread,
  type SpreadKind,
  type DiagnosticValuationPoint,
  buildExpiryCandidates,
  firstTouch,
  formatUtc,
  generateDesiredSpreads,
  parseUtcDate,
  qualityRank,
  valuationTimestamps,
  windowComparison,
} from "./lib/backtester";
import { aggregateObservations, buildAndRunObservationRequests, buildObservationExport, type StrategyObservation, type StrategyVariantConfig } from "./lib/observation-ledger";
import { calculateContractSizeScenario, validateScenarioAmount, type ContractSizeScenario } from "./lib/contract-size-scenario";
import { displayedProfit, entryEvidenceExplanation, spreadIdentity } from "./lib/observation-presentation";
import { CHART_GEOMETRY, CHART_SERIES, hitExitGroups, nearestPoint, splitSeriesAtMissing, timestampAtX, timeX, valuationChartTitle, visibleMatrixSpreads, type ChartMetric, type ChartSeriesKey } from "./lib/valuation-chart";
import { MODEL_TOOLTIP, buildEstimatedPath, buildResearchExport, buildResearchOutcomes, estimateResearchSpread, formatExpiryWithFriday, scaleResearchEstimate, scaleResearchPath, type EstimatedOutcome, type EstimatedPathPoint, type PricingAssumption, type ResearchValuation } from "./lib/research-valuation";

type Section = "events" | "construction" | "contracts" | "analysis";

interface AnalysisResult {
  eventPrice: number;
  observation: StrategyObservation;
  spread: RetrievedSpread;
  path: DiagnosticValuationPoint[];
  entryLedgers?: EntryLedgers;
  exits: ExitResult[];
  selectedExit?: ExitResult;
  eventQuality: QualityFlag;
  scenarioInput: { event: BacktestEvent; candidates: RetrievedSpread[]; candles: Candle[]; config: StrategyVariantConfig };
  researchEntry: ResearchValuation;
  researchPath: EstimatedPathPoint[];
  researchOutcomes: EstimatedOutcome[];
}

const DTE_OPTIONS = [7, 14, 30];
const WIDTH_OPTIONS = [1000, 2000, 3000];
const EMPTY_EVENT: BacktestEvent = { id: "", label: "No dataset loaded", direction: "long", entryDate: "1970-01-01", entryPrice: 0 };
const DEFAULT_DTE_TOLERANCES: Record<number, DteTolerance> = {
  7: { min: 5, max: 10 },
  14: { min: 11, max: 18 },
  30: { min: 24, max: 38 },
};
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function money(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : usd.format(value);
}

function btc(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(6)} BTC`;
}

function pct(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function flagClass(flag: QualityFlag | "settlement" | "underlying-unavailable" | "ready" | "partial" | "missing") {
  if (flag === "settlement") return "flag flag-settlement";
  const normalized = flag === "ready" ? "green" : flag === "partial" ? "yellow" : flag === "missing" ? "red" : flag;
  return `flag flag-${normalized}`;
}

async function fetchCandles(start: number, end: number): Promise<Candle[]> {
  try {
    const response = await fetch(`/api/ohlc?interval=1h&start=${start}&end=${end}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "BTC candles could not be loaded.");
    return payload.candles as Candle[];
  } catch (serverError) {
    const rows: unknown[][] = [];
    let cursor = start;
    for (let page = 0; page < 10 && cursor < end; page += 1) {
      const url = new URL("https://data-api.binance.vision/api/v3/klines");
      url.searchParams.set("symbol", "BTCUSDT");
      url.searchParams.set("interval", "1h");
      url.searchParams.set("startTime", String(cursor));
      url.searchParams.set("endTime", String(end));
      url.searchParams.set("limit", "1000");
      const response = await fetch(url);
      if (!response.ok) throw serverError;
      const pageRows = await response.json() as unknown[][];
      if (!pageRows.length) break;
      rows.push(...pageRows);
      cursor = Number(pageRows[pageRows.length - 1][0]) + 3_600_000;
      if (pageRows.length < 1000) break;
    }
    return rows.map(values => ({
      openTime: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]), closeTime: Number(values[6]),
    }));
  }
}

function CheckboxGroup({ values, selected, onChange, formatter }: {
  values: number[];
  selected: number[];
  onChange: (values: number[]) => void;
  formatter: (value: number) => string;
}) {
  return (
    <div className="check-row">
      {values.map(value => (
        <label className={`check-chip ${selected.includes(value) ? "checked" : ""}`} key={value}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            onChange={() => onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value].sort((a, b) => a - b))}
          />
          {formatter(value)}
        </label>
      ))}
    </div>
  );
}

function QualityDot({ flag }: { flag: QualityFlag | "settlement" | "underlying-unavailable" }) {
  return <span className={`quality-dot ${flag}`} aria-label={`${flag} quality`} />;
}

const SERIES_COLORS: Record<ChartSeriesKey, string> = { diagnosticRawUnrealizedPnlUsd: "#898781", diagnosticIvUnrealizedPnlUsd: "#2a78d6", rawSoldLegPrice: "#fab219", rawBoughtLegPrice: "#d03b3b", rawSpreadValue: "#52514e", ivSoldLegPrice: "#c58a00", ivBoughtLegPrice: "#e66767", ivSpreadValue: "#3987e5" };

function ValuationChart({ path, exits, metric, onMetricChange }: { path: DiagnosticValuationPoint[]; exits: ExitResult[]; metric: ChartMetric; onMetricChange: (metric: ChartMetric) => void }) {
  const { width, height, plotLeft, plotRight, plotTop, plotBottom } = CHART_GEOMETRY;
  const [visible, setVisible] = useState<ChartSeriesKey[]>(["diagnosticIvUnrealizedPnlUsd"]);
  const [showExits, setShowExits] = useState(false);
  const [cursor, setCursor] = useState<number>();
  const keys = (Object.keys(CHART_SERIES) as ChartSeriesKey[]).filter(key => CHART_SERIES[key].metric === metric);
  const active = visible.filter(key => CHART_SERIES[key].metric === metric);
  const points = path.filter(point => active.some(key => point[key] !== undefined));
  const start = path[0]?.timestamp ?? 0; const end = path.at(-1)?.timestamp ?? start;
  const values = points.flatMap(point => active.map(key => point[key]).filter((value): value is number => typeof value === "number"));
  const rawMin = Math.min(0, ...values); const rawMax = Math.max(0, ...values); const padding = (rawMax - rawMin || 1) * .08;
  const min = rawMin - padding; const max = rawMax + padding;
  const y = (value: number) => plotBottom - ((value - min) / (max - min)) * (plotBottom - plotTop);
  const selected = cursor === undefined || !path.length ? undefined : nearestPoint(path, cursor);
  const ticks = Array.from({ length: 5 }, (_, index) => min + ((max - min) * index) / 4);
  const dateTicks = Array.from({ length: 5 }, (_, index) => start + ((end - start) * index) / 4);
  const x = (timestamp: number) => timeX(timestamp, start, end, plotLeft, plotRight);
  const inspect = (clientX: number, rect: DOMRect) => setCursor(timestampAtX(((clientX - rect.left) / rect.width) * width, start, end, plotLeft, plotRight));
  const changeMetric = (next: ChartMetric) => { onMetricChange(next); setVisible(next === "pnl" ? ["diagnosticIvUnrealizedPnlUsd"] : ["ivSpreadValue"]); setCursor(undefined); };
  return <>
    <div className="chart-controls"><div className="segmented" aria-label="Chart metric">{([['pnl','PnL · USD'],['values','Contract values · BTC']] as const).map(([value,label]) => <button key={value} className={metric === value ? "active" : ""} onClick={() => changeMetric(value)}>{label}</button>)}</div><label className="chart-toggle"><input type="checkbox" checked={showExits} onChange={event => setShowExits(event.target.checked)}/> Show exit markers</label></div>
    <div className="chart-legend" aria-label="Visible chart series">{keys.map(key => <label key={key}><input type="checkbox" checked={active.includes(key)} onChange={() => setVisible(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key])}/><i style={{ background: SERIES_COLORS[key] }}/>{CHART_SERIES[key].label}</label>)}</div>
    <div className="mini-chart" aria-label={`${metric === "pnl" ? "IV-normalized unrealized PnL in USD" : "Contract values in BTC"} valuation path chart`}>
      {!points.length ? <p className="empty-note">No selected series has valuation data.</p> : <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="application" tabIndex={0} aria-label="Interactive valuation chart. Use left and right arrow keys to inspect timestamps." onPointerMove={event => inspect(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); inspect(event.clientX, event.currentTarget.getBoundingClientRect()); }} onPointerLeave={() => setCursor(undefined)} onKeyDown={event => { if (!path.length || !["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return; event.preventDefault(); const index = selected ? path.indexOf(selected) : 0; const next = event.key === "Home" ? 0 : event.key === "End" ? path.length - 1 : Math.max(0, Math.min(path.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))); setCursor(path[next].timestamp); }}>
        {ticks.map(value => <g key={value}><line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)} className={Math.abs(value) < (max-min)/1000 ? "zero-line" : "grid-line"}/><text x={plotLeft-7} y={y(value)+3} textAnchor="end" className="axis-label">{metric === "pnl" ? `$${Math.round(value).toLocaleString()}` : value.toFixed(4)}</text></g>)}
        {dateTicks.map(timestamp => <g key={timestamp}><line x1={x(timestamp)} x2={x(timestamp)} y1={plotBottom} y2={plotBottom+5} className="axis-tick"/><text x={x(timestamp)} y={plotBottom+20} textAnchor="middle" className="axis-label">{new Date(timestamp).toLocaleDateString("en-GB",{timeZone:"UTC",month:"short",day:"2-digit"})}</text><text x={x(timestamp)} y={plotBottom+34} textAnchor="middle" className="axis-label">{new Date(timestamp).toLocaleTimeString("en-GB",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hour12:false})} UTC</text></g>)}
        <text x="4" y="12" className="axis-unit">{metric === "pnl" ? "USD" : "BTC / contract"}</text>
        {showExits && hitExitGroups(exits).map(group => <g key={group.timestamp} className="exit-marker"><line x1={x(group.timestamp)} x2={x(group.timestamp)} y1={plotTop} y2={plotBottom}/><text x={x(group.timestamp)+5} y={plotTop+10}>{group.labels.join(" + ")}</text></g>)}
        {active.flatMap(key => splitSeriesAtMissing(path, key).map((series, index) => <polyline key={`${key}-${index}`} data-series={key} data-segment={index} points={series.map(point => `${x(point.timestamp)},${y(point[key] as number)}`).join(" ")} className="chart-series" style={{ stroke: SERIES_COLORS[key], strokeDasharray: key.startsWith("iv") ? "5 4" : undefined }}/>) )}
        {selected && <g className="crosshair"><line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={plotTop} y2={plotBottom}/>{active.map(key => typeof selected[key] === "number" && <circle key={key} cx={x(selected.timestamp)} cy={y(selected[key] as number)} r="4" style={{fill:SERIES_COLORS[key]}}/>)}</g>}
      </svg>}
      {selected && <div className={`chart-tooltip ${x(selected.timestamp)>(plotLeft+plotRight)/2 ? "align-right" : ""}`}><strong>{formatUtc(selected.timestamp)}</strong><span>BTC index <b>{money(selected.btcIndex)}</b></span><span>Selected value <b>{active.map(key => `${CHART_SERIES[key].label}: ${metric === "pnl" ? money(selected[key]) : btc(selected[key])}`).join(" · ") || "—"}</b></span><span>Raw / IV PnL <b>{money(selected.diagnosticRawUnrealizedPnlUsd)} / {money(selected.diagnosticIvUnrealizedPnlUsd)}</b></span><span>Raw / IV spread <b>{btc(selected.rawSpreadValue)} / {btc(selected.ivSpreadValue)}</b></span><span>Sold Raw / IV <b>{btc(selected.rawSoldLegPrice)} / {btc(selected.ivSoldLegPrice)}</b></span><span>Bought Raw / IV <b>{btc(selected.rawBoughtLegPrice)} / {btc(selected.ivBoughtLegPrice)}</b></span><span>Evidence <b>{selected.qualityFlag} · {selected.valuationSource}</b></span><em>{selected.qualityReason}</em></div>}
    </div>
  </>;
}

function ResearchDetail({result,amount,onAmountChange}: {result:AnalysisResult;amount:string;onAmountChange:(value:string)=>void}) {
 const numeric=Number(amount), valid=Number.isFinite(numeric)&&numeric>0, base=result.researchEntry.status==="priced"?result.researchEntry:undefined;
 if(!base)return <div className="analysis-detail"><div className="path-card card"><p className="empty-note">{result.researchEntry.status==="unavailable"?result.researchEntry.reason:"Research estimate unavailable."}</p></div></div>;
 const entry=valid?scaleResearchEstimate(base,numeric,result.observation.strategyConfiguration.executionRoute):base;
 const path=valid?scaleResearchPath(result.researchPath,base,numeric,result.observation.strategyConfiguration.executionRoute):result.researchPath;
 const outcomes=result.researchOutcomes.map(outcome=>outcome.status==="estimated"&&outcome.estimatedNetPnl!==undefined?{...outcome,estimatedNetPnl:outcome.estimatedNetPnl/base.amount*entry.amount}:outcome);
 const points=path.filter((point):point is EstimatedPathPoint&{estimatedNetPnlBtc:number}=>point.status==="priced"&&point.estimatedNetPnlBtc!==undefined);
 const values=points.map(point=>point.estimatedNetPnlBtc*selectedIndex(point, result)); const best=values.length?Math.max(...values):undefined,worst=values.length?Math.min(...values):undefined;
 const width=720,height=220,left=62,right=690,top=18,bottom=174,start=path[0]?.timestamp??0,end=path.at(-1)?.timestamp??start;
 const min=Math.min(0,...values),max=Math.max(0,...values),range=max-min||1,x=(timestamp:number)=>left+(timestamp-start)/(end-start||1)*(right-left),y=(value:number)=>bottom-(value-min)/range*(bottom-top);
 const ticks=Array.from({length:5},(_,i)=>start+(end-start)*i/4), maxLoss=Math.max(0,(result.spread.actualWidth??result.spread.targetWidth)/result.eventPrice*entry.amount-entry.netOpeningCashFlowBtc), openingBalance=entry.bought.priceBtcPerContract*entry.amount+entry.openingFeesBtc;
 return <div className="analysis-detail"><div className="path-card card"><div className="card-title-row"><div><p className="eyebrow">Selected Research estimate · {formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</p><h3>Estimated 4H valuation path · PnL</h3></div><span className={flagClass(entry.estimateQuality)}>{entry.estimateQuality} estimate</span></div><div className="chart-legend"><label><i style={{background:"#2a78d6"}}/>Model-reconstructed estimate</label><label><i style={{background:"#777"}}/>Raw historical estimate</label></div><p className="fine-print" title={MODEL_TOOLTIP}>{MODEL_TOOLTIP}</p><div className="mini-chart" aria-label="Estimated 4H valuation path chart"><svg viewBox={`0 0 ${width} ${height}`}><line x1={left} x2={right} y1={y(0)} y2={y(0)} className="zero-line"/>{ticks.map(timestamp=><g key={timestamp}><line x1={x(timestamp)} x2={x(timestamp)} y1={bottom} y2={bottom+5} className="axis-tick"/><text x={x(timestamp)} y={bottom+20} textAnchor="middle" className="axis-label">{new Date(timestamp).toLocaleDateString("en-GB",{timeZone:"UTC",month:"short",day:"2-digit"})}</text><text x={x(timestamp)} y={bottom+34} textAnchor="middle" className="axis-label">{new Date(timestamp).toLocaleTimeString("en-GB",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hour12:false})} UTC</text></g>)}{splitEstimated(points).map((segment,index)=><polyline key={index} points={segment.map(point=>`${x(point.timestamp)},${y(point.estimatedNetPnlBtc*selectedIndex(point,result))}`).join(" ")} className="chart-series" style={{stroke:"#2a78d6"}}/>)}</svg></div><div className="path-metrics"><span><small>Best estimated unrealized PnL</small><strong className="positive">{money(best)}</strong></span><span><small>Max estimated adverse PnL</small><strong className="negative">{money(worst)}</strong></span><span><small>Grid points</small><strong>{path.length}</strong></span></div><div className="table-scroll compact path-table"><table><thead><tr><th>Timestamp</th><th>Estimated net PnL</th><th>Evidence source</th><th>Quality and details</th></tr></thead><tbody>{path.slice(0,80).map(point=>{const mark=point.rawEstimate??point.modelEstimate??point.ivNormalizedEstimate;return <tr key={point.timestamp}><td>{formatUtc(point.timestamp)}</td><td>{money(point.estimatedNetPnlBtc===undefined?undefined:point.estimatedNetPnlBtc*selectedIndex(point,result))}</td><td>{mark?.priceSource??"unavailable"}</td><td><details className="evidence-details"><summary><span className={flagClass(point.estimateQuality==="unavailable"?"red":point.estimateQuality)}>{point.estimateQuality}</span></summary><p>{mark?.qualityReason??point.unavailableReason??"No bounded two-leg evidence at this grid point."}</p>{mark&&<p>±{mark.evidenceWindowMinutes}m · sold {mark.sold.instrumentName} @ {btc(mark.sold.priceBtcPerContract)} · bought {mark.bought.instrumentName} @ {btc(mark.bought.priceBtcPerContract)}</p>}</details></td></tr>})}</tbody></table></div></div><aside className="exit-card card"><p className="eyebrow">Research scenario</p><h3>Independent outcomes</h3><label className="scenario-input">Contract amount<input value={amount} onChange={event=>onAmountChange(event.target.value)} inputMode="decimal" /></label>{!valid&&<p className="quality-reason">Enter a finite, positive contract size.</p>}{entry.amountStepWarning&&<p className="quality-reason">{entry.amountStepWarning}</p>}{entry.liquidityWarning&&<p className="quality-reason">{entry.liquidityWarning}</p>}<div className="scenario-metrics"><label>Sold premium<strong>{btc(entry.sold.priceBtcPerContract*entry.amount)}</strong></label><label>Bought premium<strong>{btc(entry.bought.priceBtcPerContract*entry.amount)}</strong></label><label>Opening fees<strong>{btc(entry.openingFeesBtc)}</strong></label><label>Estimated gross entry<strong>{btc(entry.grossSpreadBtc)}</strong></label><label>Estimated net opening<strong>{btc(entry.netOpeningCashFlowBtc)}</strong></label><label>Theoretical maximum loss<strong>{btc(maxLoss)}</strong></label></div><div className="ledger-note"><strong>Estimated opening balance</strong><p>{btc(openingBalance)} · protective leg plus estimated opening fees</p></div><div className="exit-list">{outcomes.map(outcome=><div className={`exit-row ${outcome.status}`} key={outcome.label}><span>{outcome.label}<small>{outcome.valuationTimestamp?formatUtc(outcome.valuationTimestamp):outcome.status} · {outcome.evidenceSource??"unavailable"} · {outcome.estimateQuality}</small><small>{outcome.evidenceReason}</small></span><strong>{outcome.estimatedNetPnl===undefined?outcome.status:money(outcome.estimatedNetPnl*result.eventPrice)}</strong></div>)}</div><div className="ledger-note"><strong>Research entry evidence</strong><p>{entry.sold.instrumentName} / {entry.bought.instrumentName}</p><p>±{entry.evidenceWindowMinutes}m · sold {entry.priceSource === "model-reconstructed" ? "model" : "VWAP"} {btc(entry.sold.unslippedPriceBtcPerContract)} · bought {entry.priceSource === "model-reconstructed" ? "model" : "VWAP"} {btc(entry.bought.unslippedPriceBtcPerContract)} · {entry.slippageBps} bps slippage · fees {btc(entry.openingFeesBtc)}</p>{entry.sold.model&&entry.bought.model&&<><p>Anchor IV: sold {(entry.sold.model.anchorIvDecimal*100).toFixed(2)}% at {formatUtc(entry.sold.model.anchorTimestamp)} · bought {(entry.bought.model.anchorIvDecimal*100).toFixed(2)}% at {formatUtc(entry.bought.model.anchorTimestamp)}</p><p>Target BTC index {money(entry.sold.model.targetIndex)} · DTE {entry.sold.model.dte.toFixed(3)} · {entry.sold.model.forwardRateAssumption}</p></>}<p>{entry.qualityReason}</p></div></aside></div>;
}

function selectedIndex(point:EstimatedPathPoint,result:AnalysisResult){return (point.rawEstimate??point.modelEstimate??point.ivNormalizedEstimate)?.sold.supportingTrades[0]?.indexPrice||result.eventPrice;}
function splitEstimated(points:(EstimatedPathPoint&{estimatedNetPnlBtc:number})[]){const segments:typeof points[]=[];let current:typeof points=[];for(const point of points){if(current.length&&point.timestamp-current.at(-1)!.timestamp>5*3_600_000){segments.push(current);current=[];}current.push(point);}if(current.length)segments.push(current);return segments;}

export default function Home() {
  const stats = useMemo(() => durationSummary(), []);
  const [section, setSection] = useState<Section>("events");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [events, setEvents] = useState<BacktestEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [datasets, setDatasets] = useState<TradeDatasetSummary[]>([]);
  const [dataset, setDataset] = useState<TradeDataset>();
  const [datasetDirty, setDatasetDirty] = useState(false);
  const [datasetStatus, setDatasetStatus] = useState("Loading project trade datasets…");
  const [persistenceAvailable, setPersistenceAvailable] = useState(true);
  const [importDraft, setImportDraft] = useState<TradeDataset>();
  const [importMode, setImportMode] = useState<ImportMode>("separate");
  const [conflictResolution, setConflictResolution] = useState<ConflictResolution>("keep-existing");
  const [importSummary, setImportSummary] = useState<ImportSummary>();
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("options-lab-theme");
    const initialTheme = savedTheme === "dark" || savedTheme === "light"
      ? savedTheme
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    queueMicrotask(() => setTheme(initialTheme));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("options-lab-theme", theme);
  }, [theme]);
  const [dtes, setDtes] = useState(DTE_OPTIONS);
  const [dteTolerances, setDteTolerances] = useState<Record<number, DteTolerance>>(DEFAULT_DTE_TOLERANCES);
  const [expirySelectionMode, setExpirySelectionMode] = useState<ExpirySelectionMode>("liquidity-aware");
  const [widths, setWidths] = useState(WIDTH_OPTIONS);
  const [spreadKind, setSpreadKind] = useState<SpreadKind>("credit");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("taker");
  const [pricingAssumption, setPricingAssumption] = useState<PricingAssumption>("research-estimate");
  const [comboExecution, setComboExecution] = useState(false);
  const [amount, setAmount] = useState(1);
  const [pricingModes, setPricingModes] = useState(["vwap", "iv"]);
  const [inventory, setInventory] = useState<ContractSeries[]>([]);
  const [candidateManifests, setCandidateManifests] = useState<ContractCandidateManifest[]>([]);
  const [parseStatus, setParseStatus] = useState("Checking Deribit instrument manifest…");
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceReady, setSourceReady] = useState(false);
  const [selectedSpreadId, setSelectedSpreadId] = useState<string>();
  const [hideRed, setHideRed] = useState(false);
  const [resolveStatus, setResolveStatus] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [resultsFilter, setResultsFilter] = useState<"all" | "trusted" | "green">("all");
  const [selectedResultId, setSelectedResultId] = useState<string>();
  const [expandedResultIds, setExpandedResultIds] = useState<string[]>([]);
  const [scenarioAmount, setScenarioAmount] = useState("");
  const [scenario, setScenario] = useState<ContractSizeScenario>();
  const [scenarioCalculating, setScenarioCalculating] = useState(false);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("pnl");
  const sectionRefs = useRef<Record<Section, HTMLElement | null>>({ events: null, construction: null, contracts: null, analysis: null });

  const selectedEvent = useMemo(() => events.find(event => event.id === selectedEventId) ?? events[0] ?? EMPTY_EVENT, [events, selectedEventId]);
  const effectiveEntryTimestamp = selectedEvent.entryTimestamp ?? parseUtcDate(selectedEvent.entryDate);
  const desiredSpreads = useMemo(
    () => generateDesiredSpreads(selectedEvent, dtes, widths, spreadKind),
    [selectedEvent, dtes, widths, spreadKind],
  );
  const retrievedSpreads = useMemo(
    () => buildExpiryCandidates(desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, "taker", expirySelectionMode, pricingAssumption),
    [desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, expirySelectionMode, pricingAssumption],
  );
  const visibleRetrievedSpreads = useMemo(() => visibleMatrixSpreads(retrievedSpreads, hideRed), [retrievedSpreads, hideRed]);
  const selectedSpread = visibleRetrievedSpreads.find(spread => spread.id === selectedSpreadId) ?? visibleRetrievedSpreads[0];
  const selectedAnalysis = analysisResults.find(result => result.spread.id === selectedResultId) ?? analysisResults[0];
  const entryWindowRows = selectedSpread?.soldContract && selectedSpread?.boughtContract
    ? windowComparison(selectedSpread, effectiveEntryTimestamp, selectedEvent.entryPrice, executionMode)
    : [];
  const inventoryTrades = inventory.reduce((sum, series) => sum + series.trades.length, 0);
  const inventoryExpiries = new Set(inventory.map(series => series.expiryTimestamp)).size;
  const filteredResults = analysisResults.filter(result => {
    if (resultsFilter === "green") return result.eventQuality === "green";
    if (resultsFilter === "trusted") return qualityRank(result.eventQuality) >= 1;
    return true;
  });
  const aggregateGroups = useMemo(() => aggregateObservations(analysisResults.map(result => result.observation)), [analysisResults]);

  const scenarioError = selectedAnalysis ? pricingAssumption === "research-estimate" ? (!Number.isFinite(Number(scenarioAmount)) || Number(scenarioAmount) <= 0 ? "Enter a finite, positive contract size." : undefined) : validateScenarioAmount(Number(scenarioAmount), selectedAnalysis.spread.soldContract?.amountMetadata, selectedAnalysis.spread.boughtContract?.amountMetadata) : undefined;

  useEffect(() => {
    if (!selectedAnalysis || !scenarioAmount || pricingAssumption === "research-estimate") return;
    const nextAmount = Number(scenarioAmount);
    if (scenarioError) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      if (stale) return;
      const input = selectedAnalysis.scenarioInput;
      const result = calculateContractSizeScenario({ event: input.event, candidates: input.candidates, candles: input.candles, baseConfig: input.config, amount: nextAmount });
      if (!stale) { setScenario(result); setScenarioCalculating(false); }
    }, 180);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [scenarioAmount, scenarioError, selectedAnalysis, pricingAssumption]);

  function selectAnalysisResult(id: string) {
    const next = analysisResults.find(result => result.spread.id === id);
    setSelectedResultId(id);
    setScenarioAmount(next ? String(next.scenarioInput.config.amount) : "");
    setScenario(undefined);
    setScenarioCalculating(Boolean(next));
  }

  function jump(next: Section) {
    setSection(next);
    sectionRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearEventAnalysis() { setAnalysisResults([]); setCandidateManifests([]); setInventory([]); setSelectedSpreadId(undefined); setSelectedResultId(undefined); setScenario(undefined); }

  async function refreshDatasets(preferredId?: string) {
    const response = await fetch("/__local/trade-datasets");
    if (!response.ok) throw new Error("Persistent dataset editing requires the local application server.");
    const payload = await response.json() as {datasets: TradeDatasetSummary[]}; setDatasets(payload.datasets);
    const remembered = preferredId ?? window.localStorage.getItem("options-lab-trade-dataset");
    const id = payload.datasets.some(item=>item.datasetId===remembered) ? remembered! : payload.datasets.some(item=>item.datasetId==="default-sample-trades") ? "default-sample-trades" : payload.datasets[0]?.datasetId;
    if (!id) throw new Error("No valid project trade datasets were found."); await loadDataset(id, false);
  }
  async function loadDataset(id:string, guard=true) { if (guard && !canLeaveDirty(datasetDirty,()=>window.confirm("Discard unsaved changes and switch datasets?"))) return; const response=await fetch(`/__local/trade-datasets/${encodeURIComponent(id)}`); const payload=await response.json(); if(!response.ok) throw new Error(payload.error??"Dataset could not be loaded."); const checked=validateTradeDataset(payload); if(!checked.ok) throw new Error(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | ")); const loaded=checked.dataset; setDataset(loaded); setEvents(loaded.trades); setSelectedEventId(current=>loaded.trades.some(event=>event.id===current)?current:loaded.trades[0]?.id??""); setDatasetDirty(false); clearEventAnalysis(); window.localStorage.setItem("options-lab-trade-dataset",id); setDatasetStatus(""); }
  async function saveDataset() { if(!dataset) return; const draft={...dataset,trades:events}; const checked=validateTradeDataset(draft); if(!checked.ok){setDatasetStatus(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | "));return;} try { const response=await fetch(`/__local/trade-datasets/${encodeURIComponent(dataset.datasetId)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(checked.dataset)}); const payload=await response.json(); if(!response.ok) throw new Error(payload.details?.map((e:{tradeId?:string;path:string;message:string})=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | ")??payload.error); setDataset(payload);setEvents(payload.trades);setDatasetDirty(false);setDatasetStatus(`Saved to data/trade-datasets/${dataset.datasetId}.json`);await refreshDatasetList(); } catch(error){setDatasetStatus(error instanceof Error?error.message:"Save failed.");} }
  async function refreshDatasetList(){const response=await fetch("/__local/trade-datasets");if(response.ok)setDatasets((await response.json()).datasets);}
  function exportDataset(){if(!dataset||datasetDirty)return;const blob=new Blob([JSON.stringify(dataset,null,2)+"\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`${dataset.datasetId}.json`;link.click();URL.revokeObjectURL(url);}
  async function chooseImport(file?:File){if(!file)return;if(!canLeaveDirty(datasetDirty,()=>window.confirm("Discard unsaved changes before importing?"))){if(importRef.current)importRef.current.value="";return;}try{const parsed=JSON.parse(await file.text());const checked=validateTradeDataset(parsed);if(!checked.ok)throw new Error(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | "));setImportDraft(checked.dataset);setImportSummary(undefined);setDatasetStatus("");}catch(error){setDatasetStatus(error instanceof Error?error.message:"Malformed JSON.");}}
  async function previewImport(){if(!importDraft||!dataset)return;const response=await fetch("/__local/trade-datasets/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataset:importDraft,mode:importMode,currentDatasetId:dataset.datasetId,conflictResolution,preview:true})});const payload=await response.json();if(!response.ok){setDatasetStatus(payload.error);return;}setImportSummary(payload.summary);}
  async function confirmImport(){if(!importDraft||!dataset||!importSummary)return;const response=await fetch("/__local/trade-datasets/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataset:importDraft,mode:importMode,currentDatasetId:dataset.datasetId,conflictResolution})});const payload=await response.json();if(!response.ok){setDatasetStatus(payload.error);return;}setImportDraft(undefined);setImportSummary(undefined);await refreshDatasets(payload.dataset.datasetId);setDatasetStatus(importMode==="separate"?`Imported as data/trade-datasets/${payload.filename}`:`Combined import saved to data/trade-datasets/${payload.filename}`);}

  useEffect(()=>{queueMicrotask(()=>{refreshDatasets().catch(error=>{setPersistenceAvailable(false);setDatasetStatus(error instanceof Error?error.message:"Persistent dataset editing requires the local application server.");});});},[]); // Startup discovery intentionally runs once.

  function patchEvent(patch: Partial<BacktestEvent>) {
    setEvents(current => current.map(event => event.id === selectedEvent.id ? { ...event, ...patch } : event));
    setDatasetDirty(true);
    setAnalysisResults([]);
    setCandidateManifests([]);
    setInventory([]);
  }

  function changeHorizons(next: number[]) {
    setDtes(next);
    setCandidateManifests([]);
    setInventory([]);
    setAnalysisResults([]);
  }

  function updateTolerance(target: number, field: keyof DteTolerance, value: number) {
    setDteTolerances(current => ({ ...current, [target]: { ...current[target], [field]: Math.max(0, value) } }));
    setCandidateManifests([]);
    setInventory([]);
    setAnalysisResults([]);
  }

  function addEvent() {
    const id = `manual-${Date.now()}`;
    const event: BacktestEvent = {
      id,
      label: `Manual MR · ${events.length + 1}`,
      direction: "long",
      entryDate: "2026-08-12",
      entryPrice: 0,
      invalidationPrice: 0,
    };
    setEvents(current => [...current, event]);
    setDatasetDirty(true);
    setSelectedEventId(id);
    setSection("events");
  }

  async function resolveTimestamps() {
    setResolveStatus("Resolving hourly touches…");
    try {
      const entryStart = parseUtcDate(selectedEvent.entryDate);
      const entryCandles = await fetchCandles(entryStart, entryStart + 86_400_000 - 1);
      const entryTouch = firstTouch(entryCandles, selectedEvent.entryPrice);
      const patch: Partial<BacktestEvent> = {};
      if (entryTouch) {
        patch.entryTimestamp = entryTouch.openTime;
        patch.entryTimeSource = "resolved";
      }
      if (selectedEvent.exitDate && selectedEvent.exitPrice) {
        const exitStart = parseUtcDate(selectedEvent.exitDate);
        const exitCandles = await fetchCandles(exitStart, exitStart + 86_400_000 - 1);
        patch.exitTimestamp = firstTouch(exitCandles, selectedEvent.exitPrice)?.openTime;
      }
      if (selectedEvent.vpocDate && selectedEvent.vpocPrice) {
        const vpocStart = parseUtcDate(selectedEvent.vpocDate);
        const vpocCandles = await fetchCandles(vpocStart, vpocStart + 86_400_000 - 1);
        patch.vpocTimestamp = firstTouch(vpocCandles, selectedEvent.vpocPrice)?.openTime ?? selectedEvent.vpocTimestamp;
      }
      patchEvent(patch);
      setResolveStatus(entryTouch
        ? `Entry resolved to the first 1H candle containing ${money(selectedEvent.entryPrice)}.`
        : "No hourly candle contained the entry price on that UTC date. Set the timestamp manually or verify the source market.");
    } catch (error) {
      setResolveStatus(error instanceof Error ? `${error.message} Enter the UTC time manually.` : "Resolution failed. Enter the UTC time manually.");
    }
  }

  async function refreshSourceStatus() {
    try {
      const response = await fetch("/__deribit/history/status");
      const status = await response.json();
      if (!response.ok) throw new Error(status.error ?? "Contract source status failed.");
      setSourceReady(status.phase === "ready");
      if (status.phase === "ready") {
        setParseStatus(`${status.contractsFound.toLocaleString()} Deribit option instruments · manifest cache ready`);
      } else if (status.phase === "synchronizing") {
        setParseStatus("Synchronizing Deribit instrument manifest…");
      } else {
        setParseStatus("Deribit manifest is ready to synchronize.");
      }
      return status;
    } catch (error) {
      setParseStatus(error instanceof Error ? error.message : "Deribit History API service is unavailable.");
      return undefined;
    }
  }

  async function waitForIndex() {
    for (let attempt = 0; attempt < 2400; attempt += 1) {
      const status = await refreshSourceStatus();
      if (status?.phase === "ready") return;
      if (status?.phase === "error") throw new Error(status.error ?? "Deribit manifest is unavailable.");
      await new Promise(resolve => window.setTimeout(resolve, 750));
    }
    throw new Error("Manifest synchronization is still running. Retry once the status is ready.");
  }

  async function loadRequiredContracts(forceIndex = false) {
    if (!desiredSpreads.length) {
      setParseStatus("Enter a failed extreme before loading required contracts.");
      return;
    }
    setSourceBusy(true);
    setAnalysisResults([]);
    try {
      const indexResponse = await fetch("/__deribit/history/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: forceIndex }),
      });
      const indexStatus = await indexResponse.json();
      if (!indexResponse.ok) throw new Error(indexStatus.error ?? "Manifest synchronization could not start.");
      if (indexStatus.phase !== "ready") await waitForIndex();
      setParseStatus("Loading exact resolved contracts from Deribit History API…");
      const response = await fetch("/__deribit/history/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryTimestamp: effectiveEntryTimestamp,
          requests: desiredSpreads.map(spread => ({
            requestId: spread.id,
            targetDte: spread.targetDte,
            minDte: Math.min(dteTolerances[spread.targetDte].min, dteTolerances[spread.targetDte].max),
            maxDte: Math.max(dteTolerances[spread.targetDte].min, dteTolerances[spread.targetDte].max),
            soldStrike: spread.soldStrike,
            boughtStrike: spread.boughtStrike,
            optionType: spread.optionType,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Required contracts could not be loaded.");
      const nextInventory = payload.inventory as ContractSeries[];
      setInventory(nextInventory);
      setCandidateManifests(payload.candidates as ContractCandidateManifest[]);
      setSourceReady(true);
      setSelectedSpreadId(undefined);
      setParseStatus(`${payload.complete ? "Complete candidate set" : "INCOMPLETE candidate set — affected candidates are data-unavailable"} · ${payload.diagnostics.apiRequestCount.toLocaleString()} API requests · ${payload.diagnostics.candidateExpiries.toLocaleString()} expiry candidates · ${payload.diagnostics.contractsLoaded.toLocaleString()} contracts loaded · ${payload.diagnostics.validTrades.toLocaleString()} valid trades · ${payload.diagnostics.cacheHits.toLocaleString()} cache hits · ${payload.diagnostics.failedContracts.length.toLocaleString()} failures`);
    } catch (error) {
      setParseStatus(error instanceof Error ? error.message : "Contract loading failed.");
    } finally {
      setSourceBusy(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshSourceStatus(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function runBacktest() {
    const runnable = retrievedSpreads.filter(spread => spread.selectedForTest || spread.expiryRank === 1);
    if (!runnable.length) {
      setAnalysisStatus("No complete spread can be valued. Load both legs for at least one generated combination.");
      return;
    }
    setAnalysisStatus("Loading BTC index path and valuing every generated spread…");
    try {
      const entryTimestamp = selectedEvent.entryTimestamp ?? effectiveEntryTimestamp;
      const maxExpiry = Math.max(...runnable.map(spread => spread.expiryTimestamp!));
      const candles = await fetchCandles(entryTimestamp - 3_600_000, maxExpiry + 3_600_000);
      const observations = buildAndRunObservationRequests(
        selectedEvent,
        retrievedSpreads,
        candles,
        candidate => ({ targetExpiryHorizonDays: candidate.targetDte, widthUsd: candidate.targetWidth, spreadKind, expirySelectionPolicy: expirySelectionMode, candidateRankPolicy: "rank-1-only", amount, primaryExecutionScenario: "taker-tape-proxy", latencyMs: 1_000, fillWaitMs: 30 * 60_000, synchronizationThresholdMs: 60_000, slippageBps: 0, exitPolicy: { rule: "vpoc-target", fallback: "settlement" }, requestedPackaging: comboExecution ? "combo" : "legs", executionRoute: "synchronized-leg-proxy", officialComboEvidence: false, feeTier: "standard", marginModel: "segregated_sm" }),
      );
      const next: AnalysisResult[] = observations.map(observation => {
        const spread = observation.spread ?? retrievedSpreads.find(candidate => candidate.id === observation.candidateSelection.selectedCandidateId)!;
        const path = observation.valuationPath ?? [];
        const lifecycle = observation.selectedExitLifecycle;
        const selectedExit: ExitResult | undefined = lifecycle ? { rule: lifecycle.rule, timestamp: lifecycle.fillTimestamp ?? lifecycle.triggerTimestamp, triggerTimestamp: lifecycle.triggerTimestamp, decisionAvailableTimestamp: lifecycle.decisionTimestamp, status: lifecycle.status === "filled" || lifecycle.status === "settled" ? "hit" : lifecycle.status === "not-triggered" ? "not-hit" : "unavailable", reasonCode: lifecycle.status === "settled" ? "settlement" : lifecycle.status === "filled" ? "triggered" : lifecycle.status === "not-triggered" ? "not-hit" : "causal-valuation-unavailable", qualityReason: lifecycle.reasonCode } : undefined;
        const exits: ExitResult[] = observation.independentExitOutcomes?.map(exit => ({ rule: exit.rule, timestamp: exit.triggerTimestamp, triggerTimestamp: exit.triggerTimestamp, status: exit.status === "triggered" || exit.status === "available" ? "hit" : "not-hit", reasonCode: exit.status === "available" ? "settlement" : exit.status === "triggered" ? "triggered" : "not-hit", qualityReason: exit.reasonCode })) ?? [];
        const researchEntry = estimateResearchSpread({spread,targetTimestamp:entryTimestamp,targetIndex:selectedEvent.entryPrice,amount,slippageBps:observation.strategyConfiguration.slippageBps,executionRoute:observation.strategyConfiguration.executionRoute});
        const grid=valuationTimestamps(entryTimestamp,spread.expiryTimestamp!,[selectedEvent.vpocTimestamp??0]);
        const researchPath=researchEntry.status==="priced"?buildEstimatedPath({spread,timestamps:grid,candles,entry:researchEntry,slippageBps:observation.strategyConfiguration.slippageBps,executionRoute:observation.strategyConfiguration.executionRoute}):[];
        const researchOutcomes=researchEntry.status==="priced"?buildResearchOutcomes({event:selectedEvent,spread,entry:researchEntry,path:researchPath,candles}):[];
        const eventQuality: QualityFlag = researchEntry.status === "priced" ? researchEntry.estimateQuality : "red";
        const config = observation.strategyConfiguration;
        return { eventPrice:selectedEvent.entryPrice, observation, spread, path, exits, selectedExit, eventQuality, researchEntry, researchPath, researchOutcomes, scenarioInput: { event: selectedEvent, candidates: retrievedSpreads, candles, config } };
      });
      setAnalysisResults(next);
      setSelectedResultId(next[0]?.spread.id);
      setScenarioAmount(next[0] ? String(next[0].scenarioInput.config.amount) : "");
      setScenario(undefined);
      setScenarioCalculating(Boolean(next[0]));
      setAnalysisStatus(`${next.length} original-event × strategy-variant observations produced by the causal execution ledger.`);
      jump("analysis");
    } catch (error) {
      setAnalysisStatus(error instanceof Error ? error.message : "The valuation run failed.");
    }
  }

  function exportResults() {
    const configuration = { expiryHorizons: dtes, dteTolerances, expirySelectionMode, widths, spreadKind, pricingAssumption, conservativeTapeScenario: "taker-tape-proxy", makerDisplaySelection: executionMode, comboRequested: comboExecution, amount, pricingModes };
    const selected=analysisResults.find(result=>result.spread.id===selectedResultId)??analysisResults[0];
    const payload = pricingAssumption==="research-estimate"?{mode:"research-estimate",configuration,results:selected?[buildResearchExport({event:selectedEvent,spread:selected.spread,entry:selected.researchEntry,path:selected.researchPath,outcomes:selected.researchOutcomes})]:[]}:buildObservationExport(analysisResults.map(result => result.observation), configuration, events);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedEvent.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-options-backtest.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main data-theme={theme}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">O</span><div><strong>Options Lab</strong><span>BTC mean-reversion backtester</span></div></div>
        <nav aria-label="Backtest pipeline">
          {(["events", "construction", "contracts", "analysis"] as Section[]).map((item, index) => (
            <button className={section === item ? "active" : ""} onClick={() => jump(item)} key={item}><span>{index + 1}</span>{item}</button>
          ))}
        </nav>
        <div className="status-lockup"><span className="live-dot" /> local session<button className="theme-toggle" type="button" onClick={() => setTheme(current => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>{theme === "dark" ? "Light" : "Dark"}</button></div>
      </header>

      <div className="page-shell">
        <section className="hero">
          <div><p className="eyebrow">Historical Deribit execution research</p><h1>Test the trade you could have priced.</h1><p className="hero-copy">Resolve the signal, construct every eligible spread, normalize sparse prints, then inspect the full path—not just the terminal payoff.</p></div>
          <div className="hero-badges"><span>MR only</span><span>{pricingAssumption === "research-estimate" ? "Research estimate" : "Conservative tape check"}</span><span>r = 0</span><span>BTC + USD ledgers</span></div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.events = node; }}>
          <div className="dataset-toolbar card"><label>Trade dataset<select value={dataset?.datasetId??""} onChange={event=>void loadDataset(event.target.value)} disabled={!persistenceAvailable}>{datasets.map(item=><option key={item.datasetId} value={item.datasetId}>{item.name}</option>)}</select></label><span>{dataset ? `${dataset.trades.length} trades · updated ${new Date(dataset.updatedAt).toLocaleString()}` : "Unavailable"}</span><button className="primary-button" disabled={!datasetDirty||!persistenceAvailable} onClick={saveDataset}>Save changes</button><button className="secondary-button" disabled={datasetDirty||!dataset} title={datasetDirty?"Save changes before exporting":""} onClick={exportDataset}>Export dataset</button><button className="secondary-button" disabled={!persistenceAvailable} onClick={()=>importRef.current?.click()}>Import dataset</button><input ref={importRef} hidden type="file" accept=".json,application/json" onChange={event=>void chooseImport(event.target.files?.[0])}/>{datasetDirty&&<strong className="dirty-state">Unsaved changes</strong>}</div>
          <p className="fine-print dataset-note">Save updates the project JSON file. Export downloads a copy. {datasetDirty&&"Save changes before exporting."}</p>
          {datasetStatus&&<p className={`inline-status ${!persistenceAvailable?"dataset-error":""}`}>{datasetStatus}</p>}
          {importDraft&&<div className="dataset-import card"><h3>Import {importDraft.name}</h3><div className="check-row"><label><input type="radio" checked={importMode==="separate"} onChange={()=>{setImportMode("separate");setImportSummary(undefined);}}/> Add as separate dataset</label><label><input type="radio" checked={importMode==="combine-current"} onChange={()=>{setImportMode("combine-current");setImportSummary(undefined);}}/> Combine with current dataset</label></div>{importMode==="combine-current"&&<div className="check-row"><label><input type="radio" checked={conflictResolution==="keep-existing"} onChange={()=>{setConflictResolution("keep-existing");setImportSummary(undefined);}}/> Keep existing</label><label><input type="radio" checked={conflictResolution==="replace-imported"} onChange={()=>{setConflictResolution("replace-imported");setImportSummary(undefined);}}/> Replace with imported</label></div>}{importSummary?<><p>Added {importSummary.added} · unchanged {importSummary.unchanged} · replaced {importSummary.replaced} · conflicts {importSummary.conflicts} · rejected {importSummary.rejected}</p><button className="primary-button" onClick={confirmImport}>Confirm import and write JSON</button></>:<button className="primary-button" onClick={previewImport}>Review import summary</button>} <button className="secondary-button" onClick={()=>setImportDraft(undefined)}>Cancel</button></div>}
          <div className="section-heading"><div><span className="step-number">01</span><p className="eyebrow">Signal definition</p><h2>Event & exact touch time</h2></div><button className="secondary-button" disabled={!dataset} onClick={addEvent}>Add manual event</button></div>
          <div className="event-layout">
            <aside className="event-list card">
              <div className="card-title-row"><div><p className="eyebrow">Imported sample</p><h3>{events.length} MR trades</h3></div><span className="tiny-badge">BO excluded</span></div>
              <div className="event-scroll">
                {events.map(event => (
                  <button className={`event-row ${event.id === selectedEvent.id ? "selected" : ""}`} onClick={() => { setSelectedEventId(event.id); setAnalysisResults([]); setCandidateManifests([]); setInventory([]); }} key={event.id}>
                    <span className={`direction ${event.direction}`}>{event.direction === "long" ? "L" : "S"}</span>
                    <span><strong>{event.label}</strong><small>{money(event.entryPrice)} entry</small></span>
                    <span className={event.extremePrice ? "data-ready" : "data-missing"}>{event.extremePrice ? "ready" : "needs extreme"}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="event-editor card">
              <div className="card-title-row"><div><p className="eyebrow">Selected thesis</p><h3>{selectedEvent.label}</h3></div><span className={`direction-pill ${selectedEvent.direction}`}>{selectedEvent.direction} BTC</span></div>
              <div className="form-grid four">
                <label>Label<input value={selectedEvent.label} onChange={event => patchEvent({ label: event.target.value })} /></label>
                <label>Direction<select value={selectedEvent.direction} onChange={event => patchEvent({ direction: event.target.value as "long" | "short" })}><option value="long">Long / bullish MR</option><option value="short">Short / bearish MR</option></select></label>
                <label>Entry date<input type="date" value={selectedEvent.entryDate} onChange={event => patchEvent({ entryDate: event.target.value, entryTimestamp: undefined })} /></label>
                <label>Entry price<input type="number" value={selectedEvent.entryPrice || ""} onChange={event => patchEvent({ entryPrice: Number(event.target.value), entryTimestamp: undefined })} /></label>
                <label>Failed extreme<input type="number" placeholder="Required for strikes" value={selectedEvent.extremePrice ?? ""} onChange={event => patchEvent({ extremePrice: Number(event.target.value) || undefined })} /></label>
                <label>VPOC target<input type="number" placeholder="Auction target" value={selectedEvent.vpocPrice ?? ""} onChange={event => patchEvent({ vpocPrice: Number(event.target.value) || undefined })} /></label>
                <label>VPOC date<input type="date" value={selectedEvent.vpocDate ?? ""} onChange={event => patchEvent({ vpocDate: event.target.value || undefined, vpocTimestamp: undefined })} /></label>
                <label>Invalidation / SL<input type="number" value={selectedEvent.invalidationPrice ?? ""} onChange={event => patchEvent({ invalidationPrice: Number(event.target.value) || undefined })} /></label>
                <label>Exit date<input type="date" value={selectedEvent.exitDate ?? ""} onChange={event => patchEvent({ exitDate: event.target.value || undefined, exitTimestamp: undefined })} /></label>
                <label>Exit price<input type="number" value={selectedEvent.exitPrice ?? ""} onChange={event => patchEvent({ exitPrice: event.target.value === "" ? undefined : Number(event.target.value), exitTimestamp: undefined })} /></label>
                <label>Range low<input type="number" value={selectedEvent.rangeLow ?? ""} onChange={event => patchEvent({ rangeLow: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                <label>Range high<input type="number" value={selectedEvent.rangeHigh ?? ""} onChange={event => patchEvent({ rangeHigh: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                <label className="event-notes">Notes<input value={selectedEvent.notes ?? ""} onChange={event => patchEvent({ notes: event.target.value || undefined })} /></label>
              </div>
              <div className="time-resolver">
                <div><p className="eyebrow">Entry timestamp</p><strong>{selectedEvent.entryTimestamp ? formatUtc(selectedEvent.entryTimestamp) : `${selectedEvent.entryDate} · unresolved`}</strong><small>{selectedEvent.entryTimestamp ? "First BTCUSDT 1H candle whose low/high contains the entry price." : "Contract retrieval uses 00:00 UTC provisionally until resolved."}</small></div>
                <label className="manual-time">Manual UTC time<input type="datetime-local" value={selectedEvent.entryTimestamp ? new Date(selectedEvent.entryTimestamp).toISOString().slice(0, 16) : ""} onChange={event => patchEvent({ entryTimestamp: event.target.value ? Date.parse(`${event.target.value}Z`) : undefined, entryTimeSource: "manual" })} /></label>
                <button className="primary-button" onClick={resolveTimestamps}>Resolve first touch</button>
              </div>
              {resolveStatus && <p className="inline-status">{resolveStatus}</p>}
              <div className="source-strip"><span><small>Backtest exit</small><strong>{selectedEvent.exitDate ?? "—"} · {money(selectedEvent.exitPrice)}</strong></span><span><small>VPOC touch</small><strong>{formatUtc(selectedEvent.vpocTimestamp)}</strong></span><span><small>Range</small><strong>{money(selectedEvent.rangeLow)} — {money(selectedEvent.rangeHigh)}</strong></span></div>
            </div>

            <aside className="duration-card card">
              <p className="eyebrow">Duration prior</p><h3>{stats.count} observed moves</h3>
              <div className="duration-figure"><strong>{Math.round(stats.medianEntryToTargetHours / 24)}d</strong><span>median entry → target</span></div>
              <div className="quartile-track"><span style={{ left: "24%" }} /><span style={{ left: "50%" }} /><span style={{ left: "76%" }} /></div>
              <div className="quartile-labels"><span>P25<br/><strong>{Math.round(stats.p25EntryToTargetHours / 24)}d</strong></span><span>Median<br/><strong>{Math.round(stats.medianEntryToTargetHours / 24)}d</strong></span><span>P75<br/><strong>{Math.round(stats.p75EntryToTargetHours / 24)}d</strong></span></div>
              <p className="fine-print">Duration records inform fixed-time exits only. They do not overwrite the price-action event.</p>
            </aside>
          </div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.construction = node; }}>
          <div className="section-heading"><div><span className="step-number">02</span><p className="eyebrow">Mechanical search space</p><h2>Spread construction</h2></div><span className="count-chip">{desiredSpreads.length} base combinations · {retrievedSpreads.length} expiry candidates</span></div>
          <div className="construction-layout">
            <div className="config-card card">
              <div className="config-block"><label className="config-label">Expiry Horizon<InfoTooltip term="expiryHorizon" label="Explain Expiry Horizon versus Actual DTE" /> <small>admissible listing band</small></label><CheckboxGroup values={DTE_OPTIONS} selected={dtes} onChange={changeHorizons} formatter={value => `~${value}D`} /></div>
              <div className="config-block"><label className="config-label">Spread width <small>desired USD strike gap</small></label><CheckboxGroup values={WIDTH_OPTIONS} selected={widths} onChange={setWidths} formatter={value => `$${value / 1000}k`} /></div>
              <div className="config-block"><span className="config-label">Expiry selection mode <small>entry-time evidence only</small></span><div className="mode-list">
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "liquidity-aware"} onChange={() => setExpirySelectionMode("liquidity-aware")} />Liquidity-aware<InfoTooltip term="liquidityAware" label="Explain liquidity-aware selection" /></label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "closest-dte"} onChange={() => setExpirySelectionMode("closest-dte")} />Closest DTE</label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "all-eligible"} onChange={() => setExpirySelectionMode("all-eligible")} />Test all eligible</label>
              </div></div>
              <div className="config-block two-col">
                <label>Payoff engine<select value={spreadKind} onChange={event => setSpreadKind(event.target.value as SpreadKind)}><option value="credit">Credit · MR default</option><option value="debit">Debit · same anchor rule</option></select></label>
                <label>Pricing assumption<select value={pricingAssumption} onChange={event => setPricingAssumption(event.target.value as PricingAssumption)}><option value="research-estimate">Research estimate · default</option><option value="conservative-tape-check">Conservative tape check · advanced</option></select></label>
              </div>
              <div className="config-block two-col"><label>Order packaging<select value={comboExecution ? "combo" : "legs"} onChange={event => setComboExecution(event.target.value === "combo")}><option value="legs">Separate legs · conservative</option><option value="combo">Deribit option combo</option></select></label><label>Contracts<input type="number" min="0.1" step="0.1" value={amount} onChange={event => setAmount(Math.max(0.1, Number(event.target.value)))} /></label></div>
              <div className="config-block"><label className="config-label">Pricing output <small>both retained by default</small></label><div className="check-row"><label className={`check-chip ${pricingModes.includes("vwap") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("vwap")} onChange={() => setPricingModes(current => current.includes("vwap") ? current.filter(value => value !== "vwap") : [...current, "vwap"])} />Raw VWAP<InfoTooltip term="rawVwap" label="Explain Raw VWAP" /></label><label className={`check-chip ${pricingModes.includes("iv") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("iv")} onChange={() => setPricingModes(current => current.includes("iv") ? current.filter(value => value !== "iv") : [...current, "iv"])} />IV normalized<InfoTooltip term="ivNormalized" label="Explain IV-normalized price" /></label></div></div>
            </div>
            <details className="advanced-settings card">
              <summary>Advanced Settings <small>DTE tolerance<InfoTooltip term="dteTolerance" label="Explain DTE tolerance and DTE fit" /></small></summary>
              <p className="quality-reason"><strong>Conservative tape check:</strong> a stress test requiring strict post-order taker prints and sufficient accumulated amount. A no-trade result does not invalidate a bounded Research estimate.</p><label>Opportunity display<select value={executionMode} onChange={event => setExecutionMode(event.target.value as ExecutionMode)}><option value="taker">Strict taker tape</option><option value="maker">Maker opportunity — optimistic</option></select></label>
              <div className="tolerance-grid">
                {DTE_OPTIONS.map(target => <div className="tolerance-row" key={target}><strong>~{target}D</strong><label>Min<input type="number" min="0" step="0.5" value={dteTolerances[target].min} onChange={event => updateTolerance(target, "min", Number(event.target.value))} /></label><span>to</span><label>Max<input type="number" min="0" step="0.5" value={dteTolerances[target].max} onChange={event => updateTolerance(target, "max", Number(event.target.value))} /></label><span>actual DTE</span></div>)}
              </div>
            </details>
            <div className="logic-card card">
              <p className="eyebrow">Strike rule applied</p>
              <div className="logic-flow"><span><small>Extreme</small><strong>{money(selectedEvent.extremePrice)}</strong></span><i>→</i><span><small>{selectedEvent.direction === "long" ? "Round down" : "Round up"}</small><strong>{desiredSpreads[0] ? money(desiredSpreads[0].anchorStrike) : "Needs extreme"}</strong></span><i>→</i><span><small>Structure</small><strong>{desiredSpreads[0]?.structure ?? "—"}</strong></span></div>
              <p className="fine-print">When the extreme is less than $100 from the rounded strike, the engine adds a separate $1k outward-buffer test. Both legs always use the same expiry. Liquidity-aware mode ranks Green above Yellow, then uses proximity to the target horizon; it retains the winner and one viable alternative.</p>
            </div>
          </div>
          <div className="table-card card">
            <div className="card-title-row"><div><p className="eyebrow">Generated matrix</p><h3>Desired → historical contract</h3></div><div className="matrix-header-actions"><label className="matrix-filter"><input type="checkbox" checked={hideRed} onChange={event => {
  const checked = event.target.checked;
  setHideRed(checked);
}} />Hide red</label><button className="secondary-button" onClick={() => jump("contracts")}>Load contracts</button></div></div>
            <div className="table-scroll"><table><thead><tr><th>Structure</th><th>Expiry horizon</th><th>Actual expiry</th><th>Desired → actual legs</th><th>Entry liquidity</th><th>DTE fit<InfoTooltip term="dteTolerance" label="Explain DTE tolerance and DTE fit" /></th><th>Selection</th></tr></thead><tbody>
              {visibleRetrievedSpreads.map(spread => (
                <tr className={selectedSpread?.id === spread.id ? "row-selected" : ""} key={spread.id} onClick={() => setSelectedSpreadId(spread.id)}>
                  <td><strong>{spread.structure}</strong>{spread.buffered && <small className="buffer-tag">buffer</small>}</td>
                  <td><strong>~{spread.targetDte}D</strong><small>{spread.dteMin}–{spread.dteMax}D eligible</small></td>
                  <td>{formatExpiryWithFriday(spread.expiryTimestamp,spread.expiryLabel)}<small>{spread.actualDte !== undefined ? `${spread.actualDte.toFixed(1)}D actual` : "awaiting contracts"}</small></td>
                  <td><span className="mono">S {money(spread.soldStrike)} → {money(spread.soldContract?.strike ?? spread.resolvedSoldStrike)}</span><small className="mono">B {money(spread.boughtStrike)} → {money(spread.boughtContract?.strike ?? spread.resolvedBoughtStrike)}</small><small>actual width {money(spread.actualWidth)}</small>{(spread.resolvedSoldInstrumentName || spread.resolvedBoughtInstrumentName) && <details className="evidence-details"><summary>Exact contract evidence</summary><p className="mono">Short: {spread.resolvedSoldInstrumentName}</p><p className="mono">Long: {spread.resolvedBoughtInstrumentName}</p><p>{spread.soldListingStatus} / {spread.boughtListingStatus}</p></details>}</td>
                  <td><span className={flagClass(spread.entryLiquidityQuality ?? "missing")}>{spread.dataStatus === "data-unavailable" ? "data-unavailable" : spread.entryLiquidityQuality ?? "unscored"}</span><small>S {spread.entryLiquidity?.shortTrades2h ?? 0} / L {spread.entryLiquidity?.longTrades2h ?? 0} prints · {(spread.entryLiquidity?.shortAmount2h ?? 0).toFixed(2)} / {(spread.entryLiquidity?.longAmount2h ?? 0).toFixed(2)} amount</small><small>sync {spread.entryLiquidity?.legTimeDiffMin?.toFixed(0) ?? "—"}m · index {spread.entryLiquidity?.indexDiffPct?.toFixed(2) ?? "—"}%</small><small>compatible prior 24h / 7d: {(spread.entryLiquidity?.previous24hShort.compatibleTradeCount ?? 0) + (spread.entryLiquidity?.previous24hLong.compatibleTradeCount ?? 0)} / {(spread.entryLiquidity?.previous7dShort.compatibleTradeCount ?? 0) + (spread.entryLiquidity?.previous7dLong.compatibleTradeCount ?? 0)}</small></td>
                  <td>{spread.dteDistance !== undefined ? `Δ ${spread.dteDistance.toFixed(1)}D` : "—"}<small>vs target ~{spread.targetDte}D</small></td>
                  <td><span className={`candidate-status ${spread.candidateStatus ?? "rejected"}`}>{spread.entryLiquidity?.viable && spread.entryLiquidityQuality === "red" ? "RED — LOW-CONFIDENCE ESTIMATE" : spread.candidateStatus ?? "unscored"}{spread.expiryRank ? ` · #${spread.expiryRank}` : ""}</span><small className="selection-reason">{formatExpiryWithFriday(spread.expiryTimestamp,spread.expiryLabel)} · {spread.expirySelectionReason ?? spread.retrievalNote}</small></td>
                </tr>
              ))}
              {!retrievedSpreads.length && <tr><td colSpan={7} className="empty-cell">Load eligible contract histories to discover and rank every listed expiry in the selected horizon bands.</td></tr>}
              {!!retrievedSpreads.length && !visibleRetrievedSpreads.length && <tr><td colSpan={7} className="empty-cell">No candidates remain visible while Hide red is enabled.</td></tr>}
            </tbody></table></div>
          </div>
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.contracts = node; }}>
          <div className="section-heading"><div><span className="step-number">03</span><p className="eyebrow">Historical tape</p><h2>Contracts & normalization</h2></div><div className="inventory-summary"><span><strong>{inventory.length}</strong> contracts</span><span><strong>{inventoryTrades.toLocaleString()}</strong> prints</span><span><strong>{inventoryExpiries}</strong> expiries</span></div></div>
          <div className="import-card card"><div><p className="eyebrow">Deribit History API</p><h3>Load historical option contracts</h3><p>The server resolves eligible instruments from Deribit listing metadata and retrieves only the exact contract histories required by the current matrix.</p></div><div className="import-actions"><button className="primary-button" disabled={sourceBusy} onClick={() => loadRequiredContracts(false)}>{sourceBusy ? "Loading contracts…" : "Load contracts"}</button><button className="secondary-button" disabled={sourceBusy} onClick={() => loadRequiredContracts(true)}>Refresh API manifest</button></div><div className="parse-status"><span className={inventory.length || sourceReady ? "live-dot" : "idle-dot"} />{parseStatus}</div></div>

          <div className="normalization-grid">
            <div className="table-card card">
              <div className="card-title-row"><div><p className="eyebrow">Selected spread · entry</p><h3>Five-window normalization</h3></div>{selectedSpread && <span className="tiny-badge">{selectedSpread.structure}</span>}</div>
              <div className="table-scroll compact"><table><thead><tr><th>Window</th><th>Sold prints<InfoTooltip term="sideCompatible" label="Explain side-compatible prints" /></th><th>Bought prints</th><th>Sold VWAP</th><th>Bought VWAP</th><th>Sold IV px</th><th>Bought IV px</th><th>Index mismatch<InfoTooltip term="indexMismatch" label="Explain index mismatch" /></th><th>Quality<InfoTooltip term="qualityStates" label="Explain Green, Yellow, Red, and Settlement" /></th></tr></thead><tbody>
                {entryWindowRows.map(row => <tr key={row.sold.windowMinutes}><td>±{row.sold.windowMinutes < 60 ? `${row.sold.windowMinutes}m` : `${row.sold.windowMinutes / 60}h`}</td><td>{row.sold.compatibleTradeCount}/{row.sold.tradeCount}<small>{row.sold.totalAmount.toFixed(2)} BTC</small></td><td>{row.bought.compatibleTradeCount}/{row.bought.tradeCount}<small>{row.bought.totalAmount.toFixed(2)} BTC</small></td><td>{btc(row.sold.vwapPriceBtc)}</td><td>{btc(row.bought.vwapPriceBtc)}</td><td>{btc(row.sold.ivNormalizedPriceBtc)}</td><td>{btc(row.bought.ivNormalizedPriceBtc)}</td><td>{pct(row.indexDiffPct)}</td><td><span className={flagClass(row.qualityFlag)}>{row.qualityFlag}</span></td></tr>)}
                {!entryWindowRows.length && <tr><td colSpan={9} className="empty-cell">Select a complete retrieved spread to compute window metrics.</td></tr>}
              </tbody></table></div>
            </div>
            <aside className="quality-card card">
              <p className="eyebrow">Synchronization gate<InfoTooltip term="synchronizationGap" label="Explain synchronization gap" /></p><h3>{entryWindowRows.find(row => row.sold.nearestTrade && row.bought.nearestTrade)?.qualityFlag ?? "No score"}</h3>
              {(() => { const best = entryWindowRows.find(row => row.sold.nearestTrade && row.bought.nearestTrade); return best ? <><dl><div><dt>Sold timestamp</dt><dd>{formatUtc(best.soldLegTimestamp)}</dd></div><div><dt>Bought timestamp</dt><dd>{formatUtc(best.boughtLegTimestamp)}</dd></div><div><dt>Leg time difference</dt><dd>{best.legTimeDiffMin?.toFixed(1) ?? "—"} min</dd></div><div><dt>Index difference</dt><dd>{pct(best.indexDiffPct)}</dd></div><div><dt>IV difference</dt><dd>{best.ivDiff?.toFixed(2) ?? "—"} pts</dd></div></dl><p className="quality-reason">{best.qualityReason}</p></> : <p className="empty-note">Both legs need historical prints before synchronization can be scored.</p>; })()}
              <div className="legend"><span><QualityDot flag="green" />≤30m / ≤0.5%</span><span><QualityDot flag="yellow" />≤2h / ≤1.5%</span><span><QualityDot flag="red" />fallback / missing</span></div>
            </aside>
          </div>
          <div className="action-bar"><div><strong>Ready to value {retrievedSpreads.filter(spread => spread.selectedForTest && spread.entryLiquidity?.viable).length} selected expiry candidates</strong><span>4H grid · VPOC<InfoTooltip term="vpocExit" label="Explain VPOC exit" /> · credit capture<InfoTooltip term="creditCapture" label="Explain 50 and 70 percent credit capture" /> · fixed time<InfoTooltip term="fixedTime" label="Explain fixed-time exits" /> · invalidation<InfoTooltip term="invalidation4h" label="Explain 4H invalidation" /> · expiry<InfoTooltip term="expirySettlement" label="Explain expiry settlement" /></span></div><button className="primary-button" onClick={runBacktest}>Run full backtest</button></div>
          {analysisStatus && <p className="inline-status strong">{analysisStatus}</p>}
        </section>

        <section className="workspace-section" ref={node => { sectionRefs.current.analysis = node; }}>
          <div className="section-heading"><div><span className="step-number">04</span><p className="eyebrow">Path-aware output</p><h2>PnL, exits & trust filters</h2></div><button className="secondary-button" disabled={!analysisResults.length} onClick={exportResults}>Export JSON</button></div>
          <div className="filter-row"><div className="segmented">{([['all','All tests'],['trusted','Green / yellow'],['green','Green only']] as const).map(([value,label]) => <button className={resultsFilter === value ? "active" : ""} onClick={() => setResultsFilter(value)} key={value}>{label}</button>)}</div><span>{filteredResults.length} / {analysisResults.length} results visible</span></div>
          {!!aggregateGroups.length && pricingAssumption === "research-estimate" && <div className="source-strip" aria-label="Unfiltered research estimate aggregates"><span><small>Original signals</small><strong>{analysisResults.length}</strong></span><span><small>Priced observations</small><strong>{analysisResults.filter(r=>r.researchEntry.status==="priced").length}</strong></span><span><small>Unavailable observations</small><strong>{analysisResults.filter(r=>r.researchEntry.status==="unavailable").length}</strong></span><span><small>Pricing coverage</small><strong>{pct(100*analysisResults.filter(r=>r.researchEntry.status==="priced").length/analysisResults.length)}</strong></span></div>}
          {!!aggregateGroups.length && pricingAssumption === "conservative-tape-check" && <div className="source-strip" aria-label="Unfiltered conservative tape aggregates"><span><small>Original signals</small><strong>{analysisResults.length}</strong></span><span><small>Strict tape entries</small><strong>{analysisResults.filter(r=>r.observation.entryExecution?.status==="filled").length}</strong></span><span><small>No trade / unavailable</small><strong>{analysisResults.filter(r=>r.observation.entryExecution?.status!=="filled").length}</strong></span></div>}
          <div className="cashflow-explainer card"><strong>Cash-flow identities</strong><p>Credit: gross entry credit = sold premium received − bought premium paid; net opening cash flow = gross entry credit × amount − opening fees; mark-to-close PnL = opening cash flow − closing cost − exit fees. Debit spreads mirror the cash-flow direction: opening cash flow is negative and closing proceeds are positive.</p><p>Every path value is a diagnostic unrealized close mark anchored to the actual causal opening cash flow. Realized PnL is shown only for a causal close fill or versioned settlement.</p></div>
          {pricingAssumption === "conservative-tape-check" && <div className="table-card card"><div className="table-scroll"><table><thead><tr><th>Conservative tape result</th><th>Spread and both strikes</th><th>Expiry</th><th>Entry evidence</th></tr></thead><tbody>{filteredResults.map(result=><tr key={result.spread.id} className={selectedAnalysis?.spread.id===result.spread.id?"row-selected":""} onClick={()=>selectAnalysisResult(result.spread.id)}><td>{result.observation.eventOutcome}</td><td><strong>{result.spread.structure}</strong><small className="mono">{spreadIdentity(result.spread).soldStrike??"—"} / {spreadIdentity(result.spread).boughtStrike??"—"} {result.spread.optionType}</small></td><td>{formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</td><td>{entryEvidenceExplanation(result.observation)}</td></tr>)}</tbody></table></div></div>}
          {pricingAssumption === "research-estimate" && <div className="table-card card"><div className="table-scroll"><table><thead><tr><th><span className="sr-only">Expand</span></th><th>Estimate quality</th><th>Spread and both strikes</th><th>Expiry</th><th>Width</th><th>Estimated gross entry</th><th>Estimated net opening</th><th>Best estimated unrealized PnL</th><th>Max estimated adverse PnL</th><th>Estimated selected outcome</th></tr></thead><tbody>
            {filteredResults.map(result => {
              const researchPnls=result.researchPath.map(point=>point.estimatedNetPnlBtc).filter((value):value is number=>value!==undefined).map(value=>value*selectedEvent.entryPrice); const researchBest=Math.max(...researchPnls),researchWorst=Math.min(...researchPnls); const estimate=result.researchEntry.status==="priced"?result.researchEntry:undefined;
              const expanded = expandedResultIds.includes(result.spread.id);
              return <Fragment key={result.spread.id}><tr className={selectedAnalysis?.spread.id === result.spread.id ? "row-selected" : ""} onClick={() => selectAnalysisResult(result.spread.id)}><td><button className="expand-button" aria-expanded={expanded} aria-controls={`ledger-${result.spread.id}`} aria-label={`${expanded ? "Collapse" : "Expand"} opening ledgers for ${result.spread.structure}`} onClick={event => { event.stopPropagation(); setExpandedResultIds(current => expanded ? current.filter(id => id !== result.spread.id) : [...current, result.spread.id]); }}><span className="expand-chevron" aria-hidden="true" /></button></td><td><span className={flagClass(estimate?.estimateQuality ?? "red")}>{estimate?.estimateQuality ?? "unavailable"}</span><small>Confidence label, not execution proof</small></td><td><strong>{result.spread.structure}</strong><small className="mono">{spreadIdentity(result.spread).soldStrike ?? "—"} / {spreadIdentity(result.spread).boughtStrike ?? "—"} {result.spread.optionType}</small></td><td>{formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</td><td>{money(result.spread.actualWidth)}</td><td>{btc(estimate?.grossSpreadBtc)}</td><td>{btc(estimate?.netOpeningCashFlowBtc)}</td><td className="positive">{researchBest===-Infinity?"—":money(researchBest)}</td><td className="negative">{researchWorst===Infinity?"—":money(researchWorst)}</td><td>{estimate?"Estimated valuation":"Unavailable"}</td></tr>{expanded && <tr className="ledger-detail-row"><td colSpan={10}><div id={`ledger-${result.spread.id}`} className="ledger-pair">{estimate?<section className="opening-ledger"><h4>Research estimate evidence</h4><p>{estimate.disclaimer}</p><dl><div><dt>Contracts</dt><dd className="mono">{estimate.sold.instrumentName} / {estimate.bought.instrumentName}</dd></div><div><dt>Evidence window</dt><dd>±{estimate.evidenceWindowMinutes} minutes</dd></div><div><dt>Leg prices</dt><dd>{btc(estimate.sold.priceBtcPerContract)} / {btc(estimate.bought.priceBtcPerContract)}</dd></div><div><dt>Synchronization</dt><dd>{estimate.synchronizationGapMinutes.toFixed(1)} min</dd></div><div><dt>Source / quality</dt><dd>{estimate.priceSource} · {estimate.estimateQuality}</dd></div><div><dt>Slippage</dt><dd>{estimate.slippageBps} bps adverse by economic side</dd></div><div><dt>Fees</dt><dd>{btc(estimate.openingFeesBtc)}</dd></div></dl>{estimate.liquidityWarning&&<p>{estimate.liquidityWarning}</p>}</section>:<p>{result.researchEntry.status === "unavailable" ? result.researchEntry.reason : "Research estimate unavailable."}</p>}</div></td></tr>}</Fragment>;
            })}
            {!filteredResults.length && <tr><td colSpan={10} className="empty-cell">Run the backtest after importing eligible contract histories. Red tests remain visible in “All tests.”</td></tr>}
          </tbody></table></div></div>}

          {selectedAnalysis && pricingAssumption === "research-estimate" && <ResearchDetail result={selectedAnalysis} amount={scenarioAmount} onAmountChange={setScenarioAmount}/>}
          {selectedAnalysis && pricingAssumption === "conservative-tape-check" && <div className="analysis-detail">
            <div className="path-card card">
              <div className="card-title-row"><div><p className="eyebrow">Selected combination</p><h3 aria-live="polite">{valuationChartTitle(chartMetric)}</h3></div><span className={flagClass(selectedAnalysis.eventQuality)}>{selectedAnalysis.eventQuality} event</span></div>
              <ValuationChart path={selectedAnalysis.path} exits={selectedAnalysis.exits} metric={chartMetric} onMetricChange={setChartMetric}/>
              <div className="path-metrics"><span><small>Best IV diagnostic mark<InfoTooltip term="extrema" label="Explain IV diagnostic extrema" /></small><strong className="positive">{money(Math.max(...selectedAnalysis.path.filter(point => point.pointRole === "diagnostic-mark" && point.ivMarkRole === "iv-normalized-close-mark").map(point => point.diagnosticIvUnrealizedPnlUsd ?? -Infinity)))}</strong></span><span><small>Max adverse IV diagnostic mark</small><strong className="negative">{money(Math.min(...selectedAnalysis.path.filter(point => point.pointRole === "diagnostic-mark" && point.ivMarkRole === "iv-normalized-close-mark").map(point => point.diagnosticIvUnrealizedPnlUsd ?? Infinity)))}</strong></span><span><small>Grid points</small><strong>{selectedAnalysis.path.length}</strong></span></div>
              <div className="table-scroll compact path-table"><table><thead><tr><th>Timestamp</th><th>BTC index</th><th>Raw value</th><th>IV value</th><th>Raw diagnostic unrealized USD</th><th>IV diagnostic unrealized USD</th><th>Valuation evidence<InfoTooltip term="valuationEvidence" label="Explain valuation evidence at each timestamp" /></th></tr></thead><tbody>{selectedAnalysis.path.slice(0, 80).map(point => <tr key={point.timestamp}><td>{formatUtc(point.timestamp)}</td><td>{money(point.btcIndex)}<small>{point.btcIndexSource}{point.btcIndexTimestamp ? ` · ${formatUtc(point.btcIndexTimestamp)}` : ""}</small></td><td>{btc(point.rawSpreadValue)}</td><td>{btc(point.ivSpreadValue)}</td><td>{money(point.diagnosticRawUnrealizedPnlUsd)}</td><td className={(point.diagnosticIvUnrealizedPnlUsd ?? 0) >= 0 ? "positive" : "negative"}>{money(point.diagnosticIvUnrealizedPnlUsd)}</td><td><details className="evidence-details"><summary><span className={flagClass(point.qualityFlag)}>{point.qualityFlag}</span></summary><p><strong>{point.valuationSource}</strong> · {point.qualityReason}</p><p><strong>Underlying:</strong> {point.btcIndexAvailabilityReason}</p><dl><div>Sold gap <b>{point.soldLegGapMin?.toFixed(1) ?? "—"}m</b></div><div>Bought gap <b>{point.boughtLegGapMin?.toFixed(1) ?? "—"}m</b></div><div>Sync gap <b>{point.synchronizationGapMin?.toFixed(1) ?? "—"}m</b></div><div>Index mismatch <b>{pct(point.indexMismatch)}</b></div><div>Direction fallback <b>{point.usedDirectionFallback ? "yes" : "no"}</b></div><div>Model fallback <b>{point.usedModelFallback ? "yes" : "no"}</b></div></dl></details></td></tr>)}</tbody></table></div>
            </div>
            <aside className="exit-card card"><p className="eyebrow">Exit engine</p><h3>Independent outcomes</h3><label className="scenario-input">Contract amount<input value={scenarioAmount} onChange={event => setScenarioAmount(event.target.value)} inputMode="decimal" /></label>{scenarioError && <p className="quality-reason">{scenarioError}</p>}{scenarioCalculating && <p>Recalculating cached causal tapes…</p>}{scenario && <><div className="scenario-metrics"><label>Best IV diagnostic mark<strong>{money(scenario.pathMetrics.bestIvDiagnosticMark)}</strong></label><label>Max adverse IV diagnostic mark<strong>{money(scenario.pathMetrics.maxAdverseIvDiagnosticMark)}</strong></label><label>Grid points<strong>{scenario.pathMetrics.gridPoints}</strong></label></div><div className="ledger-note"><strong>Estimated minimum opening balance</strong><p>{btc(scenario.capitalRequirement.estimatedBtcRequirement)} · {scenario.capitalRequirement.requestedMarginModel} · {scenario.capitalRequirement.collateralCurrency} · {scenario.capitalRequirement.accountConfiguration}<InfoTooltip term="scenarioCapital" label="Explain opening balance estimate" /></p></div><div className="exit-list">{scenario.outcomes.map(outcome => <div className={`exit-row ${outcome.status}`} key={outcome.rule}><span>{outcome.rule}<small>{outcome.reasonCode}</small></span><strong>{outcome.pnlUsd === undefined ? outcome.status : money(outcome.pnlUsd)}</strong></div>)}</div></>}<p className="quality-reason"><strong>Actual entry evidence:</strong> {entryEvidenceExplanation(selectedAnalysis.observation)}</p><div className="exit-list">{selectedAnalysis.exits.map(exit => <div className={`exit-row ${exit.status}`} key={exit.rule}><span>{exit.qualityFlag ? <QualityDot flag={exit.qualityFlag} /> : <span className="quality-dot muted" />}{exit.rule}<small>{exit.timestamp ? formatUtc(exit.timestamp) : exit.status.replace("-", " ")} · {exit.qualityReason}</small></span><strong>{exit.status}</strong></div>)}</div><div className="ledger-note"><strong>Terminal realized result</strong><p>{money(displayedProfit(selectedAnalysis.observation))} · sourced only from causal close fills or settlement.</p></div><div className="ledger-note"><strong>Trust means reliability</strong><p>Red, Yellow, and Green describe pricing evidence only—not profitability. Displayed trust combines entry evidence with the selected exit’s own evidence.</p></div></aside>
          </div>}
        </section>

        <footer><span>BTC Options Lab · local research environment</span><span>All timestamps UTC · expiry settlement 08:00 UTC</span></footer>
      </div>
    </main>
  );
}
