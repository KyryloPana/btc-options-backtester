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
  valuationTimestamps,
  windowComparison,
} from "./lib/backtester";
import { aggregateObservations, buildAndRunObservationRequests, buildObservationExport, type StrategyObservation, type StrategyVariantConfig } from "./lib/observation-ledger";
import { calculateContractSizeScenario, validateScenarioAmount, type ContractSizeScenario } from "./lib/contract-size-scenario";
import { displayedProfit, entryEvidenceExplanation, spreadIdentity } from "./lib/observation-presentation";
import { CHART_GEOMETRY, CHART_SERIES, RESEARCH_CHART_SERIES, adaptResearchPath, hitExitGroups, nearestPoint, rawResearchObservations, researchOutcomeGroups, researchPathStatistics, researchPnlUsd, splitSeriesAtMissing, uniqueCanonicalSpreads, timestampAtX, timeX, valuationChartTitle, visibleMatrixSpreads, type ChartMetric, type ChartSeriesKey, type ResearchChartMetric } from "./lib/valuation-chart";
import { MODEL_TOOLTIP, modelHistoricalEvidenceWindows, referenceValuationSourceOf, buildEstimatedPath, buildResearchExport, buildResearchOutcomes, evaluateResearchEntryLayers, formatExpiryWithFriday, scaleResearchEstimate, scaleResearchPath, validateResearchAmount, openingUsdEquivalent, type EstimatedOutcome, type EstimatedPathPoint, type PricingAssumption, type ResearchValuation, type ResearchEntryLayers } from "./lib/research-valuation";
import { parseOhlcCandles } from "./lib/candle-pipeline";
import { breakEven, expiryPayoff, type ExpiryPayoffInput, type PayoffCurrency } from "./lib/expiry-payoff";
import { payoffInspectorSummary } from "./lib/payoff-inspector";
import { EXECUTION_TIMING_METADATA } from "./lib/execution-policy";
import { compactSettlementProvenance, SETTLEMENT_ACCOUNTING_VERSION } from "./lib/settlement-provenance";
import { candidateIdentity, canonicalJson, renameResearchSelectionEvent, compactCandidateMetadata, compactEntryEconomics, compactResearchSelectionEvent, compactMarginResult, compactOutcomeSnapshot, compactValuationPoint, eventReference, reconcileGeneratedSelection, selectionChangeSet, stableCandidateId, stableSelectionId, validateResearchSelectionStore, type EvidenceTradeDto, type EvidenceUsageDto, type ExecutionScenarioSnapshot, type GenerationCandidateSnapshot, type GenerationSnapshot, type ResearchSelectionEvent, type ResearchSelectionStore, type SelectedStructure } from "./lib/research-selections";
import type { FuturesMarketSnapshot } from "./lib/research-selections";
import { CANONICAL_BTC_PERPETUAL } from "./lib/futures-baseline";
import { resolveApplicationBuild } from "./lib/build-provenance";
import { probeLocalPersistence, researchSelectionFailure } from "./lib/local-persistence";
import { CURRENT_RESEARCH_ENGINE_VERSIONS, diagnoseDerivedStaleness } from "./lib/research-refresh";
import { diagnoseMethodologyStaleness } from "./lib/configuration-identity";
import { buildResearchMarginSnapshot } from "./lib/research-margin";
import { analyzeDelayedExecution, delayedExecutionSnapshot, type DelayedExecutionAnalysis } from "./lib/delayed-execution";
import { buildModeledExecution } from "./lib/modeled-execution";
import { researchStateDirtiness, type CompletedGeneration } from "./lib/research-state";

type Section = "events" | "construction" | "contracts" | "analysis";
/** One execution scenario's independently-evaluated entry, path and outcomes. */
interface ResearchScenario {
  entry: ResearchValuation;
  path: EstimatedPathPoint[];
  outcomes: EstimatedOutcome[];
}

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
  /** Maker opportunity and taker execution, evaluated independently from disjoint tape evidence -- never one derived from the other. */
  researchByMode: { maker: ResearchScenario; taker: ResearchScenario };
  /** Contract, model and scenario execution statuses; no status is inferred from another. */
  researchLayers: ResearchEntryLayers;
  /** The currently displayed scenario (researchByMode[executionMode] at the time this result was computed). */
  researchEntry: ResearchValuation;
  researchPath: EstimatedPathPoint[];
  researchOutcomes: EstimatedOutcome[];
  delayedExecution: DelayedExecutionAnalysis;
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
const openingUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
type StatusRecord={status?:unknown;reason?:unknown};
const trackState=(value:unknown)=>{const x=(value&&typeof value==="object"?value:{}) as StatusRecord;const status=String(x.status??"not_evaluated");return{status,reason:typeof x.reason==="string"?x.reason:null,available:["valued","evaluated","available"].includes(status)}};
export function backtesterPersistedTrackStates(saved?:SelectedStructure){const delayed=(saved?.delayedExecution??{}) as Record<string,unknown>,modeled=(saved?.modeledExecution??{}) as Record<string,unknown>;return saved?{reference:trackState(saved.referenceValuation),immediateMaker:trackState(saved.executionScenarios.maker),immediateTaker:trackState(saved.executionScenarios.taker),delayedMaker:trackState(delayed.maker??saved.delayedExecution),delayedTaker:trackState(delayed.taker??saved.delayedExecution),modeledExpected:trackState(modeled.expected),modeledConservative:trackState(modeled.conservative)}:null}

function money(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : usd.format(value);
}

function openingDisplay(value:number|undefined,index:number|undefined,currency:"btc"|"usd-entry"){ if(currency==="btc")return btc(value); const converted=openingUsdEquivalent(value,index); return converted===undefined?"Unavailable · entry BTC index is missing or invalid":openingUsd.format(converted); }

