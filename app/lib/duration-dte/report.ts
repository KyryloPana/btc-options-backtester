import type {AnalysisDataset} from "../research-analysis.ts";
import {buildUnderlyingResolutionReport} from "../underlying-resolution/report.ts";
import {fiveNumber,type FiveNumberSummary} from "../underlying-resolution/statistics.ts";
import {
 buildHorizonAvailability,buildHorizonFamilies,globalScenarioCoverage,normalizeDteCandidates,
 type CaptureObservation,type DteCandidate,type ExecutionScenario,type HorizonAvailability,type HorizonFamily,type OutcomeBeforeExpiry,
} from "./normalize.ts";
import {coverageFromSurvival,share,type CoveragePoint} from "./statistics.ts";

/**
 * The one coherent view model for Duration & DTE. Every card, chart and table
 * reads from this object; nothing is recomputed in a component, and no
 * strike/width/exit-policy/futures analysis is calculated here.
 *
 * The report is scoped to ONE execution scenario at a time (`scenario`,
 * defaulting to "maker" -- the intended/preferred assumption, never a
 * guaranteed fill). Coverage/availability figures stay scenario-independent
 * (both maker and taker are always shown), and `executionDrag` compares the
 * two scenarios directly for structures genuinely evaluated under both.
 */

export interface OverviewRow {
 readonly horizon:HorizonFamily;
 readonly selectedN:number;
 readonly notEvaluatedN:number;
 readonly actualDte:FiveNumberSummary|null;
 readonly candidatesGeneratedShare:number|null;
 readonly pricedShare:number|null;
 readonly takerExecutableShare:number|null;
 readonly makerOpportunityShare:number|null;
 readonly resolutionCoverageShare:number|null;
 readonly noResolutionBeforeExpiryShare:number|null;
 readonly medianDteBufferDays:number|null;
 readonly medianTimeToCapture50Days:number|null;
 readonly medianCapitalDayReturn:number|null;
}

export interface OutcomeBeforeExpiryRow {
 readonly horizon:HorizonFamily;
 readonly counts:Record<OutcomeBeforeExpiry,number>;
 readonly determinateN:number;
 /** Selected structures at this horizon whose underlying event resolved but whose actual DTE is unavailable, so before/after-expiry cannot be determined. Never coerced into a bucket. */
 readonly notDeterminableN:number;
}

export interface DteBufferRow {readonly horizon:HorizonFamily;readonly values:readonly number[];readonly summary:FiveNumberSummary|null}

export interface CaptureThresholdRow {
 readonly horizon:HorizonFamily;
 readonly totalN:number;
 readonly reachedN:number;
 readonly timeToCaptureDays:readonly number[];
 readonly beforeVpocShare:number|null;
 readonly beforeInvalidationShare:number|null;
}

export interface PnlBucket {readonly label:string;readonly pnlUsd:readonly number[];readonly worstAdverseUsd:readonly number[]}
export interface PnlByOutcomeRow {readonly horizon:HorizonFamily;readonly buckets:readonly PnlBucket[]}

export interface CapitalTimeSummary {
 readonly available:boolean;
 readonly reason:string|null;
 readonly points:readonly {actualDteDays:number;capitalDayReturn:number}[];
 readonly medianHoldingDays:number|null;
 readonly medianCapitalDays:number|null;
 readonly medianCapitalDayReturn:number|null;
}

export interface HeadlineSummary {
 readonly effectiveEvents:number;
 readonly totalEvents:number;
 /** Distinct events with >=1 selected structure genuinely evaluated as taker, across all horizons. Scenario-independent -- shown regardless of `scenario`. */
 readonly takerExecutableShare:number|null;
 /** Distinct events with >=1 selected structure genuinely evaluated as maker opportunity, across all horizons. Never implies a guaranteed fill. */
 readonly makerOpportunityShare:number|null;
 readonly medianActualDteDays:number|null;
 readonly noResolutionBeforeExpiryShare:number|null;
 readonly medianFirstResolutionDays:number|null;
}

