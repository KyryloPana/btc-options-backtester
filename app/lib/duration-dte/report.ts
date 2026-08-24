import type {AnalysisDataset} from "../research-analysis.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION,type AnalysisConfiguration,type CapitalBasis} from "../analysis-configuration.ts";
import {normalizeExitPolicies} from "../exit-policy/normalize.ts";
import {policyById} from "../exit-policy/policies.ts";
import {buildUnderlyingResolutionReport} from "../underlying-resolution/report.ts";
import {fiveNumber,observedPercentiles,type FiveNumberSummary} from "../underlying-resolution/statistics.ts";
import {buildEntryDelayReport,type EntryDelayReport} from "./entry-delay.ts";
import {buildMatchedDteComparison,buildMatchedExecution,type MatchedDteComparisonRow,type MatchedExecutionRow} from "./matched.ts";
import {
 buildHorizonAvailability,buildHorizonFamilies,globalScenarioCoverage,normalizeDteCandidates,
 type CaptureObservation,type DteCandidate,type ExecutionScenario,type HorizonAvailability,type HorizonFamily,
 type NoResolutionDetail,type OutcomeBeforeExpiry,type PathEvidenceStatus,type ScenarioCoverage,
} from "./normalize.ts";
import {buildResolutionSpeedReport,type ResolutionSpeedReport} from "./resolution-speed.ts";
import {coverageFromSurvival,share,type CoveragePoint} from "./statistics.ts";

/** Auditable dependency contract for every Duration metric family. */
export const DURATION_METRIC_ROUTES={
 structural:"event_structure",creditCapture:"reference",outcomePnl:"reference",adverseEconomicPath:"reference",matchedDte:"reference",
 makerCoverage:"immediate_maker",takerCoverage:"immediate_taker",observedSynchronization:"immediate_maker|immediate_taker",
 executionDrag:"immediate_maker+immediate_taker",entryDelay:"delayed_maker|delayed_taker",executionSensitivity:"modeled_expected|modeled_conservative|penalty_sensitivity",capitalTime:"margin",
} as const;

/**
 * The one coherent view model for Duration & DTE. Every card, chart and table
 * reads from this object; nothing is recomputed in a component, and no
 * strike/width/exit-policy/futures/strategy selection is calculated here.
 *
 * TWO POPULATIONS, and mixing them is the defect this file is organised to
 * prevent:
 *
 *  - `structures`: one entry per candidate_id. Every EXECUTION-INDEPENDENT
 *    statistic (actual DTE, resolution coverage, outcome before expiry, DTE
 *    buffer, holding period) is computed here, so switching Maker <-> Taker
 *    cannot change a number that does not depend on execution, and a structure
 *    is never counted twice merely because it has two scenario rows.
 *  - `scenarioRows`: rows for the selected scenario only. Every
 *    EXECUTION-DEPENDENT statistic (entry credit, credit capture, PnL, worst
 *    adverse, synchronization, capital metrics) is computed here.
 *
 * Availability/coverage is measured at MR EVENT granularity: one event is one
 * observation per horizon no matter how many width/strike variants it
 * generated. Economic DTE comparisons use MATCHED structural variants so a
 * width or strike-placement difference is never attributed to duration.
 */

export interface OverviewRow {
 readonly horizon:HorizonFamily;
 /** Distinct STRUCTURES at this horizon (execution-independent). */
 readonly structuresN:number;
 /** Distinct MR EVENTS at this horizon -- the availability/thesis unit. */
 readonly eventsN:number;
 /** Selected-scenario rows not genuinely evaluated. Never shown as 0%. */
 readonly notEvaluatedN:number;
 readonly unavailableN:number;
 readonly actualDte:FiveNumberSummary|null;
 readonly pricedShare:number|null;
 readonly taker:ScenarioCoverage;
 readonly maker:ScenarioCoverage;
 readonly resolutionCoverageShare:number|null;
 readonly noResolutionBeforeExpiryShare:number|null;
 readonly medianDteBufferDays:number|null;
 readonly medianTimeToCapture50Days:number|null;
 readonly medianCapitalDayReturn:number|null;
}