function btc(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(6)} BTC`;
}

function pct(value?: number) {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}

function ExpiryPayoffChart({input}:{input:ExpiryPayoffInput}){
  const [currency,setCurrency]=useState<PayoffCurrency>("usd-cash-flow"),[selectedIndex,setSelectedIndex]=useState<number>(),[pinned,setPinned]=useState(false);
  const be=breakEven(input,currency),width=Math.abs(input.shortStrike-input.longStrike);
  // Canonical bounded structural risk, delivery fees and the global
  // fee-inclusive statement. The plotted curve below still uses expiryPayoff
  // with delivery fees at every finite settlement index, which is a genuine
  // scenario payoff and is deliberately unchanged.
  const summary=payoffInspectorSummary(input);
  const minimum=Math.max(.01,Math.min(input.shortStrike,input.longStrike,input.entryIndex,be?.index??Infinity)-Math.max(width*1.5,input.entryIndex*.08));
  const maximum=Math.max(input.shortStrike,input.longStrike,input.entryIndex,be?.index??0)+Math.max(width*1.5,input.entryIndex*.08);
  const points=Array.from({length:181},(_,i)=>{const expirationIndex=minimum+(maximum-minimum)*i/180;return expiryPayoff(input,expirationIndex,currency)});
  const all=[...points.map(p=>p.pnl),0],minP=Math.min(...all),maxP=Math.max(...all),range=maxP-minP||1,W=780,H=300,L=62,R=18,T=18,B=42;
  const x=(v:number)=>L+(v-minimum)/(maximum-minimum)*(W-L-R),y=(v:number)=>T+(maxP-v)/range*(H-T-B);
  const selected=selectedIndex===undefined?undefined:expiryPayoff(input,selectedIndex,currency),curve=points.map((p,i)=>`${i?"L":"M"}${x(p.expirationIndex).toFixed(2)},${y(p.pnl).toFixed(2)}`).join(" ");
  const inspect=(clientX:number,rect:DOMRect)=>{const viewX=(clientX-rect.left)/rect.width*W;setSelectedIndex(minimum+Math.max(0,Math.min(1,(viewX-L)/(W-L-R)))*(maximum-minimum))};
  const markers=[{label:"Short strike",axisLabel:"Short",value:input.shortStrike,className:"short"},{label:"Long strike",axisLabel:"Long",value:input.longStrike,className:"long"},{label:"Break-even",axisLabel:"Break-even",value:be?.index,className:"breakeven"},{label:"Entry",axisLabel:"Entry",value:input.entryIndex,className:"entry"}];
  const selectedMarker=selected&&markers.find(marker=>marker.value!==undefined&&Math.abs(marker.value-selected.expirationIndex)<=(maximum-minimum)/(W-L-R));
  const tooltipWidth=218,tooltipHeight=selectedMarker?62:48,selectedX=selected?x(selected.expirationIndex):0,selectedY=selected?y(selected.pnl):0;
  const tooltipX=selectedX+14+tooltipWidth<=W-4?selectedX+14:Math.max(4,selectedX-14-tooltipWidth),tooltipY=Math.max(4,Math.min(H-tooltipHeight-4,selectedY-tooltipHeight/2));
  const formattedBtc=selected?btc(selected.pnl).replace(/(\.\d*?[1-9])0+ BTC$/,"$1 BTC").replace(/\.0+ BTC$/," BTC"):"";
  return <section className="expiry-payoff"><div className="card-title-row"><div><p className="eyebrow">Theoretical payoff at expiration</p><h4>Credit-spread expiration profile</h4></div><div className="segmented" aria-label="Payoff currency"><button className={currency==="usd-cash-flow"?"active":""} onClick={()=>setCurrency("usd-cash-flow")}>USD cash-flow</button><button className={currency==="btc-settlement"?"active":""} onClick={()=>setCurrency("btc-settlement")}>BTC settlement</button></div></div><p className="fine-print">Theoretical expiration payoff based on the estimated entry. It is not proof of execution.</p>
    <div className="payoff-plot"><svg viewBox={`0 0 ${W} ${H}`} role="application" tabIndex={0} aria-label="Theoretical expiration payoff. Use arrow keys and Escape to inspect points." onPointerMove={e=>{if(!pinned)inspect(e.clientX,e.currentTarget.getBoundingClientRect())}} onPointerLeave={()=>{if(!pinned)setSelectedIndex(undefined)}} onClick={e=>{inspect(e.clientX,e.currentTarget.getBoundingClientRect());setPinned(true)}} onKeyDown={e=>{if(e.key==="Escape"){setPinned(false);setSelectedIndex(undefined);return}if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;e.preventDefault();setPinned(false);const step=(maximum-minimum)/180;setSelectedIndex(current=>e.key==="Home"?minimum:e.key==="End"?maximum:Math.max(minimum,Math.min(maximum,(current??minimum)+(e.key==="ArrowLeft"?-step:step))))}}><defs><linearGradient id="payoffArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4e9a75" stopOpacity=".28"/><stop offset="1" stopColor="#a95656" stopOpacity=".22"/></linearGradient></defs><line className="payoff-zero" x1={L} x2={W-R} y1={y(0)} y2={y(0)}/>{markers.map(m=>m.value!==undefined&&<g className={`payoff-marker ${m.className}`} key={m.label}><line x1={x(m.value)} x2={x(m.value)} y1={T} y2={H-B}/><text x={x(m.value)} y={H-B+15} textAnchor="middle">{m.axisLabel}</text></g>)}<path className="payoff-area" d={`${curve} L${x(maximum)},${y(0)} L${x(minimum)},${y(0)} Z`}/><path className="payoff-curve" d={curve}/>{selected&&<><g className="payoff-cursor"><line x1={selectedX} x2={selectedX} y1={T} y2={H-B}/><circle cx={selectedX} cy={selectedY} r="5"/></g><foreignObject className="payoff-tooltip-object" x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight}><div className="payoff-tooltip" role="tooltip" data-pinned={pinned||undefined}><strong>BTC index at expiration: {money(selected.expirationIndex)}</strong><span>Payoff: {currency==="usd-cash-flow"?openingUsd.format(selected.pnl):formattedBtc}</span>{selectedMarker&&<small>{selectedMarker.label}</small>}</div></foreignObject></>}<text className="axis-label" x={(L+W-R)/2} y={H-4} textAnchor="middle">BTC index at expiration</text><text className="axis-label" transform={`translate(14 ${(T+H-B)/2}) rotate(-90)`} textAnchor="middle">{currency==="usd-cash-flow"?"USD cash-flow PnL":"BTC settlement PnL"}</text></svg></div>
    <div className="payoff-inspector" aria-live="polite"><span><small>Payoff at selected terminal index</small><strong>{selected?`${money(selected.expirationIndex)} · ${currency==="usd-cash-flow"?openingUsd.format(selected.pnl):btc(selected.pnl)}`:"Hover or use arrow keys"}</strong></span><span><small>Maximum structural profit</small><strong>{summary.maximumProfit.usd===null?"Unavailable":currency==="usd-cash-flow"?openingUsd.format(summary.maximumProfit.usd):btc(summary.maximumProfit.btcAtReferenceIndex!)}</strong>{summary.maximumProfit.equalsNetCreditAtEntry&&<em className="payoff-basis">net opening credit at the entry index</em>}</span><span><small>Maximum structural loss</small><strong title={summary.structuralLoss.reason??undefined}>{summary.structuralLoss.usd===null?"Unavailable":currency==="usd-cash-flow"?openingUsd.format(-summary.structuralLoss.usd):btc(-summary.structuralLoss.btcAtReferenceIndex!)}</strong>{summary.structuralLoss.usd!==null&&<em className="payoff-basis">{currency==="usd-cash-flow"?"bounded structural risk; delivery fees excluded":`at reference index ${money(summary.structuralLoss.referenceIndex!)} · delivery fees excluded`}</em>}</span><span><small>Settlement fees</small><strong>{summary.settlementFees.scenarioFeesBtc===null?"Unavailable":`${btc(summary.settlementFees.scenarioFeesBtc)} · ${openingUsd.format(summary.settlementFees.scenarioFeesUsd!)}`}</strong><em className="payoff-basis">{summary.settlementFees.scenarioLabel??"scenario-specific"}</em></span><span><small>Fee-inclusive USD maximum</small><strong className={summary.settlementFees.globalFeeInclusiveMaximum==="unbounded"?"payoff-unbounded":undefined}>{summary.settlementFees.globalFeeInclusiveMaximum==="unbounded"?"Unbounded":"Bounded"}</strong><em className="payoff-basis" title={summary.settlementFees.globalFeeInclusiveMaximumReason??undefined}>{summary.settlementFees.globalFeeInclusiveMaximum==="unbounded"?"a fixed BTC delivery fee has no finite USD maximum as the settlement index grows":"delivery fees in USD are bounded across every settlement index"}</em></span><span><small>Break-even</small><strong>{be?`${money(be.index)} · ${be.method}`:"No crossing"}</strong></span><span><small>Amount</small><strong>{input.amount} contracts</strong></span><span><small>Gross / net entry credit</small><strong>{btc((input.shortEntryPremiumBtc-input.longEntryPremiumBtc)*input.amount)} / {btc((input.shortEntryPremiumBtc-input.longEntryPremiumBtc)*input.amount-input.openingFeesBtc)}</strong></span></div>
  </section>;
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
    return parseOhlcCandles(payload,start,end);
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
    return parseOhlcCandles({candles:rows.map(values => ({
      openTime: Number(values[0]), open: Number(values[1]), high: Number(values[2]), low: Number(values[3]), close: Number(values[4]), volume: Number(values[5]), closeTime: Number(values[6]),
    }))},start,end);
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

function ResearchValuationChart({path,outcomes,expiry,entryTimestamp}:{path:EstimatedPathPoint[];outcomes:EstimatedOutcome[];expiry?:number;entryTimestamp:number}) {
 const {width,height,plotLeft,plotRight,plotTop,plotBottom}=CHART_GEOMETRY;
 const [metric,setMetric]=useState<ResearchChartMetric>("pnl-usd"),[visible,setVisible]=useState<string[]>(["researchPnlUsd"]),[showOutcomes,setShowOutcomes]=useState(false),[cursor,setCursor]=useState<number>();
 const presentation=adaptResearchPath(path),available=RESEARCH_CHART_SERIES.filter(series=>series.metric===metric),active=available.filter(series=>visible.includes(series.key));
 const plotted=presentation.filter(point=>active.some(series=>typeof point.values[series.key]==="number"));
 const values=plotted.flatMap(point=>active.map(series=>point.values[series.key]).filter((value):value is number=>typeof value==="number"));
 const forceZero=metric==="pnl-usd"||metric==="pnl-btc",dataMin=Math.min(...values),dataMax=Math.max(...values),rawMin=forceZero?Math.min(0,dataMin):dataMin,rawMax=forceZero?Math.max(0,dataMax):dataMax,padding=((rawMax-rawMin)||Math.max(Math.abs(rawMax),1))*.08,min=rawMin-padding,max=rawMax+padding;
 const start=path[0]?.timestamp??0,end=path.at(-1)?.timestamp??start,x=(timestamp:number)=>timeX(timestamp,start,end,plotLeft,plotRight),y=(value:number)=>plotBottom-(value-min)/(max-min)*(plotBottom-plotTop);
 const selected=cursor===undefined||!path.length?undefined:nearestPoint(path,cursor),selectedPresentation=selected&&presentation[path.indexOf(selected)],ticks=Array.from({length:5},(_,i)=>min+(max-min)*i/4),dateTicks=Array.from({length:5},(_,i)=>start+(end-start)*i/4),markers=researchOutcomeGroups(outcomes,expiry,entryTimestamp),raw=rawResearchObservations(path);
 const switchMetric=(next:ResearchChartMetric)=>{setMetric(next);setVisible([next==="pnl-usd"?"researchPnlUsd":next==="pnl-btc"?"researchPnlBtc":next==="contract-values"?"netClosingCostBtc":"targetIndex"]);setCursor(undefined)};
 const inspect=(clientX:number,rect:DOMRect)=>setCursor(timestampAtX((clientX-rect.left)/rect.width*width,start,end,plotLeft,plotRight));
 const formatValue=(value:number)=>metric==="pnl-usd"?money(value):metric==="btc-index"?money(value):btc(value);
 const point=selected as EstimatedPathPoint|undefined,mark=point&&(point.rawEstimate??point.modelEstimate??point.ivNormalizedEstimate),resolution=point?.indexResolution;
 return <><div className="chart-controls"><div className="segmented" aria-label="Research chart metric">{([['pnl-usd','PnL · USD'],['pnl-btc','PnL · BTC'],['contract-values','Contract values · BTC'],['btc-index','BTC index']] as const).map(([value,label])=><button key={value} className={metric===value?"active":""} onClick={()=>switchMetric(value)}>{label}</button>)}</div><label className="chart-toggle"><input type="checkbox" checked={showOutcomes} onChange={event=>setShowOutcomes(event.target.checked)}/> Show outcome markers</label></div>
 <div className="chart-legend" aria-label="Visible Research chart series">{available.map(series=><label key={series.key}><input type="checkbox" checked={active.includes(series)} onChange={()=>setVisible(current=>current.includes(series.key)?current.filter(key=>key!==series.key):[...current,series.key])}/><i style={{background:series.color}}/>{series.label}</label>)}<label className="raw-observation-control" title={raw.length?`${raw.length} contemporaneous direct observation(s)`:"No contemporaneous direct raw observations exist for this path."}><input type="checkbox" checked={raw.length>0} disabled/>Raw observations · markers only</label></div>
 <div className="mini-chart research-interactive-chart" aria-label="Interactive Research valuation path chart">{!plotted.length?<p className="empty-note">No selected series has valuation data.</p>:<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="application" tabIndex={0} aria-label="Interactive Research valuation chart. Use arrow keys, Home, End, and Escape to inspect UTC timestamps." onPointerMove={event=>inspect(event.clientX,event.currentTarget.getBoundingClientRect())} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);inspect(event.clientX,event.currentTarget.getBoundingClientRect())}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();setCursor(undefined);return}if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)||!path.length)return;event.preventDefault();const index=point?path.indexOf(point):0,next=event.key==="Home"?0:event.key==="End"?path.length-1:Math.max(0,Math.min(path.length-1,index+(event.key==="ArrowLeft"?-1:1)));setCursor(path[next].timestamp)}}>
 {ticks.map(value=><g key={value}><line x1={plotLeft} x2={plotRight} y1={y(value)} y2={y(value)} className={forceZero&&Math.abs(value)<(max-min)/1000?"zero-line":"grid-line"}/><text x={plotLeft-7} y={y(value)+3} textAnchor="end" className="axis-label">{metric==="pnl-usd"?`$${Math.round(value).toLocaleString()}`:metric==="btc-index"?Math.round(value).toLocaleString():value.toFixed(4)}</text></g>)}
 {dateTicks.map((timestamp,index)=><g key={timestamp}><line x1={x(timestamp)} x2={x(timestamp)} y1={plotBottom} y2={plotBottom+5} className="axis-tick"/><text x={x(timestamp)} y={plotBottom+20} textAnchor={index===0?"start":index===dateTicks.length-1?"end":"middle"} className="axis-label">{new Date(timestamp).toLocaleDateString("en-GB",{timeZone:"UTC",month:"short",day:"2-digit"})}</text><text x={x(timestamp)} y={plotBottom+34} textAnchor={index===0?"start":index===dateTicks.length-1?"end":"middle"} className="axis-label">{new Date(timestamp).toLocaleTimeString("en-GB",{timeZone:"UTC",hour:"2-digit",minute:"2-digit",hour12:false})} UTC</text></g>)}<text x="4" y="12" className="axis-unit">{metric==="pnl-usd"?"USD":metric==="btc-index"?"USD / BTC":"BTC / contract"}</text>
 {showOutcomes&&markers.map(group=><g key={group.timestamp} className="exit-marker"><line x1={x(group.timestamp)} x2={x(group.timestamp)} y1={plotTop} y2={plotBottom}/><text x={x(group.timestamp)+5} y={plotTop+10}>{group.labels.join(" + ")}</text></g>)}
 {active.flatMap(series=>splitPresentationSeries(presentation,series.key).map((segment,index)=><polyline key={`${series.key}-${index}`} data-series={series.key} data-segment={index} points={segment.map(item=>`${x(item.timestamp)},${y(item.values[series.key]!)}`).join(" ")} className="chart-series" style={{stroke:series.color}}/>))}
 {raw.map(observation=><g key={`raw-${observation.timestamp}`} className="raw-observation-marker" data-observation="direct-vwap"><circle cx={x(observation.timestamp)} cy={plotBottom-6} r="4"/><title>{formatUtc(observation.timestamp)} · exact contemporaneous direct observation</title></g>)}
 {point&&selectedPresentation&&<g className="crosshair"><line x1={x(point.timestamp)} x2={x(point.timestamp)} y1={plotTop} y2={plotBottom}/>{active.map(series=>typeof selectedPresentation.values[series.key]==="number"&&<circle key={series.key} cx={x(point.timestamp)} cy={y(selectedPresentation.values[series.key]!)} r="4" style={{fill:series.color}}/>)}<text className="selected-time-label" x={x(point.timestamp)} y={plotBottom+10} textAnchor={x(point.timestamp)>plotRight-55?"end":x(point.timestamp)<plotLeft+55?"start":"middle"}>{formatUtc(point.timestamp)}</text></g>}</svg>}</div>
 {point?<section className="selected-point-inspector" aria-live="polite"><div className="inspector-grid"><strong>{formatUtc(point.timestamp)}{point.timestamp===expiry?" · expiry / settlement":""}</strong><span>Point role <b>{point.timestamp===entryTimestamp?"entry":point.timestamp===expiry?"expiry":"4H model point"}</b></span><span>Target BTC index <b>{money(point.targetIndex)}</b></span><span>Research PnL BTC / USD <b>{btc(point.estimatedNetPnlBtc)} / {money(researchPnlUsd(point))}</b></span><span>Selected value <b>{active.map(series=>`${series.label}: ${typeof selectedPresentation?.values[series.key]==="number"?formatValue(selectedPresentation.values[series.key]!):"—"}`).join(" · ")}</b></span><span>Short / long theoretical <b>{btc(point.shortModelPriceBtc)} / {btc(point.longModelPriceBtc)}</b></span><span>Net closing cost / contract <b>{btc(selectedPresentation?.values.netClosingCostBtc)}</b></span><span>Short IV / source <b>{point.shortIvDecimal===undefined?"—":`${(point.shortIvDecimal*100).toFixed(2)}%`} · {point.soldIvSource??"unavailable"}</b></span><span>Long IV / source <b>{point.longIvDecimal===undefined?"—":`${(point.longIvDecimal*100).toFixed(2)}%`} · {point.longIvSource??"unavailable"}</b></span><span>Index resolution <b>{resolution?.lookupMethod??"unavailable"}</b></span><span>Index source candle / distance <b>{resolution?.sourceCandleTimestamp?formatUtc(resolution.sourceCandleTimestamp):"—"} · {resolution?.distanceMs===undefined?"—":`${(resolution.distanceMs/60_000).toFixed(1)}m`}</b></span><span>Evidence <b>{point.estimateQuality} · {mark?.priceSource??"unavailable"}</b></span><span>Closing fees <b>{btc(point.closingFeesBtc)}</b></span><span>Outcomes <b>{markers.find(group=>group.timestamp===point.timestamp)?.labels.join(" + ")??"—"}</b></span>{point.status==="missing"&&<em>{point.unavailableReason} · missing {point.missingField??"unknown field"}</em>}<em>{mark?.qualityReason??"Theoretical Research estimate; not executable or confirmed."}</em></div></section>:<p className="inspector-instruction">Hover over the chart or use the arrow keys to inspect a point.</p>}</>;
}

function splitPresentationSeries(points:ReturnType<typeof adaptResearchPath>,key:string){const segments:typeof points[]=[];let segment:typeof points=[];for(const point of points){if(typeof point.values[key]==="number")segment.push(point);else if(segment.length){segments.push(segment);segment=[]}}if(segment.length)segments.push(segment);return segments}

/**
 * Same structure, same MR event, same contracts -- only the execution
 * assumption differs. Maker opportunity is evidence of a passive-fill
 * opportunity, never a confirmed fill; taker is the conservative tape-based
 * proxy. Shown side by side so neither silently stands in for the other.
 */
function ExecutionScenarioCompare({result}:{result:AnalysisResult}) {
 const {maker,taker}=result.researchByMode;
 const row=(label:string,scenario:ResearchScenario)=>{
  const e=scenario.entry;
  return <div className="scenario-compare-col" key={label}>
   <p className="eyebrow">{label}</p>
   {e.status==="unavailable"
    ? <p className="quality-reason">Not evaluated: {e.reason}</p>
    : <div className="scenario-metrics">
       <label>Status<strong className={flagClass(e.estimateQuality)}>{e.estimateQuality} · {e.priceSource==="direct-vwap"?"direct tape":"model"}</strong></label>
       <label>Sold / bought<strong>{btc(e.sold.priceBtcPerContract)} / {btc(e.bought.priceBtcPerContract)}</strong></label>
       <label>Net opening cash flow<strong>{btc(e.netOpeningCashFlowBtc)}</strong></label>
       <label>Opening fees<strong>{btc(e.openingFeesBtc)}</strong></label>
      </div>}
  </div>;
 };
 return <div className="scenario-compare card">
  <div className="card-title-row"><div><p className="eyebrow">Execution scenario comparison</p><h3>Maker opportunity vs. taker execution</h3></div></div>
  <p className="fine-print">Both scenarios hold the MR event, exact contracts, expiry, strikes and entry timestamp constant; only the execution assumption differs. Maker opportunity evidence is a passive-fill opportunity supported by historical tape, never a confirmed fill.</p>
  <div className="scenario-compare-grid">{row("Maker opportunity",maker)}{row("Taker (conservative)",taker)}</div>
 </div>;
}

function ResearchDetail({result,amount,onAmountChange,openingCurrency,compareExecutionModes}: {result:AnalysisResult;amount:string;onAmountChange:(value:string)=>void;openingCurrency:"btc"|"usd-entry";compareExecutionModes:boolean}) {
 const numeric=Number(amount), valid=Number.isFinite(numeric)&&numeric>0, base=result.researchEntry.status==="priced"?result.researchEntry:undefined;
 if(!base)return <div className="analysis-detail">{compareExecutionModes&&<ExecutionScenarioCompare result={result}/>}<div className="path-card card"><p className="empty-note">{result.researchEntry.status==="unavailable"?result.researchEntry.reason:"Research estimate unavailable."}</p></div></div>;
 const entry=valid?scaleResearchEstimate(base,numeric,result.observation.strategyConfiguration.executionRoute):base;
 const path=valid?scaleResearchPath(result.researchPath,base,numeric,result.observation.strategyConfiguration.executionRoute):result.researchPath;
 const outcomes=result.researchOutcomes.map(outcome=>{if(outcome.status!=="estimated"||outcome.estimatedNetPnl===undefined)return outcome;const estimatedNetPnl=outcome.estimatedNetPnl/base.amount*entry.amount;return{...outcome,estimatedNetPnl,estimatedNetPnlBtc:estimatedNetPnl,estimatedNetPnlUsd:outcome.conversionIndex===undefined?undefined:estimatedNetPnl*outcome.conversionIndex};});
 const points=path.filter((point):point is EstimatedPathPoint&{estimatedNetPnlBtc:number}=>point.status==="priced"&&point.estimatedNetPnlBtc!==undefined);
 const values=points.map(point=>researchPnlUsd(point)!); const best=values.length?Math.max(...values):undefined,statistics=researchPathStatistics(path,entry.targetTimestamp);
 const openingValue=(value:number|undefined)=>openingCurrency==="btc"?btc(value):(openingUsdEquivalent(value,entry.entryTargetIndex)===undefined?"Unavailable · entry BTC index is missing or invalid":openingUsd.format(openingUsdEquivalent(value,entry.entryTargetIndex)!));
 const maxLoss=Math.max(0,(result.spread.actualWidth??result.spread.targetWidth)/result.eventPrice*entry.amount-entry.netOpeningCashFlowBtc), openingBalance=entry.bought.priceBtcPerContract*entry.amount+entry.openingFeesBtc;
 return <div className="analysis-detail">{compareExecutionModes&&<ExecutionScenarioCompare result={result}/>}<div className="path-card card"><div className="card-title-row"><div><p className="eyebrow">Selected Research estimate · {formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</p><h3>Estimated 4H valuation path · PnL</h3></div><span className={flagClass(entry.estimateQuality)}>{entry.estimateQuality} estimate</span></div><p className="fine-print" title={MODEL_TOOLTIP}>{MODEL_TOOLTIP}</p><ResearchValuationChart path={path} outcomes={outcomes} expiry={result.spread.expiryTimestamp} entryTimestamp={entry.targetTimestamp}/><div className="path-metrics"><span><small>Best estimated unrealized PnL</small><strong className="positive">{money(best)}</strong></span><span><small>Worst Observed PnL</small><strong className="negative">{money(statistics.worstObservedPnlUsd??undefined)}</strong></span><span><small>MAE before profit</small><strong className="negative">{money(statistics.maeBeforeProfitUsd??undefined)}</strong></span><span><small>Evidence inclusion</small><strong>{statistics.status==="available"?`${statistics.pricedPoints} / ${path.length}`:"Unavailable"}</strong><small>{statistics.reason}</small></span></div><div className="table-scroll compact path-table"><table><thead><tr><th>Timestamp</th><th>Target index</th><th>Estimated net PnL</th><th>Evidence source</th><th>Quality and details</th></tr></thead><tbody>{path.slice(0,80).map(point=>{const mark=point.rawEstimate??point.modelEstimate??point.ivNormalizedEstimate;return <tr key={point.timestamp}><td>{formatUtc(point.timestamp)}</td><td>{money(point.targetIndex)}</td><td>{money(point.estimatedNetPnlBtc===undefined?undefined:researchPnlUsd(point))}</td><td>{mark?.priceSource??"unavailable"}</td><td><details className="evidence-details"><summary><span className={flagClass(point.estimateQuality==="unavailable"?"red":point.estimateQuality)}>{point.estimateQuality}</span></summary><p>{mark?.qualityReason??`${point.unavailableReason}: ${point.missingField??"unknown field"}`}</p>{mark&&<><p>Index {money(point.targetIndex)} · short IV {point.soldIvSource} {(point.shortIvDecimal===undefined?"—":`${(point.shortIvDecimal*100).toFixed(2)}%`)} · long IV {point.longIvSource} {(point.longIvDecimal===undefined?"—":`${(point.longIvDecimal*100).toFixed(2)}%`)}</p><p>Short theoretical {btc(point.shortModelPriceBtc)} · long theoretical {btc(point.longModelPriceBtc)} · close/contract {btc(point.closingSpreadValueBtcPerContract)}</p><p>±{mark.evidenceWindowMinutes}m · sold {mark.sold.instrumentName} @ {btc(mark.sold.priceBtcPerContract)} · bought {mark.bought.instrumentName} @ {btc(mark.bought.priceBtcPerContract)}</p>{mark.sold.model&&mark.bought.model&&<p>IV anchors · short {formatUtc(mark.sold.model.anchorTimestamp)} ({mark.sold.model.anchorAgeMinutes.toFixed(0)}m old, trade {mark.sold.model.anchorTradeId??"unidentified"}) · long {formatUtc(mark.bought.model.anchorTimestamp)} ({mark.bought.model.anchorAgeMinutes.toFixed(0)}m old, trade {mark.bought.model.anchorTradeId??"unidentified"})</p>}</>}</details></td></tr>})}</tbody></table></div></div><aside className="exit-card card"><p className="eyebrow">Research scenario</p><h3>Independent outcomes</h3><label className="scenario-input">Contract amount<input value={amount} onChange={event=>onAmountChange(event.target.value)} inputMode="decimal" /></label>{!valid&&<p className="quality-reason">Enter a finite, positive contract size.</p>}{entry.amountStepWarning&&<p className="quality-reason">{entry.amountStepWarning}</p>}{entry.liquidityWarning&&<p className="quality-reason">{entry.liquidityWarning}</p>}{openingCurrency==="usd-entry"&&<p className="conversion-note">USD equivalents use the BTC index at entry: {openingUsd.format(entry.entryTargetIndex)} · {formatUtc(entry.targetTimestamp)}.</p>}<div className="scenario-metrics"><label>Sold premium<strong>{openingValue(entry.sold.priceBtcPerContract*entry.amount)}</strong></label><label>Bought premium<strong>{openingValue(entry.bought.priceBtcPerContract*entry.amount)}</strong></label><label>Opening fees<strong>{openingValue(entry.openingFeesBtc)}</strong></label><label>Estimated gross entry<strong>{openingValue(entry.grossSpreadBtc)}</strong></label><label>Estimated net opening<strong>{openingValue(entry.netOpeningCashFlowBtc)}</strong></label><label>{openingCurrency==="usd-entry"?"Theoretical maximum loss · USD equivalent at entry index":"Theoretical maximum loss"}<strong>{openingValue(maxLoss)}</strong></label></div><div className="ledger-note"><strong>{openingCurrency==="usd-entry"?"Long-leg cash cost plus entry fees · USD equivalent at entry index":"Long-leg cash cost plus entry fees"}</strong><p>{openingValue(openingBalance)} · protective leg plus estimated opening fees</p></div><div className="exit-list">{outcomes.map(outcome=><div className={`exit-row ${outcome.status}`} key={outcome.label}><span>{outcome.label}<small>{outcome.valuationTimestamp?formatUtc(outcome.valuationTimestamp):outcome.status} · {outcome.evidenceSource??"unavailable"} · {outcome.estimateQuality}</small><small>{outcome.evidenceReason}</small></span><strong>{outcome.estimatedNetPnl===undefined?outcome.status:outcome.estimatedNetPnlUsd===undefined?`BTC ${outcome.estimatedNetPnl.toFixed(8)} · USD unavailable (${outcome.usdUnavailableReason})`:`${money(outcome.estimatedNetPnlUsd)} · USD at outcome index`}</strong></div>)}</div><div className="ledger-note"><strong>Research entry evidence</strong><p>{entry.sold.instrumentName} / {entry.bought.instrumentName}</p><p>±{entry.evidenceWindowMinutes}m · sold {entry.priceSource === "model-reconstructed" ? "model" : "VWAP"} {btc(entry.sold.unslippedPriceBtcPerContract)} · bought {entry.priceSource === "model-reconstructed" ? "model" : "VWAP"} {btc(entry.bought.unslippedPriceBtcPerContract)} · {entry.slippageBps} bps slippage · fees {btc(entry.openingFeesBtc)}</p>{entry.sold.model&&entry.bought.model&&<><p>Anchor IV: sold {(entry.sold.model.anchorIvDecimal*100).toFixed(2)}% at {formatUtc(entry.sold.model.anchorTimestamp)} · bought {(entry.bought.model.anchorIvDecimal*100).toFixed(2)}% at {formatUtc(entry.bought.model.anchorTimestamp)}</p><p>Target BTC index {money(entry.sold.model.targetIndex)} · DTE {entry.sold.model.dte.toFixed(3)} · {entry.sold.model.forwardRateAssumption}</p></>}<p>{entry.qualityReason}</p></div></aside></div>;
}


export function OptionsBacktester() {
  const stats = useMemo(() => durationSummary(), []);
  const [section, setSection] = useState<Section>("events");
  const [openingCurrency,setOpeningCurrency]=useState<"btc"|"usd-entry">("btc");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [events, setEvents] = useState<BacktestEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [datasets, setDatasets] = useState<TradeDatasetSummary[]>([]);
  const [dataset, setDataset] = useState<TradeDataset>();
  const [datasetDirty, setDatasetDirty] = useState(false);
  const [datasetStatus, setDatasetStatus] = useState("Loading project trade datasets…");
  const [persistenceAvailable, setPersistenceAvailable] = useState(true);
  const [selectionPersistenceAvailable,setSelectionPersistenceAvailable]=useState(true);
  const [selectionStore,setSelectionStore]=useState<ResearchSelectionStore>();
  const [draftSelection,setDraftSelection]=useState<{eventId:string;ids:Set<string>}>({eventId:"",ids:new Set()});
  const [selectionStatus,setSelectionStatus]=useState("");
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
  /**
   * Maker opportunity is the intended/preferred execution assumption -- an
   * opportunity supported by historical tape, never a guaranteed fill. Taker
   * is the conservative, tape-based robustness scenario. Both are always
   * evaluated independently (see researchByMode); this state only selects
   * which one the single-scenario detail panel currently shows.
   */
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("maker");
  const [compareExecutionModes, setCompareExecutionModes] = useState(false);
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
  const [hideDataUnavailable, setHideDataUnavailable] = useState(false);
  const [resolveStatus, setResolveStatus] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [analysisResults, setAnalysisResults] = useState<AnalysisResult[]>([]);
  const [completedGeneration,setCompletedGeneration]=useState<CompletedGeneration>();
  // Event-level perpetual benchmark evidence, retrieved alongside the option run and
  // persisted with the generation snapshot. Never derived from the index/spot path.
  const [showUnavailable,setShowUnavailable]=useState(false);
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
    () => buildExpiryCandidates(desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, executionMode, expirySelectionMode, pricingAssumption).map(spread=>{const venue="deribit" as const;const identified={...spread,venue};return{...identified,id:stableCandidateId(candidateIdentity(dataset?.datasetId??"unloaded",selectedEvent.id,identified))}}),
    [desiredSpreads, candidateManifests, effectiveEntryTimestamp, selectedEvent.entryPrice, inventory, executionMode, expirySelectionMode, pricingAssumption, dataset?.datasetId, selectedEvent.id],
  );
  const canonicalRetrievedSpreads=useMemo(()=>uniqueCanonicalSpreads(retrievedSpreads),[retrievedSpreads]);
  const visibleRetrievedSpreads = useMemo(() => visibleMatrixSpreads(canonicalRetrievedSpreads, hideRed, hideDataUnavailable), [canonicalRetrievedSpreads, hideRed, hideDataUnavailable]);
  const selectedSpread = visibleRetrievedSpreads.find(spread => spread.id === selectedSpreadId) ?? visibleRetrievedSpreads[0];
  const selectedAnalysis = analysisResults.find(result => result.spread.id === selectedResultId);
  const entryWindowRows = selectedSpread?.soldContract && selectedSpread?.boughtContract
    ? windowComparison(selectedSpread, effectiveEntryTimestamp, selectedEvent.entryPrice, executionMode)
    : [];
  const inventoryTrades = inventory.reduce((sum, series) => sum + series.trades.length, 0);
  const inventoryExpiries = new Set(inventory.map(series => series.expiryTimestamp)).size;
  const unavailableResults=analysisResults.filter(result=>result.researchLayers.model.status!=="priced");
  const filteredResults = analysisResults.filter(result => {
    if (result.researchLayers.model.status!=="priced") return showUnavailable;
    return true;
  });
  const aggregateGroups = useMemo(() => aggregateObservations(analysisResults.map(result => result.observation)), [analysisResults]);
  const savedEventSelection=selectionStore?.events.find(event=>event.eventId===selectedEvent.id);
  const savedSelectionIds=new Set(savedEventSelection?.selectedStructures.map(item=>item.candidateId)??[]);
  const currentCandidateIds=new Set(analysisResults.map(result=>result.spread.id));
  const draftSelectionIds=draftSelection.eventId===selectedEvent.id?draftSelection.ids:savedSelectionIds;
  const {selectionDirty,generationDirty,researchStateDirty}=researchStateDirtiness({eventId:selectedEvent.id,savedSelectionIds,draftSelectionIds,savedGeneration:savedEventSelection?.generationSnapshot,completedGeneration});
  const staleSelections=reconcileGeneratedSelection(savedSelectionIds,currentCandidateIds).stale;
  const savedCurrentlyUnavailable=analysisResults.filter(result=>savedSelectionIds.has(result.spread.id)&&result.researchLayers.model.status!=="priced");
  const persistedSelectionCount=selectionStore?.events.reduce((sum,event)=>sum+event.selectedStructures.length,0)??0;
  const persistedResearchEventCount=selectionStore?.events.length??0;
  const staleDerivedCount=selectionStore?.events.reduce((sum,event)=>sum+event.selectedStructures.filter(item=>diagnoseDerivedStaleness(item).stale).length,0)??0;
  // Methodology staleness is separate from engine-version staleness: a stale
  // methodology cannot be migrated, only regenerated, and it blocks aggregate export.
  const methodologyStaleness=useMemo(()=>diagnoseMethodologyStaleness((selectionStore?.events??[]).map(event=>({eventId:event.eventId,configuration:event.generationSnapshot.configuration}))),[selectionStore]);

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

  function clearEventAnalysis() { setAnalysisResults([]); setCompletedGeneration(undefined); setCandidateManifests([]); setInventory([]); setSelectedSpreadId(undefined); setSelectedResultId(undefined); setExpandedResultIds([]); setScenario(undefined); }

  async function loadResearchSelections(datasetId:string){try{const response=await fetch(`/__local/research-selections/${encodeURIComponent(datasetId)}`);const raw=await response.json();if(!response.ok)throw new Error(raw.error??`Research selections could not be loaded (HTTP ${response.status}).`);const checked=validateResearchSelectionStore(raw);if(!checked.ok)throw new Error(checked.errors.map(e=>`${e.path}: ${e.message}`).join(" | "));setSelectionStore(checked.store);setSelectionPersistenceAvailable(true);setSelectionStatus("");}catch(error){setSelectionStore(undefined);const failure=researchSelectionFailure(error,await probeLocalPersistence());setSelectionPersistenceAvailable(!failure.unavailable);setSelectionStatus(failure.message);}setDraftSelection({eventId:"",ids:new Set()});}

  async function refreshDatasets(preferredId?: string) {
    const response = await fetch("/__local/trade-datasets");
    if (!response.ok) throw new Error("Persistent dataset editing requires the local application server.");
    const payload = await response.json() as {datasets: TradeDatasetSummary[]}; setDatasets(payload.datasets);
    const remembered = preferredId ?? window.localStorage.getItem("options-lab-trade-dataset");
    const id = payload.datasets.some(item=>item.datasetId===remembered) ? remembered! : payload.datasets.some(item=>item.datasetId==="default-sample-trades") ? "default-sample-trades" : payload.datasets[0]?.datasetId;
    if (!id) throw new Error("No valid project trade datasets were found."); await loadDataset(id, false);
  }
  async function loadDataset(id:string, guard=true) { if (guard && !canLeaveDirty(datasetDirty||researchStateDirty,()=>window.confirm("Discard unsaved dataset or research-selection changes and switch datasets?"))) return; const response=await fetch(`/__local/trade-datasets/${encodeURIComponent(id)}`); const payload=await response.json(); if(!response.ok) throw new Error(payload.error??"Dataset could not be loaded."); const checked=validateTradeDataset(payload); if(!checked.ok) throw new Error(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | ")); const loaded=checked.dataset; setDataset(loaded); setEvents(loaded.trades); setSelectedEventId(loaded.trades[0]?.id??""); setDatasetDirty(false); clearEventAnalysis(); await loadResearchSelections(id); window.localStorage.setItem("options-lab-trade-dataset",id); setDatasetStatus(""); }

  function toggleResearchSelection(candidateId:string,selected:boolean){setDraftSelection(current=>{const next=current.eventId===selectedEvent.id?new Set(current.ids):new Set(savedSelectionIds);if(selected)next.add(candidateId);else next.delete(candidateId);return{eventId:selectedEvent.id,ids:next};});}
  function switchEvent(eventId:string){if(eventId===selectedEvent.id)return;if(!canLeaveDirty(researchStateDirty,()=>window.confirm("Discard unsaved research-selection changes and switch events?")))return;const nextSaved=selectionStore?.events.find(event=>event.eventId===eventId)?.selectedStructures.map(item=>item.candidateId)??[];setDraftSelection({eventId,ids:new Set(nextSaved)});setSelectedEventId(eventId);clearEventAnalysis();}
  /** Builds one execution scenario's persisted snapshot, or an explicit not_evaluated record -- never a fabricated one. */
  function buildScenarioSnapshot(candidateId:string,mode:ExecutionMode,scenario:ResearchScenario,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>):ExecutionScenarioSnapshot{
    if(scenario.entry.status!=="priced")return{status:"unavailable",reason:scenario.entry.reason,entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]};
    return{status:"evaluated",reason:null,
      entrySnapshot:compactEntryEconomics("deribit",candidateId,scenario.entry,usages,catalog,mode),
      valuationPathSnapshot:scenario.path.map(point=>compactValuationPoint("deribit",candidateId,point,usages,catalog,mode)),
      outcomeSnapshots:scenario.outcomes.map(outcome=>compactOutcomeSnapshot("deribit",candidateId,outcome,usages,catalog,mode))};
  }
  function buildCompletedGeneration(results:AnalysisResult[],candles:Candle[],futuresMarket:FuturesMarketSnapshot|undefined,generatedAtUtc:string):CompletedGeneration{
    const byId=new Map(results.map(result=>[result.spread.id,result]));
    const candidates:GenerationCandidateSnapshot[]=canonicalRetrievedSpreads.map(spread=>{const result=byId.get(spread.id),priced=result?.researchEntry.status==="priced";return{candidateId:spread.id,venue:"deribit",selected:false,status:priced?"priced":"unavailable",availabilityReasons:priced?[]:[result?.researchEntry.status==="unavailable"?result.researchEntry.reason:spread.retrievalNote||"Candidate could not be economically valued in this generation."],targetHorizon:spread.targetDte,eligibleDteRange:{min:spread.dteMin??null,max:spread.dteMax??null},actualExpiryTimestamp:spread.expiryTimestamp??null,actualDte:spread.actualDte??null,requestedStrikes:{short:spread.soldStrike,long:spread.boughtStrike,width:spread.targetWidth},actualStrikes:{short:spread.resolvedSoldStrike??null,long:spread.resolvedBoughtStrike??null,width:spread.actualWidth??null},structure:spread.structure,optionType:spread.optionType,strikeMethod:spread.buffered?"buffered":"anchor",entryQuality:result?.eventQuality??spread.entryLiquidityQuality??null};});
    const configuration={applicationBuild:resolveApplicationBuild((import.meta as ImportMeta & {env?:Record<string,string>}).env),pricingEngineVersion:"research-estimate-v1",qualityRulesVersion:"entry-liquidity-v1",feeScheduleVersion:"deribit-standard-inverse-v1",dteWindows:canonicalJson(dteTolerances),expirySelectionMode,executionMode,pricingAssumption,pricingTracks:[...pricingModes],historicalEvidenceWindows:canonicalJson(modelHistoricalEvidenceWindows()),synchronizationThresholds:canonicalJson(EXECUTION_TIMING_METADATA),qualityThresholds:canonicalJson({source:"entry-liquidity-v1"}),feeAssumptions:canonicalJson({tier:"standard",route:comboExecution?"combo":"legs"}),settlementRules:canonicalJson({source:"deribit-delivery-price",fallback:"unavailable"}),valuationInterval:"4h",modelAssumptions:canonicalJson({model:"Black-Scholes reconstructed IV",rate:0}),generatedAtUtc};
    const snapshot:GenerationSnapshot={generatedAtUtc,configuration,candidates,underlyingHourlyPath:candles,...(futuresMarket?{futuresMarket}:{})};
    return{eventId:selectedEvent.id,snapshot};
  }
  async function saveResearchSelections(requestedDraft:ReadonlySet<string>=draftSelectionIds){
    if(!dataset||!selectionStore||!selectionPersistenceAvailable)return;
    const savedAtStart=new Set(savedSelectionIds),draftAtStart=new Set(requestedDraft);
    const {toAdd,toRemove,toKeep}=selectionChangeSet(savedAtStart,draftAtStart);
    if(!toAdd.size&&!toRemove.size&&!generationDirty)return;
    try{
      const now=new Date().toISOString(),byId=new Map(analysisResults.map(result=>[result.spread.id,result]));
      for(const candidateId of toAdd){
        const result=byId.get(candidateId);
        if(!result)throw new Error(`Cannot add ${candidateId}: it is not generated for ${selectedEvent.id}. Regenerate this exact candidate before selecting it.`);
        if(result.researchLayers.structural.status!=="resolved"||result.researchLayers.model.status!=="priced"&&result.researchLayers.maker.status!=="available"&&result.researchLayers.taker.status!=="available"){
          throw new Error(`Cannot add ${candidateId}: neither an execution-independent model valuation nor a raw scenario is priced (${result.researchLayers.structural.reason}; ${result.researchLayers.model.reason}).`);
        }
      }
      const eventEvidenceCatalog=new Map((savedEventSelection?.evidenceCatalog??[]).map(item=>[item.evidenceId,item]));
      const retained=new Map((savedEventSelection?.selectedStructures??[]).filter(item=>toKeep.has(item.candidateId)).map(item=>[item.candidateId,item]));
      const additions:SelectedStructure[]=[...toAdd].sort().map(candidateId=>{const result=byId.get(candidateId)!;const spread=result.spread,usages:EvidenceUsageDto[]=[];const executionScenarios={maker:buildScenarioSnapshot(candidateId,"maker",result.researchByMode.maker,usages,eventEvidenceCatalog),taker:buildScenarioSnapshot(candidateId,"taker",result.researchByMode.taker,usages,eventEvidenceCatalog)};const referenceTrack=result.researchEntry.status==="priced"?{status:"evaluated" as const,reason:null,entrySnapshot:compactEntryEconomics("deribit",candidateId,result.researchEntry,usages,eventEvidenceCatalog,null),valuationPathSnapshot:result.researchPath.map(point=>compactValuationPoint("deribit",candidateId,point,usages,eventEvidenceCatalog,null)),outcomeSnapshots:result.researchOutcomes.map(outcome=>compactOutcomeSnapshot("deribit",candidateId,outcome,usages,eventEvidenceCatalog,null))}:{status:"unavailable" as const,reason:result.researchLayers.model.reason,entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]};const rawPriced=result.researchLayers.maker.rawVwapStatus==="priced"||result.researchLayers.taker.rawVwapStatus==="priced";const contractMetadata=(contract:typeof spread.soldContract)=>contract?{instrumentName:contract.instrumentName,creationTimestamp:contract.creationTimestamp??null,expirationTimestamp:contract.expiryTimestamp,strike:contract.strike,optionType:contract.optionType,contractSize:1,source:contract.creationTimestamp!==undefined?"deribit-instrument-metadata":"stored-contract-series",retrievedAtUtc:now,authoritative:contract.creationTimestamp!==undefined}:null;const contractsResolved=Boolean(spread.soldContract&&spread.boughtContract&&spread.retrievalStatus==="ready");const exact=contractsResolved&&spread.resolvedSoldStrike===spread.soldStrike&&spread.resolvedBoughtStrike===spread.boughtStrike;const contractResolution={status:contractsResolved?(exact?"exact_resolved" as const:"nearest_listed_resolved" as const):spread.soldListingStatus==="not-listed"||spread.boughtListingStatus==="not-listed"?"confirmed_not_listed" as const:spread.retrievalStatus==="partial"?"retrieval_failure" as const:"metadata_unavailable" as const,reason:contractsResolved?null:spread.retrievalNote,short:contractMetadata(spread.soldContract),long:contractMetadata(spread.boughtContract)};const referenceValuation=result.researchEntry.status==="priced"?{status:"valued" as const,reason:null,source:referenceValuationSourceOf(result.researchEntry),entrySnapshot:referenceTrack.entrySnapshot,valuationPathSnapshot:referenceTrack.valuationPathSnapshot,outcomeSnapshots:referenceTrack.outcomeSnapshots,provenance:canonicalJson({executionIndependent:true,requestedAmountDoesNotGate:true,quality:result.researchEntry.estimateQuality})}:{status:"unavailable" as const,reason:result.researchLayers.model.reason,source:"unavailable" as const,entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[],provenance:canonicalJson({executionIndependent:true})};const delayedExecution=delayedExecutionSnapshot(result.delayedExecution,result.researchEntry.status==="priced"?result.researchEntry.netOpeningCashFlowBtc:undefined);const modeledExecution=buildModeledExecution(referenceValuation);return{selectionId:stableSelectionId(selectedEvent.id,"deribit",candidateId),eventId:selectedEvent.id,candidateId,venue:"deribit" as const,selectedAtUtc:now,quantity:amount,strategyVariantId:candidateId,contractResolution,referenceValuation,delayedExecution:canonicalJson(delayedExecution),modeledExecution,selectionProvenance:rawPriced?"raw-priced" as const:"model-only-diagnostic" as const,statusLayers:canonicalJson(result.researchLayers),candidateSnapshot:compactCandidateMetadata({venue:"deribit",contractStyle:"inverse BTC option",structure:spread.structure,spreadKind:spread.spreadKind,optionType:spread.optionType,targetDte:spread.targetDte,expiryTimestamp:spread.expiryTimestamp??null,actualDte:spread.actualDte??null,shortStrike:spread.resolvedSoldStrike??spread.soldStrike,longStrike:spread.resolvedBoughtStrike??spread.boughtStrike,actualWidth:spread.actualWidth??null,instruments:{short:spread.soldContract?.instrumentName??null,long:spread.boughtContract?.instrumentName??null},quality:result.eventQuality,qualityReasonCodes:[],settlementProvenance:compactSettlementProvenance(spread,now)}),executionScenarios,derivedVersions:{immediateExecution:"immediate-scenario-v2",referenceValuation:CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation,delayedExecution:"causal-delayed-v2",settlementAccounting:SETTLEMENT_ACCOUNTING_VERSION,margin:"deribit-standard-margin-v2"},derivedRefreshedAtUtc:now,marginSnapshot:null,evidenceTradeSnapshots:[],evidenceUsages:usages};}).map(structure=>({...structure,marginSnapshot:compactMarginResult(buildResearchMarginSnapshot(structure))}));
      const selectedStructures=[...retained.values(),...additions].sort((a,b)=>a.candidateId.localeCompare(b.candidateId));
      const currentGeneration=(completedGeneration?.eventId===selectedEvent.id?completedGeneration.snapshot.candidates:[]).map(candidate=>({...candidate,selected:draftAtStart.has(candidate.candidateId)}));
      // Retained stale snapshots remain exportable only while explicitly present in the draft.
      // Preserve their exact prior denominator row; identity is never remapped to a new candidate.
      const generatedIds=new Set(currentGeneration.map(candidate=>candidate.candidateId));
      const retainedStale=(savedEventSelection?.generationSnapshot.candidates??[]).filter(candidate=>toKeep.has(candidate.candidateId)&&!generatedIds.has(candidate.candidateId)).map(candidate=>({...candidate,selected:true}));
      const generationSnapshot=completedGeneration?.eventId===selectedEvent.id?{...completedGeneration.snapshot,candidates:[...currentGeneration,...retainedStale]}:savedEventSelection!.generationSnapshot;
      const runtimeEventRecord:ResearchSelectionEvent={eventId:selectedEvent.id,sourceRun:savedEventSelection?.sourceRun??canonicalJson({event:eventReference(selectedEvent),savedAtUtc:now}),generationSnapshot,selectedStructures,evidenceCatalog:[...eventEvidenceCatalog.values()].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId))};
      const eventRecord=compactResearchSelectionEvent(runtimeEventRecord);const requestBody=JSON.stringify(eventRecord),requestBytes=new TextEncoder().encode(requestBody).byteLength;
      const response=await fetch(`/__local/research-selections/${encodeURIComponent(dataset.datasetId)}/events/${encodeURIComponent(selectedEvent.id)}`,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":selectionStore.updatedAtUtc},body:requestBody});const raw=await response.json().catch(()=>({}));if(!response.ok){const context=response.status===413?`Research save failed · ${(requestBytes/1_000_000).toFixed(1)} MB request exceeds 10.0 MB local persistence limit`:response.status===409?"Conflict: reload selections and retry":response.status===400?"Validation failed":"Persistence failed";throw new Error(`${context}. ${raw.details?.map?.((e:{path:string;message:string})=>`${e.path}: ${e.message}`).join(" | ")??raw.error??"Research selections were not saved."}`)}const checked=validateResearchSelectionStore(raw.store??raw);if(!checked.ok)throw new Error("Server returned an invalid selection store.");setSelectionStore(checked.store);setDraftSelection({eventId:selectedEvent.id,ids:new Set(draftAtStart)});setSelectionStatus(`Saved current generation state: ${toAdd.size} new structure${toAdd.size===1?"":"s"}, retained ${toKeep.size}, removed ${toRemove.size}.`);
    }catch(error){setDraftSelection({eventId:selectedEvent.id,ids:draftAtStart});const failure=researchSelectionFailure(error,await probeLocalPersistence());setSelectionPersistenceAvailable(!failure.unavailable);setSelectionStatus(`${failure.message} Save failed; no changes were persisted. Unsaved selections remain selected; retry is available.`);}
  }
  async function clearSavedSelection(){if(!savedSelectionIds.size)return;if(!window.confirm(`Clear ${savedSelectionIds.size} saved structures for ${selectedEvent.id}? The source backtest event will not be deleted.`))return;const empty=new Set<string>();setDraftSelection({eventId:selectedEvent.id,ids:empty});await saveResearchSelections(empty);}
  async function saveDataset() { if(!dataset) return; const draft={...dataset,trades:events}; const checked=validateTradeDataset(draft); if(!checked.ok){setDatasetStatus(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | "));return;} try { const response=await fetch(`/__local/trade-datasets/${encodeURIComponent(dataset.datasetId)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(checked.dataset)}); const payload=await response.json(); if(!response.ok) throw new Error(payload.details?.map((e:{tradeId?:string;path:string;message:string})=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | ")??payload.error); setDataset(payload);setEvents(payload.trades);setDatasetDirty(false);setDatasetStatus(`Saved to data/trade-datasets/${dataset.datasetId}.json`);await refreshDatasetList(); } catch(error){setDatasetStatus(error instanceof Error?error.message:"Save failed.");} }
  async function refreshDatasetList(){const response=await fetch("/__local/trade-datasets");if(response.ok)setDatasets((await response.json()).datasets);}
  function exportDataset(){if(!dataset||datasetDirty)return;const blob=new Blob([JSON.stringify(dataset,null,2)+"\n"],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=`${dataset.datasetId}.json`;link.click();URL.revokeObjectURL(url);}
  async function exportResearchBundle(){if(!dataset||!persistedResearchEventCount||!selectionPersistenceAvailable)return;const pending=selectionStore?.events.flatMap(event=>event.selectedStructures).filter(structure=>{const modeled=(structure.modeledExecution??{}) as Record<string,unknown>,expected=(modeled.expected??{}) as StatusRecord,conservative=(modeled.conservative??{}) as StatusRecord;return !structure.derivedVersions?.modeledExecution||expected.status==="not_evaluated"||conservative.status==="not_evaluated";}).length??0;if(pending){setSelectionStatus(`Empirical execution recompute required for ${pending} selected structures. Run the local research recompute with the execution estimator before exporting.`);return}setSelectionStatus("Validating saved research bundle…");try{const response=await fetch(`/__local/research-bundle/${encodeURIComponent(dataset.datasetId)}`);if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error??"Research bundle export failed.")}if(response.headers.get("Content-Type")?.split(";",1)[0].trim().toLowerCase()!=="application/zip")throw new Error("Research bundle export returned an invalid content type.");const bytes=await response.arrayBuffer(),signature=new Uint8Array(bytes,0,Math.min(4,bytes.byteLength));if(bytes.byteLength<4||signature[0]!==0x50||signature[1]!==0x4b||signature[2]!==0x03||signature[3]!==0x04)throw new Error("Research bundle export returned an invalid ZIP file.");const blob=new Blob([bytes],{type:"application/zip"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]??`research-bundle-${dataset.datasetId}.zip`;link.click();window.setTimeout(()=>URL.revokeObjectURL(url),0);setSelectionStatus(`Exported ${persistedSelectionCount} persisted selected structures across the current dataset.`)}catch(error){const message=error instanceof Error?error.message:"Research bundle export failed.";setSelectionStatus(message)}}
  async function chooseImport(file?:File){if(!file)return;if(!canLeaveDirty(datasetDirty,()=>window.confirm("Discard unsaved changes before importing?"))){if(importRef.current)importRef.current.value="";return;}try{const parsed=JSON.parse(await file.text());const checked=validateTradeDataset(parsed);if(!checked.ok)throw new Error(checked.errors.map(e=>`${e.tradeId??"dataset"} · ${e.path}: ${e.message}`).join(" | "));setImportDraft(checked.dataset);setImportSummary(undefined);setDatasetStatus("");}catch(error){setDatasetStatus(error instanceof Error?error.message:"Malformed JSON.");}}
  async function previewImport(){if(!importDraft||!dataset)return;const response=await fetch("/__local/trade-datasets/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataset:importDraft,mode:importMode,currentDatasetId:dataset.datasetId,conflictResolution,preview:true})});const payload=await response.json();if(!response.ok){setDatasetStatus(payload.error);return;}setImportSummary(payload.summary);}
  async function confirmImport(){if(!importDraft||!dataset||!importSummary)return;const response=await fetch("/__local/trade-datasets/import",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({dataset:importDraft,mode:importMode,currentDatasetId:dataset.datasetId,conflictResolution})});const payload=await response.json();if(!response.ok){setDatasetStatus(payload.error);return;}setImportDraft(undefined);setImportSummary(undefined);await refreshDatasets(payload.dataset.datasetId);setDatasetStatus(importMode==="separate"?`Imported as data/trade-datasets/${payload.filename}`:`Combined import saved to data/trade-datasets/${payload.filename}`);}

  useEffect(()=>{queueMicrotask(async()=>{try{const response=await fetch("/__local/trade-datasets");if(!response.ok)throw new Error("Persistent dataset editing requires the local application server.");const payload=await response.json() as {datasets:TradeDatasetSummary[]};setDatasets(payload.datasets);const remembered=window.localStorage.getItem("options-lab-trade-dataset");const id=payload.datasets.some(item=>item.datasetId===remembered)?remembered!:payload.datasets.some(item=>item.datasetId==="default-sample-trades")?"default-sample-trades":payload.datasets[0]?.datasetId;if(!id)throw new Error("No valid project trade datasets were found.");const datasetResponse=await fetch(`/__local/trade-datasets/${encodeURIComponent(id)}`),raw=await datasetResponse.json();if(!datasetResponse.ok)throw new Error(raw.error??"Dataset could not be loaded.");const checked=validateTradeDataset(raw);if(!checked.ok)throw new Error(checked.errors.map(error=>`${error.tradeId??"dataset"} · ${error.path}: ${error.message}`).join(" | "));const loaded=checked.dataset;setDataset(loaded);setEvents(loaded.trades);setSelectedEventId(loaded.trades[0]?.id??"");setDatasetDirty(false);setAnalysisResults([]);setCandidateManifests([]);setInventory([]);setSelectedSpreadId(undefined);setSelectedResultId(undefined);setScenario(undefined);await loadResearchSelections(id);window.localStorage.setItem("options-lab-trade-dataset",id);setDatasetStatus("");}catch(error){setPersistenceAvailable(false);setDatasetStatus(error instanceof Error?error.message:"Persistent dataset editing requires the local application server.");}});},[]); // Startup discovery intentionally runs once and uses only state setters.

  function patchEvent(patch: Partial<BacktestEvent>) {
    setEvents(current => current.map(event => event.id === selectedEvent.id ? { ...event, ...patch } : event));
    setDatasetDirty(true);
    setAnalysisResults([]);
    setCandidateManifests([]);
    setInventory([]);
  }

  /**
   * Renaming the canonical event id.
   *
   * `stableCandidateId` bakes the event id into every candidate id and
   * `stableSelectionId` embeds it again, so a bare field write would leave the
   * saved structures pointing at an identity that no longer exists. The rename
   * is therefore propagated through the whole selection store and persisted in
   * the same action; if that persistence fails the id change is rolled back
   * rather than leaving the two stores disagreeing.
   */
  async function renameSelectedEvent(nextId: string) {
    const previousId = selectedEvent.id, trimmed = nextId.trim();
    if (!trimmed || trimmed === previousId) return;
    if (events.some(event => event.id === trimmed)) { setDatasetStatus(`Event ID "${trimmed}" is already used by another event.`); return; }
    const store = selectionStore, propagated = store ? renameResearchSelectionEvent(store, previousId, trimmed) : undefined;
    setEvents(current => current.map(event => event.id === previousId ? { ...event, id: trimmed } : event));
    setSelectedEventId(trimmed);
    setDatasetDirty(true);
    clearEventAnalysis();
    if (!store || propagated === store || !selectionPersistenceAvailable || !dataset) { setDatasetStatus(""); return; }
    try {
      const response = await fetch(`/__local/research-selections/${encodeURIComponent(dataset.datasetId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(propagated) });
      const raw = await response.json();
      if (!response.ok) throw new Error(raw.error ?? "Research selections could not be updated for the new event ID.");
      const checked = validateResearchSelectionStore(raw);
      if (!checked.ok) throw new Error("Server returned an invalid selection store.");
      setSelectionStore(checked.store);
      setDatasetStatus(`Event renamed to ${trimmed}; ${propagated!.events.find(e => e.eventId === trimmed)?.selectedStructures.length ?? 0} saved structures were repointed.`);
    } catch (error) {
      setEvents(current => current.map(event => event.id === trimmed ? { ...event, id: previousId } : event));
      setSelectedEventId(previousId);
      setDatasetStatus(`${error instanceof Error ? error.message : "Rename failed."} The event ID was reverted so saved structures keep matching.`);
    }
  }

  /**
   * Deleting an event outright.
   *
   * Real deletion, not a UI hide: the event leaves the dataset AND the research
   * selection store. Every canonical bundle table (availability, candidates,
   * valuations, outcomes, margin scenarios, evidence, futures) is derived from
   * the selection store's events when the bundle is built, so removing it there
   * is what cascades -- there is nothing left to filter out of the export.
   * Shared raw market data is untouched: candles and contract tapes are fetched
   * from the venue and are never owned by an event.
   */
  async function deleteSelectedEvent() {
    const target = selectedEvent, savedStructures = selectionStore?.events.find(event => event.eventId === target.id)?.selectedStructures.length ?? 0;
    const detail = savedStructures > 0
      ? `Delete "${target.label}" and its ${savedStructures} saved research structure(s)? Their valuations, outcomes and maker/taker scenarios are removed from the research bundle as well. This cannot be undone.`
      : `Delete "${target.label}"? This cannot be undone.`;
    if (!window.confirm(detail)) return;
    const remaining = events.filter(event => event.id !== target.id);
    setEvents(remaining);
    setSelectedEventId(remaining[0]?.id ?? "");
    setDatasetDirty(true);
    clearEventAnalysis();
    if (!dataset || !selectionStore || !selectionPersistenceAvailable) { setDatasetStatus(`Removed ${target.id}. Save the dataset to persist the deletion.`); return; }
    try {
      const response = await fetch(`/__local/research-selections/${encodeURIComponent(dataset.datasetId)}/events/${encodeURIComponent(target.id)}`, { method: "DELETE", headers: { "If-Match": selectionStore.updatedAtUtc } });
      const raw = await response.json();
      if (!response.ok) throw new Error(raw.error ?? "Research selections could not be updated.");
      const checked = validateResearchSelectionStore(raw.store ?? raw);
      if (!checked.ok) throw new Error("Server returned an invalid selection store.");
      setSelectionStore(checked.store);
      setDatasetStatus(`Removed ${target.id} and ${savedStructures} saved structure(s). Save the dataset to persist the event deletion.`);
    } catch (error) {
      setDatasetStatus(`${error instanceof Error ? error.message : "Research selection cleanup failed."} Reload before exporting a research bundle.`);
    }
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

  /**
   * Retrieve the event's Deribit BTC perpetual evidence. A failure here never
   * fails the option run: the baseline is simply absent, and the exporter marks
   * it unavailable with a reason rather than substituting the index path.
   */
  async function loadPerpetualBaseline(entryTimestamp: number, end: number): Promise<FuturesMarketSnapshot | undefined> {
    try {
      const response = await fetch("/__deribit/perpetual/baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: CANONICAL_BTC_PERPETUAL,
          start: entryTimestamp - 3_600_000,
          end,
          resolutionMinutes: 60,
          orderTimestamp: entryTimestamp,
          direction: selectedEvent.direction,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Perpetual baseline retrieval failed.");
      const snapshot = payload.snapshot as FuturesMarketSnapshot | undefined;
      return snapshot?.reference?.length ? snapshot : undefined;
    } catch {
      return undefined;
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
    const amountError=validateResearchAmount(amount);
    if(amountError){setAnalysisStatus(amountError);return;}
    const runnable = canonicalRetrievedSpreads.filter(spread => spread.selectedForTest || spread.expiryRank === 1);
    if (!runnable.length) {
      const completed=buildCompletedGeneration([],[],undefined,new Date().toISOString());
      setAnalysisResults([]);
      setCompletedGeneration(completed);
      setAnalysisStatus(`${completed.snapshot.candidates.length} generated candidates recorded as unavailable · no option structure could be economically valued. The denominator can still be saved.`);
      jump("analysis");
      return;
    }
    setAnalysisStatus("Loading BTC index path and valuing every generated spread…");
    try {
      const entryTimestamp = selectedEvent.entryTimestamp ?? effectiveEntryTimestamp;
      const expiries=runnable.map(spread=>spread.expiryTimestamp).filter((value):value is number=>value!==undefined&&Number.isFinite(value));
      if(!expiries.length)throw new Error("No resolved expiry is available for the underlying path.");
      const maxExpiry = Math.max(...expiries);
      const candleStart=entryTimestamp-3_600_000,candleEnd=maxExpiry+3_600_000;
      const candles = await fetchCandles(candleStart,candleEnd);
      // The perpetual benchmark covers the same causal window plus the longest
      // fixed observation endpoint, so every exported endpoint can be observed.
      const futuresSnapshot = await loadPerpetualBaseline(entryTimestamp, Math.max(candleEnd, entryTimestamp + 7 * 86_400_000 + 3_600_000, (selectedEvent.vpocTimestamp ?? 0) + 2 * 3_600_000, (selectedEvent.exitTimestamp ?? 0) + 2 * 3_600_000));
      const observations = buildAndRunObservationRequests(
        selectedEvent,
        canonicalRetrievedSpreads,
        candles,
        candidate => ({ targetExpiryHorizonDays: candidate.targetDte, widthUsd: candidate.targetWidth, spreadKind, expirySelectionPolicy: expirySelectionMode, candidateRankPolicy: "rank-1-only", amount, primaryExecutionScenario: "taker-tape-proxy", latencyMs: 1_000, fillWaitMs: 30 * 60_000, synchronizationThresholdMs: 60_000, slippageBps: 0, exitPolicy: { rule: "vpoc-target", fallback: "settlement" }, requestedPackaging: comboExecution ? "combo" : "legs", executionRoute: "synchronized-leg-proxy", officialComboEvidence: false, feeTier: "standard", marginModel: "segregated_sm" }),
      );
      const next: AnalysisResult[] = observations.map(observation => {
        const spread = observation.spread ?? canonicalRetrievedSpreads.find(candidate => candidate.id === observation.candidateSelection.selectedCandidateId)!;
        const path = observation.valuationPath ?? [];
        const lifecycle = observation.selectedExitLifecycle;
        const selectedExit: ExitResult | undefined = lifecycle ? { rule: lifecycle.rule, timestamp: lifecycle.fillTimestamp ?? lifecycle.triggerTimestamp, triggerTimestamp: lifecycle.triggerTimestamp, decisionAvailableTimestamp: lifecycle.decisionTimestamp, status: lifecycle.status === "filled" || lifecycle.status === "settled" ? "hit" : lifecycle.status === "not-triggered" ? "not-hit" : "unavailable", reasonCode: lifecycle.status === "settled" ? "settlement" : lifecycle.status === "filled" ? "triggered" : lifecycle.status === "not-triggered" ? "not-hit" : "causal-valuation-unavailable", qualityReason: lifecycle.reasonCode } : undefined;
        const exits: ExitResult[] = observation.independentExitOutcomes?.map(exit => ({ rule: exit.rule, timestamp: exit.triggerTimestamp, triggerTimestamp: exit.triggerTimestamp, status: exit.status === "triggered" || exit.status === "available" ? "hit" : "not-hit", reasonCode: exit.status === "available" ? "settlement" : exit.status === "triggered" ? "triggered" : "not-hit", qualityReason: exit.reasonCode })) ?? [];
        // Maker opportunity and taker execution are evaluated independently, from
        // the same MR event / exact contracts / expiry / strikes / entry timestamp
        // / exit policy -- only executionMode varies between the two calls, so
        // neither scenario's evidence can leak into the other.
        const grid=spread.expiryTimestamp===undefined?[entryTimestamp]:valuationTimestamps(entryTimestamp,spread.expiryTimestamp,[selectedEvent.vpocTimestamp??0]);
        const researchLayers=evaluateResearchEntryLayers({spread,targetTimestamp:entryTimestamp,targetIndex:selectedEvent.entryPrice,amount,slippageBps:observation.strategyConfiguration.slippageBps,executionRoute:observation.strategyConfiguration.executionRoute});
        const evaluateScenario=(mode:ExecutionMode):ResearchScenario=>{const entry=researchLayers[mode].entry;const path=entry.status==="priced"?buildEstimatedPath({spread,timestamps:grid,candles,entry,slippageBps:observation.strategyConfiguration.slippageBps,executionRoute:observation.strategyConfiguration.executionRoute}):[];const outcomes=entry.status==="priced"?buildResearchOutcomes({event:selectedEvent,spread,entry,path,candles}):[];return{entry,path,outcomes};};
        const researchByMode={maker:evaluateScenario("maker"),taker:evaluateScenario("taker")};
        const modelEntry=researchLayers.model.entry;
        const modelPath=modelEntry.status==="priced"?buildEstimatedPath({spread,timestamps:grid,candles,entry:modelEntry,slippageBps:observation.strategyConfiguration.slippageBps,executionRoute:observation.strategyConfiguration.executionRoute}):[];
        const modelOutcomes=modelEntry.status==="priced"?buildResearchOutcomes({event:selectedEvent,spread,entry:modelEntry,path:modelPath,candles}):[];
        const eventQuality: QualityFlag = modelEntry.status === "priced" ? modelEntry.estimateQuality : "red";
        const config = observation.strategyConfiguration;
        const delayedExecution=analyzeDelayedExecution({spread,event:selectedEvent,signalTimestamp:entryTimestamp,underlyingCandles:candles,primarySize:amount,slippageBps:observation.strategyConfiguration.slippageBps});
        return { eventPrice:selectedEvent.entryPrice, observation, spread, path, exits, selectedExit, eventQuality, researchByMode, researchLayers, researchEntry:modelEntry, researchPath:modelPath, researchOutcomes:modelOutcomes, delayedExecution, scenarioInput: { event: selectedEvent, candidates: canonicalRetrievedSpreads, candles, config } };
      });
      setAnalysisResults(next);
      setCompletedGeneration(buildCompletedGeneration(next,candles,futuresSnapshot,new Date().toISOString()));
      const firstPriced=next.find(result=>result.researchEntry.status==="priced");
      setSelectedResultId(firstPriced?.spread.id);
      setExpandedResultIds([]);
      setScenarioAmount(firstPriced ? String(firstPriced.scenarioInput.config.amount) : "");
      setScenario(undefined);
      setScenarioCalculating(Boolean(next[0]));
      const priced=next.reduce((sum,result)=>sum+result.researchPath.filter(point=>point.status==="priced").length,0),total=next.reduce((sum,result)=>sum+result.researchPath.length,0);
      setAnalysisStatus(`${next.length} observations · amount ${amount} · BTC candles ${candles.length} (${candles[0].openTime}…${candles.at(-1)!.closeTime}) · priced points ${priced}/${total} · ${futuresSnapshot?`${CANONICAL_BTC_PERPETUAL} ${futuresSnapshot.reference.length} bars, funding ${futuresSnapshot.fundingCoverage?.status??"unavailable"}`:`${CANONICAL_BTC_PERPETUAL} baseline unavailable`}.`);
      jump("analysis");
    } catch (error) {
      setAnalysisStatus(error instanceof Error ? error.message : "The valuation run failed.");
    }
  }

  function exportResults() {
    const configuration = { expiryHorizons: dtes, dteTolerances, expirySelectionMode, widths, spreadKind, pricingAssumption, executionScenariosEvaluated: ["maker", "taker"] as const, displayedExecutionScenario: compareExecutionModes ? "compare" : executionMode, comboRequested: comboExecution, amount, pricingModes };
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
                  <button className={`event-row ${event.id === selectedEvent.id ? "selected" : ""}`} onClick={() => switchEvent(event.id)} key={event.id}>
                    <span className={`direction ${event.direction}`}>{event.direction === "long" ? "L" : "S"}</span>
                    <span><strong>{event.label}</strong><small>{money(event.entryPrice)} entry</small></span>
                    <span className={event.extremePrice ? "data-ready" : "data-missing"}>{event.extremePrice ? "ready" : "needs extreme"}</span>
                  </button>
                ))}
              </div>
            </aside>

            <div className="event-editor card">
              <div className="card-title-row"><div><p className="eyebrow">Selected thesis</p><h3>{selectedEvent.label}</h3></div><div className="event-title-actions"><span className={`direction-pill ${selectedEvent.direction}`}>{selectedEvent.direction} BTC</span><button className="ghost-button danger-button" type="button" onClick={() => void deleteSelectedEvent()} aria-label={`Delete event ${selectedEvent.label}`}>Delete event</button></div></div>
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
                <label>VPOC timestamp<input type="datetime-local" value={selectedEvent.vpocTimestamp ? new Date(selectedEvent.vpocTimestamp).toISOString().slice(0, 16) : ""} onChange={event => patchEvent({ vpocTimestamp: event.target.value ? Date.parse(`${event.target.value}Z`) : undefined })} /></label>
                <label>Exit timestamp<input type="datetime-local" value={selectedEvent.exitTimestamp ? new Date(selectedEvent.exitTimestamp).toISOString().slice(0, 16) : ""} onChange={event => patchEvent({ exitTimestamp: event.target.value ? Date.parse(`${event.target.value}Z`) : undefined })} /></label>
                <label>Entry time source<select value={selectedEvent.entryTimeSource ?? ""} onChange={event => patchEvent({ entryTimeSource: event.target.value === "" ? undefined : event.target.value as BacktestEvent["entryTimeSource"] })}><option value="">Unset</option><option value="resolved">Resolved</option><option value="manual">Manual</option><option value="provisional">Provisional</option></select></label>
                {/* The canonical identity: renaming repoints every saved structure, so it commits on blur rather than per keystroke. */}
                <label>Event ID<input key={selectedEvent.id} defaultValue={selectedEvent.id} onBlur={event => void renameSelectedEvent(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
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
              <div className="config-block expiry-selection-block"><span className="config-label">Expiry selection mode <small>entry-time evidence only</small></span><div className="mode-list">
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "liquidity-aware"} onChange={() => setExpirySelectionMode("liquidity-aware")} />Liquidity-aware<InfoTooltip term="liquidityAware" label="Explain liquidity-aware selection" /></label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "closest-dte"} onChange={() => setExpirySelectionMode("closest-dte")} />Closest DTE</label>
                <label><input type="radio" name="expiry-mode" checked={expirySelectionMode === "all-eligible"} onChange={() => setExpirySelectionMode("all-eligible")} />Test all eligible</label>
              </div></div>
              <div className="config-block two-col">
                <label>Payoff engine<select value={spreadKind} onChange={event => setSpreadKind(event.target.value as SpreadKind)}><option value="credit">Credit · MR default</option><option value="debit">Debit · same anchor rule</option></select></label>
                <label>Pricing assumption<select value={pricingAssumption} onChange={event => setPricingAssumption(event.target.value as PricingAssumption)}><option value="research-estimate">Research estimate · default</option><option value="conservative-tape-check">Conservative tape check · advanced</option></select></label>
              </div>
              <div className="config-block two-col"><label>Order packaging<select value={comboExecution ? "combo" : "legs"} onChange={event => setComboExecution(event.target.value === "combo")}><option value="legs">Separate legs · conservative</option><option value="combo">Deribit option combo</option></select></label><label>Contracts<input type="number" min="0.1" step="0.1" value={amount} onChange={event => setAmount(Math.max(0.1, Number(event.target.value)))} /></label></div>
              <div className="config-block pricing-output-block"><label className="config-label">Pricing output <small>both retained by default</small></label><div className="check-row"><label className={`check-chip ${pricingModes.includes("vwap") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("vwap")} onChange={() => setPricingModes(current => current.includes("vwap") ? current.filter(value => value !== "vwap") : [...current, "vwap"])} />Raw VWAP<InfoTooltip term="rawVwap" label="Explain Raw VWAP" /></label><label className={`check-chip ${pricingModes.includes("iv") ? "checked" : ""}`}><input type="checkbox" checked={pricingModes.includes("iv")} onChange={() => setPricingModes(current => current.includes("iv") ? current.filter(value => value !== "iv") : [...current, "iv"])} />IV normalized<InfoTooltip term="ivNormalized" label="Explain IV-normalized price" /></label></div></div>
            </div>
            <details className="advanced-settings card">
              <summary>Advanced Settings <small>DTE tolerance<InfoTooltip term="dteTolerance" label="Explain DTE tolerance and DTE fit" /></small></summary>
              <p className="quality-reason"><strong>Conservative tape check:</strong> a stress test requiring strict post-order taker prints and sufficient accumulated amount. A no-trade result does not invalidate a bounded Research estimate.</p><label>Execution scenario<select value={compareExecutionModes?"compare":executionMode} onChange={event=>{const v=event.target.value;if(v==="compare"){setCompareExecutionModes(true)}else{setCompareExecutionModes(false);setExecutionMode(v as ExecutionMode)}}}><option value="maker">Maker opportunity — not a guaranteed fill</option><option value="taker">Taker — conservative tape proxy</option><option value="compare">Compare maker vs. taker</option></select></label>
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
}} />Hide red</label><label className="matrix-filter"><input type="checkbox" checked={hideDataUnavailable} onChange={event=>setHideDataUnavailable(event.target.checked)} />Hide data-unavailable</label><button className="secondary-button" onClick={() => jump("contracts")}>Load contracts</button></div></div>
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
              {!!retrievedSpreads.length && !visibleRetrievedSpreads.length && <tr><td colSpan={7} className="empty-cell">No candidates remain visible under the active Generated Matrix filters.</td></tr>}
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

        <section className="workspace-section pnl-block" data-testid="pnl-block" ref={node => { sectionRefs.current.analysis = node; }}>
          <div className="section-heading"><div><span className="step-number">04</span><p className="eyebrow">Path-aware output</p><h2>PnL, exits & trust filters</h2></div><div className="export-controls"><span className={staleDerivedCount||!methodologyStaleness.compatible?"dirty-state":"flag flag-green"}>{!methodologyStaleness.compatible?`Mixed methodology · rerun ${methodologyStaleness.stale.map(item=>item.eventId).join(", ")}`:staleDerivedCount?`Stale derived research · ${staleDerivedCount}`:"Current"}</span><button className="secondary-button" disabled={!analysisResults.length} onClick={exportResults}>Export JSON</button><button className="secondary-button" disabled={!persistedResearchEventCount||!selectionPersistenceAvailable} onClick={()=>void exportResearchBundle()}>Export research bundle · {persistedSelectionCount}</button></div></div><p className="fine-print">The research bundle contains saved selections across the current dataset and their complete generated denominator. Checked-but-unsaved rows are never exported. {!methodologyStaleness.compatible?`Aggregate export is blocked: ${methodologyStaleness.stale.length} event(s) were generated under a different methodology (${[...new Set(methodologyStaleness.stale.flatMap(item=>item.differingFields))].join(", ")}). Rerun and re-save them; changed methodology cannot be migrated.`:staleDerivedCount?"Research data stale — recompute recommended. Export preserves the saved snapshots without claiming they were evaluated.":"Saved derived research uses the current engine versions."}</p>
          <div className="results-workspace-heading"><div><p className="eyebrow">Primary results</p><h3>Economically valued structures</h3></div></div>
          <div className="filter-row"><strong>Reference economics · evidence availability side-by-side</strong><button className="secondary-button unavailable-button" aria-expanded={showUnavailable} onClick={()=>setShowUnavailable(value=>!value)}>{showUnavailable?"Hide data-unavailable":`Show data-unavailable · ${unavailableResults.length}`}</button><span>{filteredResults.length} / {analysisResults.length} visible</span></div>
          {pricingAssumption === "research-estimate" && analysisResults.length>0 && <div className="source-strip compact-status-counts" aria-label="Research availability counts"><span><small>Generated</small><strong>{analysisResults.length}</strong></span><span><small>Model valued</small><strong>{analysisResults.filter(r=>r.researchLayers.model.status==="priced").length}</strong></span><span><small>Maker available</small><strong>{analysisResults.filter(r=>r.researchLayers.maker.status==="available").length}</strong></span><span><small>Taker available</small><strong>{analysisResults.filter(r=>r.researchLayers.taker.status==="available").length}</strong></span><button className="availability-count" aria-expanded={showUnavailable} onClick={()=>setShowUnavailable(value=>!value)}><small>Fully unavailable</small><strong>{unavailableResults.length}</strong><span>{showUnavailable?"Hide diagnostics":"Inspect diagnostics"}</span></button></div>}
          {!!aggregateGroups.length && pricingAssumption === "conservative-tape-check" && <div className="source-strip" aria-label="Unfiltered conservative tape aggregates"><span><small>Original signals</small><strong>{analysisResults.length}</strong></span><span><small>Strict tape entries</small><strong>{analysisResults.filter(r=>r.observation.entryExecution?.status==="filled").length}</strong></span><span><small>No trade / unavailable</small><strong>{analysisResults.filter(r=>r.observation.entryExecution?.status!=="filled").length}</strong></span></div>}
          <div className="cashflow-explainer card"><strong>Cash-flow identities</strong><p>Credit: gross entry credit = sold premium received − bought premium paid; net opening cash flow = gross entry credit × amount − opening fees; mark-to-close PnL = opening cash flow − closing cost − exit fees. Debit spreads mirror the cash-flow direction: opening cash flow is negative and closing proceeds are positive.</p><p>Every path value is a diagnostic unrealized close mark anchored to the actual causal opening cash flow. Realized PnL is shown only for a causal close fill or versioned settlement.</p></div>
          {pricingAssumption === "conservative-tape-check" && <div className="table-card card"><div className="table-scroll"><table><thead><tr><th>Conservative tape result</th><th>Spread and both strikes</th><th>Expiry</th><th>Entry evidence</th></tr></thead><tbody>{filteredResults.map(result=><tr key={result.spread.id} className={selectedAnalysis?.spread.id===result.spread.id?"row-selected":""} onClick={()=>selectAnalysisResult(result.spread.id)}><td>{result.observation.eventOutcome}</td><td><strong>{result.spread.structure}</strong><small className="mono">{spreadIdentity(result.spread).soldStrike??"—"} / {spreadIdentity(result.spread).boughtStrike??"—"} {result.spread.optionType}</small></td><td>{formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</td><td>{entryEvidenceExplanation(result.observation)}</td></tr>)}</tbody></table></div></div>}
          {pricingAssumption === "research-estimate" && <div className="opening-currency-control"><span>Opening values</span><div className="segmented" aria-label="Opening values"><button className={openingCurrency==="btc"?"active":""} onClick={()=>setOpeningCurrency("btc")}>BTC</button><button className={openingCurrency==="usd-entry"?"active":""} onClick={()=>setOpeningCurrency("usd-entry")}>USD @ entry</button></div></div>}
          {pricingAssumption === "research-estimate" && <div className="table-card card"><div className="table-scroll"><table className="pnl-results-table"><thead><tr><th>Research</th><th><span className="sr-only">Expand</span></th><th>Status</th><th>Spread and strikes</th><th>Expiry</th><th>Width</th><th>Gross entry</th><th>Net opening</th><th>Best PnL</th><th>Worst PnL</th><th>Outcome</th></tr></thead><tbody>
            {filteredResults.map(result => {
              const selectedScenario={entry:result.researchEntry,path:result.researchPath,outcomes:result.researchOutcomes};
              const estimate=selectedScenario?.entry.status==="priced"?selectedScenario.entry:undefined;
              const selectedPnls=selectedScenario?.path.map(researchPnlUsd).filter((value):value is number=>value!==undefined)??[],researchBest=Math.max(...selectedPnls),pathStats=selectedScenario?researchPathStatistics(selectedScenario.path,selectedScenario.entry.targetTimestamp):undefined,researchWorst=pathStats?.worstObservedPnlUsd??Infinity;
              const trackStatus=`Reference / fair value ${estimate?"✓":"unavailable"}`;
              const expanded = expandedResultIds.includes(result.spread.id),unavailable=result.researchLayers.model.status!=="priced",modelOnly=result.researchLayers.maker.status!=="available"&&result.researchLayers.taker.status!=="available"&&result.researchLayers.model.status==="priced";
              const payoffInput:ExpiryPayoffInput|undefined=estimate&&result.spread.soldContract&&result.spread.boughtContract&&result.spread.expiryTimestamp?{optionType:result.spread.optionType,shortStrike:result.spread.soldContract.strike,longStrike:result.spread.boughtContract.strike,shortEntryPremiumBtc:estimate.sold.priceBtcPerContract,longEntryPremiumBtc:estimate.bought.priceBtcPerContract,entryIndex:estimate.entryTargetIndex,amount:estimate.amount,openingFeesBtc:estimate.openingFeesBtc,expiryTimestamp:result.spread.expiryTimestamp}:undefined;
              const structural=result.researchLayers.structural,model=result.researchLayers.model,maker=result.researchLayers.maker,taker=result.researchLayers.taker;
              const scenario=executionMode==="maker"?maker:taker,primaryTrack=scenario.status==="available"?executionMode:model.status==="priced"?"model":"contracts";
              const executionBlock=(label:string,layer:typeof maker,queue=false)=>{const completion=layer.entry.status==="priced"?layer.entry.evidenceCompletionTimestamp:undefined,gap=layer.entry.status==="priced"?layer.entry.synchronizationGapMinutes:undefined;return <section className={`evidence-block ${primaryTrack===label.toLowerCase().split(" ")[0]?"primary-evidence":""}`}><h4>{label} · bounded, not instantaneous</h4><dl><div><dt>Status / evidence quality</dt><dd>{layer.status} · {layer.entry.status==="priced"?layer.entry.estimateQuality:layer.rawVwapStatus}</dd></div><div><dt>Actions</dt><dd>{layer.shortDirection} / {layer.longDirection}</dd></div><div><dt>Amount</dt><dd>requested {layer.requestedAmount} · qualifying {layer.shortQualifyingAmount} / {layer.longQualifyingAmount}</dd></div><div><dt>Order available / fill-search end</dt><dd>{formatUtc(layer.orderTimestamp)} – {formatUtc(layer.fillWindowEnd)}</dd></div><div><dt>Spread completion / completion delay</dt><dd>{completion?`${formatUtc(completion)} · ${((completion-layer.orderTimestamp)/60_000).toFixed(1)} minutes`:"Unavailable"}</dd></div><div><dt>Leg synchronization gap</dt><dd>{gap===undefined?"Unavailable":`${gap.toFixed(1)} minutes`}</dd></div><div><dt>Trade evidence</dt><dd>{layer.entry.status==="priced"?`${layer.entry.sold.supportingTrades.map(t=>`${t.tradeId??"unidentified"} @ ${formatUtc(t.timestamp)}`).join(", ")} / ${layer.entry.bought.supportingTrades.map(t=>`${t.tradeId??"unidentified"} @ ${formatUtc(t.timestamp)}`).join(", ")}`:"No qualifying trade IDs."}</dd></div><div><dt>Slippage / fees</dt><dd>{layer.entry.status==="priced"?`${layer.entry.slippageBps} bps · ${btc(layer.entry.openingFeesBtc)}`:"Unavailable"}</dd></div><div><dt>Reason</dt><dd>{layer.reason}</dd></div></dl><p className="evidence-disclaimer">{queue?"Historical maker evidence identifies an opportunity, not queue priority or a guaranteed fill.":"Taker evidence is a bounded causal tape proxy; it is not a claim of certain execution."}</p></section>};
              return <Fragment key={result.spread.id}><tr className={`${selectedAnalysis?.spread.id === result.spread.id ? "row-selected " : ""}${unavailable?"unavailable-row":""}`} onClick={() => selectAnalysisResult(result.spread.id)}><td><label className="research-select" onClick={event=>event.stopPropagation()}><input type="checkbox" checked={draftSelectionIds.has(result.spread.id)} disabled={unavailable} aria-label={`Select ${result.spread.structure} for research`} onChange={event=>toggleResearchSelection(result.spread.id,event.target.checked)}/>{savedSelectionIds.has(result.spread.id)&&draftSelectionIds.has(result.spread.id)&&<small>SAVED</small>}</label></td><td><button className="expand-button" aria-expanded={expanded} aria-controls={`ledger-${result.spread.id}`} aria-label={`${expanded ? "Collapse" : "Expand"} evidence for ${result.spread.structure}`} onClick={event => { event.stopPropagation(); setExpandedResultIds(current => expanded ? current.filter(id => id !== result.spread.id) : [...current, result.spread.id]); }}><span className="expand-chevron" aria-hidden="true" /></button></td><td><div className="status-stack" aria-label={`Model ${model.status}; maker ${maker.status}; taker ${taker.status}`}><span>{trackStatus}</span>{(()=>{const saved=savedEventSelection?.selectedStructures.find(item=>item.candidateId===result.spread.id),states=backtesterPersistedTrackStates(saved),badge=(label:string,state:{available:boolean;status:string;reason:string|null})=><span title={state.reason??undefined}>{label} {state.available?"✓":state.status==="not_evaluated"?"pending":"unavailable"}{!state.available&&state.reason?` · ${state.reason}`:""}</span>;return <>{badge("Reference fair value",states?.reference??{available:model.status==="priced",status:model.status,reason:model.reason})}{badge("Immediate Maker opportunity · observed tape",states?.immediateMaker??{available:maker.status==="available",status:maker.status,reason:maker.reason})}{badge("Immediate Taker execution · observed tape",states?.immediateTaker??{available:taker.status==="available",status:taker.status,reason:taker.reason})}{badge("Delayed observed-tape maker opportunity",states?.delayedMaker??{available:false,status:"not_evaluated",reason:null})}{badge("Delayed observed-tape taker execution",states?.delayedTaker??{available:false,status:"not_evaluated",reason:null})}{badge("Empirical expected taker · Q50",states?.modeledExpected??{available:false,status:"not_evaluated",reason:"Local Node recompute required."})}{badge("Empirical conservative taker · Q90",states?.modeledConservative??{available:false,status:"not_evaluated",reason:"Local Node recompute required."})}</>})()}{estimate?.estimateQuality!=="green"&&<span>Low confidence</span>}{modelOnly&&<b>Model-only</b>}</div></td><td><strong>{result.spread.structure}</strong><small className="mono">{spreadIdentity(result.spread).soldStrike} / {spreadIdentity(result.spread).boughtStrike} {result.spread.optionType}</small></td><td>{formatExpiryWithFriday(result.spread.expiryTimestamp,result.spread.expiryLabel)}</td><td>{money(result.spread.actualWidth)}</td><td>{openingDisplay(estimate?.grossSpreadBtc,estimate?.entryTargetIndex,openingCurrency)}</td><td>{openingDisplay(estimate?.netOpeningCashFlowBtc,estimate?.entryTargetIndex,openingCurrency)}</td><td className="positive">{researchBest===-Infinity?"—":money(researchBest)}</td><td className="negative">{researchWorst===Infinity?"—":money(researchWorst)}</td><td>{estimate?(selectedScenario?.outcomes.find(outcome=>outcome.status==="estimated")?.label??"Valued"):"—"}</td></tr>{expanded&&<tr className="ledger-detail-row"><td colSpan={11}><div id={`ledger-${result.spread.id}`} className="expanded-structure" data-primary-track={primaryTrack}><div className="evidence-panel" aria-label={`Complete evidence for ${result.spread.structure}`}><section className={`evidence-block ${primaryTrack==="contracts"?"primary-evidence":""}`}><h4>Structure</h4><dl><div><dt>Instruments</dt><dd className="mono">{structural.shortInstrument??"unresolved"} / {structural.longInstrument??"unresolved"}</dd></div><div><dt>Requested / actual strikes</dt><dd>{money(structural.requestedStrikes.short)} / {money(structural.requestedStrikes.long)} → {money(structural.actualStrikes.short??undefined)} / {money(structural.actualStrikes.long??undefined)}</dd></div><div><dt>Expiry</dt><dd>{formatExpiryWithFriday(structural.expiryTimestamp??undefined,result.spread.expiryLabel)}</dd></div><div><dt>Listing / resolution</dt><dd>{structural.listingStatus} · {structural.status}</dd></div><div><dt>Retrieval</dt><dd>{structural.retrievalError??structural.reason}</dd></div></dl></section><section className={`evidence-block ${primaryTrack==="model"?"primary-evidence":""}`}><h4>Reference valuation</h4><dl><div><dt>Status / quality</dt><dd>{model.status} · {estimate?.estimateQuality??"unavailable"}</dd></div><div><dt>Entry model prices</dt><dd>{estimate?`${btc(estimate.sold.priceBtcPerContract)} / ${btc(estimate.bought.priceBtcPerContract)}`:"Unavailable"}</dd></div><div><dt>Causal IV anchors</dt><dd>{estimate?.sold.model&&estimate.bought.model?`${(estimate.sold.model.anchorIvDecimal*100).toFixed(2)}% @ ${formatUtc(estimate.sold.model.anchorTimestamp)} (${estimate.sold.model.anchorAgeMinutes.toFixed(0)}m) / ${(estimate.bought.model.anchorIvDecimal*100).toFixed(2)}% @ ${formatUtc(estimate.bought.model.anchorTimestamp)} (${estimate.bought.model.anchorAgeMinutes.toFixed(0)}m)`:"Unavailable"}</dd></div><div><dt>Synchronization gap</dt><dd>{estimate?`${estimate.synchronizationGapMinutes.toFixed(1)} minutes`:"Unavailable"}</dd></div><div><dt>Index inputs</dt><dd>{estimate?`${money(estimate.entryTargetIndex)} at ${formatUtc(estimate.targetTimestamp)}`:"Unavailable"}</dd></div><div><dt>Reason</dt><dd>{model.reason}</dd></div></dl><p className="evidence-disclaimer">Theoretical model valuation only; not an executable quote or confirmed fill.</p></section>{executionBlock("Immediate maker",maker,true)}{executionBlock("Immediate taker",taker)}<section className="evidence-block"><h4>Delayed execution</h4><dl><div><dt>Saved maker / taker status</dt><dd>{(()=>{const x=backtesterPersistedTrackStates(savedEventSelection?.selectedStructures.find(item=>item.candidateId===result.spread.id));return `${x?.delayedMaker.status??"not_evaluated"} / ${x?.delayedTaker.status??"not_evaluated"}`})()}</dd></div><div><dt>First qualifying window</dt><dd>—</dd></div><div><dt>Entry / spot / DTE</dt><dd>—</dd></div><div><dt>Pre-entry thesis</dt><dd>—</dd></div><div><dt>Economics</dt><dd>—</dd></div></dl><p className="evidence-disclaimer">No immediate-track values are substituted when delayed evidence is unavailable.</p></section><section className="evidence-block"><h4>Modeled execution</h4><dl><div><dt>Fair value</dt><dd>{estimate?btc(estimate.netOpeningCashFlowBtc):"—"}</dd></div><div><dt>Expected / conservative concession</dt><dd>— / —</dd></div><div><dt>Empirical Q50 / Q90 status</dt><dd>{(()=>{const x=backtesterPersistedTrackStates(savedEventSelection?.selectedStructures.find(item=>item.candidateId===result.spread.id));return `${x?.modeledExpected.status??"not_evaluated"} / ${x?.modeledConservative.status??"not_evaluated"}`})()}</dd></div><div><dt>Sensitivity assumptions</dt><dd>Execution-penalty track unavailable</dd></div></dl><p className="evidence-disclaimer">A modeled execution estimate is not evidence of a fill.</p></section></div><div className="payoff-panel">{payoffInput?<ExpiryPayoffChart input={payoffInput}/>:<section className="evidence-empty"><h4>Expiration payoff</h4><p>Unavailable because the exact contracts or model entry could not be priced.</p></section>}{estimate&&<section className="expanded-path"><h4>Valuation path and outcomes</h4><ResearchValuationChart path={selectedScenario?.path??result.researchPath} outcomes={selectedScenario?.outcomes??result.researchOutcomes} expiry={result.spread.expiryTimestamp} entryTimestamp={estimate.targetTimestamp}/></section>}</div></div></td></tr>}</Fragment>;
            })}
            {!filteredResults.length && <tr><td colSpan={11} className="empty-cell">No economically valued structures are available. Use “Show data-unavailable” for complete diagnostics.</td></tr>}
          </tbody></table></div>{(staleSelections.size>0||savedCurrentlyUnavailable.length>0)&&<section className="saved-unavailable-notice"><h3>Saved but currently unavailable · {staleSelections.size+savedCurrentlyUnavailable.length}</h3><p className="fine-print">Saved snapshots stay inspectable and exportable until you remove or clear them; IDs are never remapped.</p>{savedCurrentlyUnavailable.map(result=><div key={result.spread.id}><button className="secondary-button" onClick={()=>{setShowUnavailable(true);setExpandedResultIds(ids=>ids.includes(result.spread.id)?ids:[...ids,result.spread.id]);}}>{result.spread.structure} · inspect</button><label className="research-select"><input type="checkbox" checked={draftSelectionIds.has(result.spread.id)} onChange={event=>toggleResearchSelection(result.spread.id,event.target.checked)}/>Keep saved</label></div>)}{[...staleSelections].map(id=><label className="research-select" key={id}><input type="checkbox" checked={draftSelectionIds.has(id)} onChange={event=>toggleResearchSelection(id,event.target.checked)}/><span className="mono">{id}</span><small>SAVED · absent from current generation</small></label>)}</section>}<div className="research-save-bar"><strong>{draftSelectionIds.size} structures selected for this event</strong>{selectionDirty&&<span className="dirty-state">Unsaved selection changes</span>}{generationDirty&&<span className="dirty-state">Research generation changed · save to refresh methodology</span>}<button className="secondary-button" disabled={!savedSelectionIds.size||!selectionPersistenceAvailable} onClick={()=>void clearSavedSelection()}>Clear selected structures</button><button className="primary-button" disabled={!researchStateDirty||!selectionPersistenceAvailable} onClick={()=>void saveResearchSelections()}>Save research state</button></div>{selectionStatus&&<p className="research-export-status" role="status" aria-live="polite">{selectionStatus}</p>}</div>}

          {selectedAnalysis && pricingAssumption === "research-estimate" && <ResearchDetail result={selectedAnalysis} amount={scenarioAmount} onAmountChange={setScenarioAmount} openingCurrency={openingCurrency} compareExecutionModes={compareExecutionModes}/>}
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