export interface ExecutionDragRow {
 readonly horizon:HorizonFamily;
 /** Structures with BOTH maker and taker genuinely evaluated -- the only population execution drag is computed over. */
 readonly matchedN:number;
 /** Maker-opportunity PnL minus taker PnL, at the same first-resolution trigger, for each matched structure. */
 readonly pnlDragUsd:readonly number[];
 readonly medianPnlDragUsd:number|null;
 readonly capitalDayReturnDrag:readonly number[];
 readonly medianCapitalDayReturnDrag:number|null;
}

export interface DurationDteReport {
 readonly scenario:ExecutionScenario;
 readonly candidates:readonly DteCandidate[];
 readonly horizons:readonly HorizonFamily[];
 readonly headline:HeadlineSummary;
 readonly overview:readonly OverviewRow[];
 readonly availability:readonly HorizonAvailability[];
 readonly coverageCurve:readonly CoveragePoint[];
 readonly actualDteAll:readonly number[];
 readonly outcomeBeforeExpiry:readonly OutcomeBeforeExpiryRow[];
 readonly dteBuffer:readonly DteBufferRow[];
 readonly captureByThreshold:Record<25|50|70,readonly CaptureThresholdRow[]>;
 readonly pnlByOutcome:readonly PnlByOutcomeRow[];
 readonly capitalTime:CapitalTimeSummary;
 readonly executionDrag:readonly ExecutionDragRow[];
 readonly excludedIneligible:number;
 readonly methodology:readonly string[];
}

const zeroCounts=():Record<OutcomeBeforeExpiry,number>=>({vpoc_before_expiry:0,invalidation_before_expiry:0,ambiguous_before_expiry:0,no_resolution_before_expiry:0});
const median=(values:readonly number[]):number|null=>fiveNumber(values)?.median??null;
const eligible=(cs:readonly DteCandidate[])=>cs.filter(c=>c.ineligibilityReason===null);
const atHorizon=(cs:readonly DteCandidate[],nominalDays:number)=>cs.filter(c=>c.horizonNominalDays===nominalDays);
/** Structures genuinely evaluated for the scenario a row represents -- not_evaluated rows are still counted (selectedN), just excluded from economics. */
const evaluatedOnly=(cs:readonly DteCandidate[])=>cs.filter(c=>c.executionScenarioStatus==="evaluated");

function overviewRow(horizon:HorizonFamily,all:readonly DteCandidate[],totalEvents:number,availability:HorizonAvailability):OverviewRow{
 const selected=atHorizon(eligible(all),horizon.nominalDays),evaluated=evaluatedOnly(selected);
 const dte=evaluated.map(c=>c.actualDteDays).filter((x):x is number=>x!==null);
 const determinate=evaluated.filter(c=>c.resolvedBeforeExpiry!==null);
 return {
  horizon,selectedN:selected.length,notEvaluatedN:selected.length-evaluated.length,actualDte:fiveNumber(dte),
  candidatesGeneratedShare:share(availability.candidatesGenerated,totalEvents),
  pricedShare:share(availability.priced,totalEvents),
  takerExecutableShare:share(availability.takerExecutable,totalEvents),
  makerOpportunityShare:share(availability.makerOpportunity,totalEvents),
  resolutionCoverageShare:share(determinate.filter(c=>c.resolvedBeforeExpiry===true).length,determinate.length),
  noResolutionBeforeExpiryShare:share(determinate.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,determinate.length),
  medianDteBufferDays:median(evaluated.map(c=>c.dteBufferDays).filter((x):x is number=>x!==null)),
  medianTimeToCapture50Days:median(evaluated.map(c=>c.capture50?.reached?c.capture50.timeToCaptureDays:null).filter((x):x is number=>x!==null)),
  medianCapitalDayReturn:median(evaluated.map(c=>c.capitalDayReturn).filter((x):x is number=>x!==null)),
 };
}

function outcomeBeforeExpiryRow(horizon:HorizonFamily,all:readonly DteCandidate[]):OutcomeBeforeExpiryRow{
 const selected=evaluatedOnly(atHorizon(eligible(all),horizon.nominalDays)),counts=zeroCounts();
 let determinateN=0;
 for(const c of selected)if(c.outcomeBeforeExpiry){counts[c.outcomeBeforeExpiry]++;determinateN++}
 return {horizon,counts,determinateN,notDeterminableN:selected.length-determinateN};
}