export interface OutcomeBeforeExpiryRow {
 readonly horizon:HorizonFamily;
 readonly counts:Record<OutcomeBeforeExpiry,number>;
 /** The diagnostic split inside no_resolution_before_expiry; the visual category stays whole. */
 readonly noResolutionDetail:Record<NoResolutionDetail,number>;
 readonly determinateN:number;
 /** Structures whose before/after-expiry position cannot be determined. Never coerced into a bucket. */
 readonly notDeterminableN:number;
}

export interface DteBufferRow {readonly horizon:HorizonFamily;readonly values:readonly number[];readonly summary:FiveNumberSummary|null}

export interface SynchronizationRow {
 readonly horizon:HorizonFamily;
 readonly medianMinutes:number|null;
 readonly p95Minutes:number|null;
 readonly n:number;
}

export interface CaptureThresholdRow {
 readonly horizon:HorizonFamily;
 readonly totalN:number;
 readonly reachedN:number;
 readonly timeToCaptureDays:readonly number[];
 readonly medianTimeToCaptureDays:number|null;
 readonly beforeVpocShare:number|null;
 readonly beforeInvalidationShare:number|null;
 readonly unavailableN:number;
 readonly dominantReason:string|null;
}

export interface PnlBucket {
 readonly label:string;
 readonly outcome:OutcomeBeforeExpiry;
 readonly n:number;
 readonly medianPnlUsd:number|null;
 readonly medianWorstAdverseUsd:number|null;
 readonly medianMaeBeforeProfitUsd:number|null;
 /** Set when the bucket is structurally excluded from a PnL figure rather than merely empty. */
 readonly note:string|null;
}
export interface PnlByOutcomeRow {readonly horizon:HorizonFamily;readonly buckets:readonly PnlBucket[]}

/** Capital-free holding-time analysis: works even when no margin data exists. */
export interface HoldingPeriodRow {
 readonly horizon:HorizonFamily;
 readonly n:number;
 readonly medianHoldingDays:number|null;
 readonly p80HoldingDays:number|null;
 readonly heldToSettlementShare:number|null;
}

export interface CapitalTimeSummary {
 readonly available:boolean;
 readonly reason:string|null;
 readonly points:readonly {actualDteDays:number;capitalDayReturn:number}[];
 readonly medianCapitalDays:number|null;
 readonly medianCapitalDayReturn:number|null;
}

export interface OperationalHoldingSummary {
 readonly available:boolean;
 readonly reason:string|null;
 readonly policy:string|null;
 readonly pricingTrack:string|null;
 readonly capitalBasis:CapitalBasis;
 readonly pricedExits:number;
 readonly medianHoldingDays:number|null;
 readonly medianCapitalDayReturn:number|null;
}

/** Why Worst Adverse is missing, aggregated so the cause is inspectable rather than hidden. */
export interface AdversePathDiagnostics {
 readonly totalRows:number;
 readonly withValue:number;
 readonly byStatus:Record<PathEvidenceStatus,number>;
 readonly maeBeforeProfitN:number;
 readonly profitObservedN:number;
 /** A representative canonical reason for the dominant missing-evidence status. */
 readonly dominantReason:string|null;
}

export interface HeadlineSummary {
 readonly effectiveEvents:number;
 readonly totalEvents:number;
 /** Event-level coverage, measured independently per scenario. Never derived from a configured-run label. */
 readonly taker:ScenarioCoverage;
 readonly maker:ScenarioCoverage;
 readonly medianActualDteDays:number|null;
 readonly noResolutionBeforeExpiryShare:number|null;
 readonly medianFirstResolutionDays:number|null;
 readonly medianHoldingDays:number|null;
}

export interface DurationDteReport {
 readonly scenario:ExecutionScenario;
 /** Selected-scenario rows, for the event-level audit table. */
 readonly candidates:readonly DteCandidate[];
 /** One row per structure, execution-independent. */
 readonly structures:readonly DteCandidate[];
 readonly horizons:readonly HorizonFamily[];
 readonly headline:HeadlineSummary;
 readonly overview:readonly OverviewRow[];
 readonly availability:readonly HorizonAvailability[];
 readonly synchronization:readonly SynchronizationRow[];
 readonly coverageCurve:readonly CoveragePoint[];
 readonly actualDteAll:readonly number[];
 readonly outcomeBeforeExpiry:readonly OutcomeBeforeExpiryRow[];
 readonly dteBuffer:readonly DteBufferRow[];
 readonly captureByThreshold:Record<25|50|70,readonly CaptureThresholdRow[]>;
 readonly pnlByOutcome:readonly PnlByOutcomeRow[];
 readonly holdingPeriod:readonly HoldingPeriodRow[];
 readonly capitalTime:CapitalTimeSummary;
 readonly operationalHolding:OperationalHoldingSummary;
 readonly adverseDiagnostics:AdversePathDiagnostics;
 readonly matchedDte:readonly MatchedDteComparisonRow[];
 readonly matchedExecution:readonly MatchedExecutionRow[];
 readonly resolutionSpeed:ResolutionSpeedReport;
 readonly entryDelay:EntryDelayReport;
 readonly excludedIneligible:number;
 readonly methodology:readonly string[];
}

const zeroCounts=():Record<OutcomeBeforeExpiry,number>=>({vpoc_before_expiry:0,invalidation_before_expiry:0,ambiguous_before_expiry:0,no_resolution_before_expiry:0,vpoc_before_structure_entry:0});
const pct=(values:readonly number[],p:number):number|null=>values.length?observedPercentiles(values,[p])[0]??null:null;
const median=(values:readonly number[]):number|null=>pct(values,0.5);
const defined=(values:readonly (number|null)[]):number[]=>values.filter((x):x is number=>x!==null);
const eligible=(cs:readonly DteCandidate[])=>cs.filter(c=>c.ineligibilityReason===null);
const atHorizon=(cs:readonly DteCandidate[],nominalDays:number)=>cs.filter(c=>c.horizonNominalDays===nominalDays);
const evaluatedOnly=(cs:readonly DteCandidate[])=>cs.filter(c=>c.executionScenarioStatus==="evaluated");

/**
 * One row per candidate_id, preferring a genuinely evaluated row so the
 * representative carries real entry evidence where any exists. Every
 * execution-INDEPENDENT field is identical across a structure's rows, so the
 * choice cannot change a structural statistic.
 */
function toStructures(all:readonly DteCandidate[]):readonly DteCandidate[]{
 const byId=new Map<string,DteCandidate>();
 for(const c of all){
  const existing=byId.get(c.candidateId);
  if(!existing||(existing.executionScenarioStatus!=="evaluated"&&c.executionScenarioStatus==="evaluated"))byId.set(c.candidateId,c);
 }
 return [...byId.values()];
}

function overviewRow(horizon:HorizonFamily,structures:readonly DteCandidate[],scenarioRows:readonly DteCandidate[],availability:HorizonAvailability,referenceRows:readonly DteCandidate[]=scenarioRows):OverviewRow{
 const struct=atHorizon(eligible(structures),horizon.nominalDays);
 const rows=atHorizon(eligible(scenarioRows),horizon.nominalDays),evaluated=evaluatedOnly(rows);
 const determinate=struct.filter(c=>c.resolvedBeforeExpiry!==null);
 return {
  horizon,
  structuresN:struct.length,
  eventsN:new Set(struct.map(c=>c.eventId)).size,
  notEvaluatedN:rows.filter(c=>c.executionScenarioStatus==="not_evaluated").length,
  unavailableN:rows.filter(c=>c.executionScenarioStatus==="unavailable").length,
  actualDte:fiveNumber(defined(struct.map(c=>c.actualDteDays))),
  pricedShare:share(availability.priced,availability.eligibleEvents),
  taker:availability.taker,maker:availability.maker,
  resolutionCoverageShare:share(determinate.filter(c=>c.resolvedBeforeExpiry===true).length,determinate.length),
  noResolutionBeforeExpiryShare:share(determinate.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,determinate.length),
  medianDteBufferDays:median(defined(struct.map(c=>c.dteBufferDays))),
  medianTimeToCapture50Days:median(defined(atHorizon(eligible(referenceRows),horizon.nominalDays).map(c=>c.capture50?.reached?c.capture50.timeToCaptureDays:null))),
  medianCapitalDayReturn:median(defined(evaluated.map(c=>c.capitalDayReturn))),
 };
}