function dteBufferRow(horizon:HorizonFamily,all:readonly DteCandidate[]):DteBufferRow{
 const values=evaluatedOnly(atHorizon(eligible(all),horizon.nominalDays)).map(c=>c.dteBufferDays).filter((x):x is number=>x!==null);
 return {horizon,values,summary:fiveNumber(values)};
}

function captureRow(horizon:HorizonFamily,all:readonly DteCandidate[],threshold:25|50|70):CaptureThresholdRow{
 const selected=evaluatedOnly(atHorizon(eligible(all),horizon.nominalDays));
 const captures=selected.map(c=>threshold===25?c.capture25:threshold===50?c.capture50:c.capture70).filter((x):x is CaptureObservation=>x!==null);
 const reached=captures.filter(c=>c.reached);
 const beforeVpoc=captures.filter(c=>c.beforeVpoc!==null),beforeInvalidation=captures.filter(c=>c.beforeInvalidation!==null);
 return {
  horizon,totalN:captures.length,reachedN:reached.length,
  timeToCaptureDays:reached.map(c=>c.timeToCaptureDays).filter((x):x is number=>x!==null),
  beforeVpocShare:share(beforeVpoc.filter(c=>c.beforeVpoc===true).length,beforeVpoc.length),
  beforeInvalidationShare:share(beforeInvalidation.filter(c=>c.beforeInvalidation===true).length,beforeInvalidation.length),
 };
}