/** Execution-independent: computed over structures, never over scenario rows. */
function outcomeBeforeExpiryRow(horizon:HorizonFamily,structures:readonly DteCandidate[]):OutcomeBeforeExpiryRow{
 const selected=atHorizon(eligible(structures),horizon.nominalDays),counts=zeroCounts();
 const noResolutionDetail:Record<NoResolutionDetail,number>={resolved_later:0,still_unresolved:0};
 let determinateN=0;
 for(const c of selected){
  if(!c.outcomeBeforeExpiry)continue;
  counts[c.outcomeBeforeExpiry]++;determinateN++;
  if(c.noResolutionDetail)noResolutionDetail[c.noResolutionDetail]++;
 }
 return {horizon,counts,noResolutionDetail,determinateN,notDeterminableN:selected.length-determinateN};
}

function dteBufferRow(horizon:HorizonFamily,structures:readonly DteCandidate[]):DteBufferRow{
 const values=defined(atHorizon(eligible(structures),horizon.nominalDays).map(c=>c.dteBufferDays));
 return {horizon,values,summary:fiveNumber(values)};
}

function holdingPeriodRow(horizon:HorizonFamily,structures:readonly DteCandidate[]):HoldingPeriodRow{
 const selected=atHorizon(eligible(structures),horizon.nominalDays);
 const holding=defined(selected.map(c=>c.holdingDays));
 const settled=selected.filter(c=>c.heldToExpiry!==null);
 return {
  horizon,n:holding.length,
  medianHoldingDays:median(holding),p80HoldingDays:pct(holding,0.8),
  heldToSettlementShare:share(settled.filter(c=>c.heldToExpiry===true).length,settled.length),
 };
}

function captureRow(horizon:HorizonFamily,scenarioRows:readonly DteCandidate[],threshold:25|50|70):CaptureThresholdRow{
 const selected=atHorizon(eligible(scenarioRows),horizon.nominalDays);
 const captures=selected.map(c=>threshold===25?c.capture25:threshold===50?c.capture50:c.capture70).filter((x):x is CaptureObservation=>x!==null);
 const evaluable=captures.filter(c=>c.evaluable),reached=evaluable.filter(c=>c.reached);
 const beforeVpoc=captures.filter(c=>c.beforeVpoc!==null),beforeInvalidation=captures.filter(c=>c.beforeInvalidation!==null);
 const timeToCaptureDays=defined(reached.map(c=>c.timeToCaptureDays));
 return {
  horizon,totalN:evaluable.length,reachedN:reached.length,timeToCaptureDays,unavailableN:captures.length-evaluable.length,
  dominantReason:captures.find(c=>!c.evaluable)?.unavailableReason??null,
  medianTimeToCaptureDays:median(timeToCaptureDays),
  beforeVpocShare:share(beforeVpoc.filter(c=>c.beforeVpoc===true).length,beforeVpoc.length),
  beforeInvalidationShare:share(beforeInvalidation.filter(c=>c.beforeInvalidation===true).length,beforeInvalidation.length),
 };
}

const PNL_BUCKETS:readonly {outcome:OutcomeBeforeExpiry;label:string;pnl:(c:DteCandidate)=>number|null;note:string|null}[]=[
 {outcome:"vpoc_before_expiry",label:"VPOC before expiry",pnl:c=>c.pnlAtVpocUsd,note:null},
 {outcome:"invalidation_before_expiry",label:"Invalidation before expiry",pnl:c=>c.pnlAtInvalidationUsd,note:null},
 {outcome:"ambiguous_before_expiry",label:"Ambiguous before expiry",pnl:c=>c.pnlAtVpocUsd??c.pnlAtInvalidationUsd,note:null},
 {outcome:"no_resolution_before_expiry",label:"No resolution before expiry",pnl:c=>c.pnlAtSettlementUsd,note:null},
 {outcome:"vpoc_before_structure_entry",label:"VPOC already reached before structure entry",pnl:()=>null,
  note:"VPOC preceded this structure's entry, so there is no post-entry PnL at VPOC to report. Credit capture, invalidation, adverse path and settlement remain valid for these structures."},
];

/**
 * PnL grouped by the CANDIDATE-RELATIVE outcome -- what happened while the
 * structure existed. A 7D structure whose event reached VPOC on day 20 is a
 * settlement result, never a "PnL at VPOC" row.
 */
function pnlRow(horizon:HorizonFamily,scenarioRows:readonly DteCandidate[]):PnlByOutcomeRow{
 const selected=atHorizon(eligible(scenarioRows),horizon.nominalDays);
 return {horizon,buckets:PNL_BUCKETS.map(({outcome,label,pnl,note})=>{
  const items=selected.filter(c=>c.outcomeBeforeExpiry===outcome);
  return {
   outcome,label,n:items.length,
   medianPnlUsd:median(defined(items.map(pnl))),
   medianWorstAdverseUsd:median(defined(items.map(c=>c.worstAdverseUsd))),
   medianMaeBeforeProfitUsd:median(defined(items.map(c=>c.adversePath.maeBeforeProfitUsd))),
   note,
  } satisfies PnlBucket;
 })};
}

function capitalTimeSummary(scenarioRows:readonly DteCandidate[]):CapitalTimeSummary{
 const withCapital=evaluatedOnly(eligible(scenarioRows)).filter(c=>c.requiredCapitalUsd!==null&&c.requiredCapitalUsd>0&&c.holdingDays!==null&&c.holdingDays>0&&c.capitalDayReturn!==null);
 if(!withCapital.length)return {
  available:false,
  reason:"No canonical margin scenario in this bundle reports an available required-capital figure. Capital-day return is not computed from long-leg cost or theoretical maximum loss as a substitute. The holding-period analysis is unaffected: it needs no capital data.",
  points:[],medianCapitalDays:null,medianCapitalDayReturn:null,
 };
 return {
  available:true,reason:null,
  points:withCapital.filter(c=>c.actualDteDays!==null).map(c=>({actualDteDays:c.actualDteDays!,capitalDayReturn:c.capitalDayReturn!})),
  medianCapitalDays:median(withCapital.map(c=>c.requiredCapitalUsd!*c.holdingDays!)),
  medianCapitalDayReturn:median(withCapital.map(c=>c.capitalDayReturn!)),
 };
}

/** Aggregated so a column of "Unavailable" always carries a traceable cause. */
function adverseDiagnostics(scenarioRows:readonly DteCandidate[]):AdversePathDiagnostics{
 const byStatus:Record<PathEvidenceStatus,number>={available:0,scenario_not_evaluated:0,no_observation_window:0,raw_evaluation_not_attempted:0,no_compatible_tape:0,insufficient_amount:0,missing_leg:0,synchronization_failure:0,no_raw_marks:0};
 let withValue=0,maeBeforeProfitN=0,profitObservedN=0;
 for(const c of scenarioRows){
  byStatus[c.adversePath.status]++;
  if(c.adversePath.worstAdverseUsd!==null)withValue++;
  if(c.adversePath.maeBeforeProfitUsd!==null)maeBeforeProfitN++;
  if(c.adversePath.profitObserved)profitObservedN++;
 }
 const dominant=(Object.entries(byStatus) as [PathEvidenceStatus,number][])
  .filter(([status])=>status!=="available").sort((a,b)=>b[1]-a[1])[0];
 const dominantReason=dominant&&dominant[1]>0
  ?scenarioRows.find(c=>c.adversePath.status===dominant[0])?.adversePath.reason??null:null;
 return {totalRows:scenarioRows.length,withValue,byStatus,maeBeforeProfitN,profitObservedN,dominantReason};
}