function pnlRow(horizon:HorizonFamily,all:readonly DteCandidate[]):PnlByOutcomeRow{
 const selected=evaluatedOnly(atHorizon(eligible(all),horizon.nominalDays));
 const bucket=(label:string,items:readonly DteCandidate[],pnlOf:(c:DteCandidate)=>number|null):PnlBucket=>({
  label,pnlUsd:items.map(pnlOf).filter((x):x is number=>x!==null),
  worstAdverseUsd:items.map(c=>c.worstAdverseUsd).filter((x):x is number=>x!==null),
 });
 return {horizon,buckets:[
  bucket("VPOC first",selected.filter(c=>c.underlyingOutcome==="vpoc_first"),c=>c.pnlAtVpocUsd),
  bucket("Invalidation first",selected.filter(c=>c.underlyingOutcome==="invalidation_first"),c=>c.pnlAtInvalidationUsd),
  bucket("No resolution before expiry",selected.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry"),c=>c.pnlAtSettlementUsd),
 ]};
}

function capitalTimeSummary(all:readonly DteCandidate[]):CapitalTimeSummary{
 const withCapital=eligible(all).filter(c=>c.executionScenarioStatus==="evaluated"&&c.requiredCapitalUsd!==null&&c.requiredCapitalUsd>0&&c.timeToResolutionDays!==null&&c.timeToResolutionDays>0&&c.capitalDayReturn!==null);
 if(!withCapital.length)return {
  available:false,
  reason:"No canonical margin scenario in this bundle reports an available required-capital figure. Capital-day return is not computed from long-leg cost or maximum loss as a substitute.",
  points:[],medianHoldingDays:null,medianCapitalDays:null,medianCapitalDayReturn:null,
 };
 return {
  available:true,reason:null,
  points:withCapital.map(c=>({actualDteDays:c.actualDteDays!,capitalDayReturn:c.capitalDayReturn!})),
  medianHoldingDays:median(withCapital.map(c=>c.timeToResolutionDays!)),
  medianCapitalDays:median(withCapital.map(c=>c.requiredCapitalUsd!*c.timeToResolutionDays!)),
  medianCapitalDayReturn:median(withCapital.map(c=>c.capitalDayReturn!)),
 };
}

/** realizedPnl at the underlying's own first-resolution outcome -- same definition used throughout this report. */
function realizedPnlOf(c:DteCandidate):number|null{
 if(c.underlyingOutcome==="vpoc_first")return c.pnlAtVpocUsd;
 if(c.underlyingOutcome==="invalidation_first")return c.pnlAtInvalidationUsd;
 if(c.outcomeBeforeExpiry==="no_resolution_before_expiry")return c.pnlAtSettlementUsd;
 return null;
}

/**
 * Execution drag = maker result - taker result, computed only for structures
 * (candidateId) genuinely evaluated under BOTH scenarios -- never comparing a
 * not_evaluated scenario against an evaluated one, and never comparing
 * different structures.
 */
function executionDragRow(horizon:HorizonFamily,all:readonly DteCandidate[]):ExecutionDragRow{
 const selected=atHorizon(eligible(all),horizon.nominalDays);
 const makerByCandidate=new Map(selected.filter(c=>c.executionScenario==="maker"&&c.executionScenarioStatus==="evaluated").map(c=>[c.candidateId,c]));
 const takerByCandidate=new Map(selected.filter(c=>c.executionScenario==="taker"&&c.executionScenarioStatus==="evaluated").map(c=>[c.candidateId,c]));
 const matchedIds=[...makerByCandidate.keys()].filter(id=>takerByCandidate.has(id));
 const pnlDragUsd:number[]=[],capitalDayReturnDrag:number[]=[];
 for(const id of matchedIds){
  const maker=makerByCandidate.get(id)!,taker=takerByCandidate.get(id)!;
  const makerPnl=realizedPnlOf(maker),takerPnl=realizedPnlOf(taker);
  if(makerPnl!==null&&takerPnl!==null)pnlDragUsd.push(makerPnl-takerPnl);
  if(maker.capitalDayReturn!==null&&taker.capitalDayReturn!==null)capitalDayReturnDrag.push(maker.capitalDayReturn-taker.capitalDayReturn);
 }
 return {horizon,matchedN:matchedIds.length,pnlDragUsd,medianPnlDragUsd:median(pnlDragUsd),capitalDayReturnDrag,medianCapitalDayReturnDrag:median(capitalDayReturnDrag)};
}

export function buildDurationDteReport(dataset:AnalysisDataset,scenario:ExecutionScenario="maker"):DurationDteReport{
 const underlying=buildUnderlyingResolutionReport(dataset);
 const allScenarios=normalizeDteCandidates(dataset),horizons=buildHorizonFamilies(dataset),availability=buildHorizonAvailability(dataset,horizons);
 const availabilityByHorizon=new Map(availability.map(a=>[a.nominalDays,a]));
 const globalCoverage=globalScenarioCoverage(dataset);
 // The report body (overview, buffer, capture, PnL, capital-time) is scoped
 // to ONE scenario at a time; coverage/availability and executionDrag below
 // stay scenario-independent and read from allScenarios directly.
 const all=allScenarios.filter(c=>c.executionScenario===scenario);
 const okCandidates=eligible(all);
 const evaluatedOk=evaluatedOnly(okCandidates);
 const resolutionEndpoint=underlying.endpoints.find(b=>b.endpoint==="resolution")!;

 return {
  scenario,
  candidates:all,horizons,
  headline:{
   effectiveEvents:underlying.effectiveN,totalEvents:underlying.totalEvents,
   takerExecutableShare:share(globalCoverage.takerExecutableEvents,globalCoverage.totalEvents),
   makerOpportunityShare:share(globalCoverage.makerOpportunityEvents,globalCoverage.totalEvents),
   medianActualDteDays:median(evaluatedOk.map(c=>c.actualDteDays).filter((x):x is number=>x!==null)),
   noResolutionBeforeExpiryShare:share(evaluatedOk.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,evaluatedOk.filter(c=>c.resolvedBeforeExpiry!==null).length),
   medianFirstResolutionDays:resolutionEndpoint.percentiles.find(p=>p.p===0.5)?.days??null,
  },
  overview:horizons.map(h=>overviewRow(h,all,underlying.totalEvents,availabilityByHorizon.get(h.nominalDays)!)),
  availability,
  coverageCurve:coverageFromSurvival(underlying.survival),
  actualDteAll:evaluatedOk.map(c=>c.actualDteDays).filter((x):x is number=>x!==null),
  outcomeBeforeExpiry:horizons.map(h=>outcomeBeforeExpiryRow(h,all)),
  dteBuffer:horizons.map(h=>dteBufferRow(h,all)),
  captureByThreshold:{
   25:horizons.map(h=>captureRow(h,all,25)),
   50:horizons.map(h=>captureRow(h,all,50)),
   70:horizons.map(h=>captureRow(h,all,70)),
  },
  pnlByOutcome:horizons.map(h=>pnlRow(h,all)),
  capitalTime:capitalTimeSummary(all),
  executionDrag:horizons.map(h=>executionDragRow(h,allScenarios)),
  excludedIneligible:all.length-okCandidates.length,
  methodology:[
   `This report is scoped to the ${scenario} scenario. Maker opportunity is the intended/preferred execution assumption -- historical evidence consistent with a passive fill, never a guaranteed one. Taker is the conservative, tape-based robustness scenario. Neither is described as the universal default strategy.`,
   "Eligible population: selected structures whose underlying MR event is itself eligible for Underlying Resolution's time-to-event analysis. Structures excluded there are excluded here and never folded into a resolved or unresolved bucket.",
   "Two separate gates apply: the availability/executability funnel counts structure-level availability from candidates.jsonl and availability.jsonl exactly as generated, regardless of the underlying event's own eligibility. Resolution coverage, outcome-before-expiry, DTE buffer and PnL-by-outcome additionally require the underlying event to be eligible for time-to-event analysis, since they pair a structure's DTE against T_resolution.",
   "The primary analytical variable is actual selected-contract DTE (candidates.actual_dte_days), not the nominal ~7D/~14D/~30D horizon label. Horizon families group and label candidates by their configured target_horizon_days; they are reference bands, not the analytical variable.",
   "Maker and taker are independently evaluated execution scenarios for the same structure, never one label standing in for both: candidates.jsonl carries one row per (structure, scenario) pair, sharing candidate_id as the stable structural identity. A scenario with execution_scenario_status 'not_evaluated' means historical evidence did not support evaluating it -- it is never displayed as 0% or fabricated from the other scenario's numbers, and it is counted separately (notEvaluatedN) rather than silently dropped.",
   "Taker executable / maker opportunity coverage (headline and per-horizon) counts distinct events with a selected structure genuinely evaluated under that scenario, read directly from canonical execution_scenario_status -- never inferred from a single configured-run label.",
   "Resolution coverage reuses Underlying Resolution's authoritative first-resolution semantics verbatim: outcome ordering, right-censoring and T_resolution are read from the canonical bundle, never re-derived. A candidate resolves before expiry when T_resolution <= actual DTE.",
   "The Thesis Survival vs Actual DTE chart is the same Kaplan-Meier event-free probability curve from Underlying Resolution, relabelled as coverage = 1 - S(t). It is not a second, competing censoring model.",
   "Outcome before expiry has four reconciling buckets: VPOC first, invalidation first, ambiguous (simultaneous), and no resolution before expiry. The last bucket includes both genuinely unresolved events and events that resolved after this candidate's actual DTE -- both mean the option would not have captured the resolution.",
   "DTE buffer = actual DTE - time to first resolution, computed only for resolved events with a known actual DTE. A negative buffer is retained and shown: it means the underlying thesis resolved, per canonical observation, after this candidate's expiry.",
   "Availability collapses two funnel stages the canonical bundle does not separately distinguish: whether an eligible expiry existed and whether both legs were retrievable both live inside a single availability status per generated candidate. 'Candidates generated' and 'Priced (available)' are the two stages the bundle actually supports.",
   "Credit capture times and PnL at VPOC/invalidation/settlement are read from the canonical outcomes table's per-candidate, per-scenario trigger and net PnL fields. 'Before VPOC' / 'before invalidation' compare that capture's trigger timestamp against the same candidate's own VPOC/invalidation trigger; both are canonical fields, never fabricated.",
   "Worst adverse mark-to-market uses only this scenario's raw-VWAP valuation track between entry and first resolution/censoring, mirroring Underlying Resolution's pre-resolution excursion window. Post-resolution valuation points never contribute, and one scenario's marks never populate the other's.",
   "Execution drag (maker result - taker result) is computed only for structures genuinely evaluated under both scenarios -- matched by the same structural candidate_id, never comparing a not_evaluated scenario or two different structures.",
   "Required capital is read from canonical margin scenarios and is never substituted with long-leg cost or theoretical maximum loss. In this bundle no margin scenario reports an available figure, so capital-day return is Unavailable rather than fabricated from a proxy.",
  ],
 };
}