export function buildDurationDteReport(dataset:AnalysisDataset,scenario:ExecutionScenario="maker",configuration:AnalysisConfiguration=DEFAULT_ANALYSIS_CONFIGURATION):DurationDteReport{
 const underlying=buildUnderlyingResolutionReport(dataset);
 const allScenarios=normalizeDteCandidates(dataset),horizons=buildHorizonFamilies(dataset),availability=buildHorizonAvailability(dataset,horizons);
 const availabilityByHorizon=new Map(availability.map(a=>[a.nominalDays,a]));
 const global=globalScenarioCoverage(dataset);

 // Execution-DEPENDENT population: the selected scenario's own rows.
 const scenarioRows=allScenarios.filter(c=>c.executionScenario===scenario);
 // Execution-INDEPENDENT population: one row per structure.
 const structures=toStructures(allScenarios);
 const qualityAllowed=(c:DteCandidate)=>!configuration.includedQualityLevels.length||(c.referenceSourceTier!==null&&configuration.includedQualityLevels.includes(c.referenceSourceTier));
 const referenceRows=structures.filter(qualityAllowed);
 const okStructures=eligible(structures);
 const resolutionEndpoint=underlying.endpoints.find(b=>b.endpoint==="resolution")!;
 const determinate=okStructures.filter(c=>c.resolvedBeforeExpiry!==null);
 const policyObservations=configuration.exitPolicy&&configuration.pricingTrack
  ?normalizeExitPolicies(dataset).filter(o=>o.executionScenario===scenario&&o.policyId===configuration.exitPolicy&&o.pricingTrack===configuration.pricingTrack)
  :[];
 const pricedPolicy=policyObservations.filter(o=>o.status==="priced"&&o.holdingHours!==null&&o.holdingHours>0);
 const margins=dataset.tables.margin_scenarios??[];
 const capitalFor=(candidateId:string):number|null=>{
  const m=margins.find(x=>x.candidate_id===candidateId&&x.margin_status==="available");
  if(!m)return null;
  const value=configuration.capitalBasis==="maximum_economic_loss"?m.maximum_structural_loss_native
   :configuration.capitalBasis==="incremental_opening_margin"?m.incremental_initial_margin:m.peak_initial_margin;
  return typeof value==="number"&&Number.isFinite(value)&&value>0?value:null;
 };
 const capitalReturns=pricedPolicy.flatMap(o=>{const cap=capitalFor(o.candidateId),days=o.holdingHours!/24;return cap!==null&&o.pnlBtc!==null&&days>0?[o.pnlBtc/(cap*days)]:[]});
 const operationalHolding:OperationalHoldingSummary=!configuration.exitPolicy||!configuration.pricingTrack?{
  available:false,reason:"Requires complete exit policy and pricing track. No operational exit, holding period, or capital-day result is inferred from VPOC, first resolution, or expiry.",policy:null,pricingTrack:configuration.pricingTrack,capitalBasis:configuration.capitalBasis,pricedExits:0,medianHoldingDays:null,medianCapitalDayReturn:null,
 }:{
  available:pricedPolicy.length>0,
  reason:pricedPolicy.length?null:`${policyById(configuration.exitPolicy).label} produced no priced same-track exits. Triggered-but-unpriced exits retain the policy engine's declared fallback outcome and are not treated as closed at the trigger.`,
  policy:policyById(configuration.exitPolicy).label,pricingTrack:configuration.pricingTrack,capitalBasis:configuration.capitalBasis,pricedExits:pricedPolicy.length,
  medianHoldingDays:median(pricedPolicy.map(o=>o.holdingHours!/24)),medianCapitalDayReturn:median(capitalReturns),
 };

 return {
  scenario,
  candidates:scenarioRows,structures,horizons,
  headline:{
   effectiveEvents:underlying.effectiveN,totalEvents:underlying.totalEvents,
   taker:global.taker,maker:global.maker,
   medianActualDteDays:median(defined(okStructures.map(c=>c.actualDteDays))),
   noResolutionBeforeExpiryShare:share(determinate.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,determinate.length),
   medianFirstResolutionDays:resolutionEndpoint.percentiles.find(p=>p.p===0.5)?.days??null,
   medianHoldingDays:median(defined(okStructures.map(c=>c.holdingDays))),
  },
  overview:horizons.map(h=>overviewRow(h,structures,scenarioRows,availabilityByHorizon.get(h.nominalDays)!,referenceRows)),
  availability,
  synchronization:horizons.map(h=>{
   const values=[...(availabilityByHorizon.get(h.nominalDays)?.synchronizationMinutes[scenario]??[])];
   return {horizon:h,medianMinutes:median(values),p95Minutes:pct(values,0.95),n:values.length};
  }),
  coverageCurve:coverageFromSurvival(underlying.survival),
  actualDteAll:defined(okStructures.map(c=>c.actualDteDays)),
  outcomeBeforeExpiry:horizons.map(h=>outcomeBeforeExpiryRow(h,structures)),
  dteBuffer:horizons.map(h=>dteBufferRow(h,structures)),
  captureByThreshold:{
   25:horizons.map(h=>captureRow(h,referenceRows,25)),
   50:horizons.map(h=>captureRow(h,referenceRows,50)),
   70:horizons.map(h=>captureRow(h,referenceRows,70)),
  },
  pnlByOutcome:horizons.map(h=>pnlRow(h,referenceRows)),
  holdingPeriod:horizons.map(h=>holdingPeriodRow(h,structures)),
  capitalTime:capitalTimeSummary(scenarioRows),
  operationalHolding,
  adverseDiagnostics:adverseDiagnostics(referenceRows),
  matchedDte:buildMatchedDteComparison(referenceRows,horizons),
  matchedExecution:buildMatchedExecution(allScenarios,horizons),
  resolutionSpeed:buildResolutionSpeedReport(dataset,referenceRows,horizons),
  entryDelay:buildEntryDelayReport(dataset),
  excludedIneligible:structures.length-okStructures.length,
  methodology:[
   `Execution scenario. This report is scoped to the ${scenario} scenario. Maker opportunity is the intended/preferred execution assumption -- historical evidence consistent with a passive fill, never a guaranteed one, and never proof of queue position. Taker is the conservative, tape-based robustness scenario. Both are evaluated independently for the same structure; neither is presented as the universal default strategy.`,
   "Analytical unit. Availability and thesis coverage are counted per MR EVENT x horizon family: one event contributes one observation per horizon however many width/strike variants it generated, so an event that produced six structures never outvotes an event that produced one. Economic comparisons (PnL, adverse path, capture) instead use MATCHED structural variants -- same event, same short-strike method, same width, same structure/option type, same execution scenario -- differing only in horizon/actual DTE, so a width or strike-placement difference is never attributed to duration.",
   "Execution-independent vs execution-dependent. Actual expiry, actual DTE, underlying first-resolution timing, resolution-before-expiry, DTE buffer and thesis-survival window are properties of the STRUCTURE. Operational holding time comes only from the locked complete exit-policy engine's winning trigger, decision timestamp and same-track executable valuation timestamp.",
   "Coverage denominators. Maker-opportunity and taker-executable coverage are each measured independently as: eligible MR events with at least one structure genuinely evaluated under that scenario, divided by eligible MR events (events that generated at least one candidate). They are never inferred from the share of candidate rows whose configured mode happened to be one value, which would report a meaningless 100%.",
   "Legacy execution evidence. Migrated single-scenario observations remain in the dataset and are flagged as legacy undifferentiated, but are excluded from maker-versus-taker matched execution-drag comparisons because they predate independent tape-direction evaluation.",
   "Not evaluated, Unavailable and 0% are three different states and are never conflated. 'Not evaluated' means no structure carries that scenario at all. 'Unavailable' means the scenario was assessed but canonical evidence supported no structure. A 0% is displayed only when a scenario was genuinely evaluated and zero qualifying opportunities existed.",
   "Eligible population. Selected structures whose underlying MR event is itself eligible for Underlying Resolution's time-to-event analysis. Structures excluded there are excluded here and never folded into a resolved or unresolved bucket. The availability funnel is deliberately not gated on that eligibility, since it measures structure-level executability.",
   "Actual DTE is the primary duration variable throughout; the ~7D/~14D/~30D horizon families are grouping and reference bands only, never separate mini-reports.",
   "Resolution semantics reuse Underlying Resolution's authoritative outcome ordering, right-censoring and T_resolution verbatim. The Thesis Survival vs Actual DTE chart is that same Kaplan-Meier curve relabelled as coverage = 1 - S(t), not a second competing censoring model.",
   "Candidate-relative outcomes. Outcome buckets describe what happened WHILE THE STRUCTURE EXISTED, never the underlying event's eventual outcome: a structure whose event reached VPOC only after expiry is a settlement result, not a PnL-at-VPOC row. 'No resolution before expiry' stays one visual category because both cases mean the option did not survive long enough to observe resolution, but it is split internally into 'resolved later' (the MR did resolve, after this expiry) and 'still unresolved' (right-censored at canonical observation end); those states are never merged.",
   "Pre-entry VPOC. A structure entered after canonical VPOC is reported explicitly as 'VPOC already reached before structure entry'. It is never classified as VPOC before expiry, never assigned a PnL at VPOC (which would price an outcome at a timestamp preceding the position), and never given a DTE buffer against a pre-entry resolution. Such structures remain fully in availability, maker/taker, credit-capture, invalidation, adverse-path and settlement analysis.",
   "Thesis-survival window (execution-independent). T_survival = min(post-entry first resolution, expiry) − structure entry. This structural window is not an operational holding period. Operational holding and capital-day return require the selected complete exit policy, its actual priced exit, positive holding days, and the explicitly selected capital basis; missing opening/peak margin is never replaced by width, long-leg cost, or maximum loss.",
   "Worst adverse mark-to-market and MAE-before-profit use only this scenario's RAW-VWAP valuation track between structure entry and the post-entry resolution/censoring boundary. Post-boundary marks never contribute and one scenario's marks never populate the other's. MAE-before-profit is the worst raw mark up to and including the first profitable raw mark, and is reported only for structures that genuinely reached one. Modelled (iv_normalized) marks are never substituted to fill either column; where the raw track carries no priced mark the value stays Unavailable with an inspectable reason.",
   "Resolution-speed cohorts are cut from the naturally observed first-resolution distribution (fast < P25, normal P25-P75, slow > P75) over eligible events. Unresolved events remain an explicit fourth cohort rather than being folded into 'slow'. Cohort statistics are computed inside a single execution scenario.",
   "Entry-delay sensitivity is produced only when the canonical export can support a causal reconstruction at each delayed order time. A delayed scenario may never reuse the original fill, borrow earlier tape, treat a model mark as a historical fill, or assume maker queue execution; where the bundle cannot meet that bar the section reports itself unsupported and names the missing canonical inputs.",
   "No strike selection, width selection, exit-policy optimization, futures comparison or strategy selection is computed anywhere in this report.",
  ],
 };
}
