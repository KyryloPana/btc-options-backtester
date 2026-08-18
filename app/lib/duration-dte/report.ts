import type {AnalysisDataset} from "../research-analysis.ts";
import {buildUnderlyingResolutionReport} from "../underlying-resolution/report.ts";
import {fiveNumber,type FiveNumberSummary} from "../underlying-resolution/statistics.ts";
import {
 buildHorizonAvailability,buildHorizonFamilies,normalizeDteCandidates,
 type CaptureObservation,type DteCandidate,type HorizonAvailability,type HorizonFamily,type OutcomeBeforeExpiry,
} from "./normalize.ts";
import {coverageFromSurvival,share,type CoveragePoint} from "./statistics.ts";

/**
 * The one coherent view model for Duration & DTE. Every card, chart and table
 * reads from this object; nothing is recomputed in a component, and no
 * strike/width/exit-policy/futures analysis is calculated here.
 */

export interface OverviewRow {
 readonly horizon:HorizonFamily;
 readonly selectedN:number;
 readonly actualDte:FiveNumberSummary|null;
 readonly candidatesGeneratedShare:number|null;
 readonly pricedShare:number|null;
 readonly takerExecutableShare:number|null;
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
 readonly takerExecutableShare:number|null;
 readonly medianActualDteDays:number|null;
 readonly noResolutionBeforeExpiryShare:number|null;
 readonly medianFirstResolutionDays:number|null;
}

export interface DurationDteReport {
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
 readonly excludedIneligible:number;
 readonly methodology:readonly string[];
}

const zeroCounts=():Record<OutcomeBeforeExpiry,number>=>({vpoc_before_expiry:0,invalidation_before_expiry:0,ambiguous_before_expiry:0,no_resolution_before_expiry:0});
const median=(values:readonly number[]):number|null=>fiveNumber(values)?.median??null;
const eligible=(cs:readonly DteCandidate[])=>cs.filter(c=>c.ineligibilityReason===null);
const atHorizon=(cs:readonly DteCandidate[],nominalDays:number)=>cs.filter(c=>c.horizonNominalDays===nominalDays);

function overviewRow(horizon:HorizonFamily,all:readonly DteCandidate[],totalEvents:number,availability:HorizonAvailability):OverviewRow{
 const selected=atHorizon(eligible(all),horizon.nominalDays),dte=selected.map(c=>c.actualDteDays).filter((x):x is number=>x!==null);
 const determinate=selected.filter(c=>c.resolvedBeforeExpiry!==null);
 return {
  horizon,selectedN:selected.length,actualDte:fiveNumber(dte),
  candidatesGeneratedShare:share(availability.candidatesGenerated,totalEvents),
  pricedShare:share(availability.priced,totalEvents),
  takerExecutableShare:share(availability.takerExecutable,totalEvents),
  resolutionCoverageShare:share(determinate.filter(c=>c.resolvedBeforeExpiry===true).length,determinate.length),
  noResolutionBeforeExpiryShare:share(determinate.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,determinate.length),
  medianDteBufferDays:median(selected.map(c=>c.dteBufferDays).filter((x):x is number=>x!==null)),
  medianTimeToCapture50Days:median(selected.map(c=>c.capture50?.reached?c.capture50.timeToCaptureDays:null).filter((x):x is number=>x!==null)),
  medianCapitalDayReturn:median(selected.map(c=>c.capitalDayReturn).filter((x):x is number=>x!==null)),
 };
}

function outcomeBeforeExpiryRow(horizon:HorizonFamily,all:readonly DteCandidate[]):OutcomeBeforeExpiryRow{
 const selected=atHorizon(eligible(all),horizon.nominalDays),counts=zeroCounts();
 let determinateN=0;
 for(const c of selected)if(c.outcomeBeforeExpiry){counts[c.outcomeBeforeExpiry]++;determinateN++}
 return {horizon,counts,determinateN,notDeterminableN:selected.length-determinateN};
}

function dteBufferRow(horizon:HorizonFamily,all:readonly DteCandidate[]):DteBufferRow{
 const values=atHorizon(eligible(all),horizon.nominalDays).map(c=>c.dteBufferDays).filter((x):x is number=>x!==null);
 return {horizon,values,summary:fiveNumber(values)};
}

function captureRow(horizon:HorizonFamily,all:readonly DteCandidate[],threshold:25|50|70):CaptureThresholdRow{
 const selected=atHorizon(eligible(all),horizon.nominalDays);
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
 const selected=atHorizon(eligible(all),horizon.nominalDays);
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
 const withCapital=eligible(all).filter(c=>c.requiredCapitalUsd!==null&&c.requiredCapitalUsd>0&&c.timeToResolutionDays!==null&&c.timeToResolutionDays>0&&c.capitalDayReturn!==null);
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

export function buildDurationDteReport(dataset:AnalysisDataset):DurationDteReport{
 const underlying=buildUnderlyingResolutionReport(dataset);
 const all=normalizeDteCandidates(dataset),horizons=buildHorizonFamilies(dataset),availability=buildHorizonAvailability(dataset,horizons);
 const availabilityByHorizon=new Map(availability.map(a=>[a.nominalDays,a]));
 const okCandidates=eligible(all);
 const resolutionEndpoint=underlying.endpoints.find(b=>b.endpoint==="resolution")!;

 return {
  candidates:all,horizons,
  headline:{
   effectiveEvents:underlying.effectiveN,totalEvents:underlying.totalEvents,
   takerExecutableShare:share(okCandidates.filter(c=>c.executionMode==="taker").length,okCandidates.length),
   medianActualDteDays:median(okCandidates.map(c=>c.actualDteDays).filter((x):x is number=>x!==null)),
   noResolutionBeforeExpiryShare:share(okCandidates.filter(c=>c.outcomeBeforeExpiry==="no_resolution_before_expiry").length,okCandidates.filter(c=>c.resolvedBeforeExpiry!==null).length),
   medianFirstResolutionDays:resolutionEndpoint.percentiles.find(p=>p.p===0.5)?.days??null,
  },
  overview:horizons.map(h=>overviewRow(h,all,underlying.totalEvents,availabilityByHorizon.get(h.nominalDays)!)),
  availability,
  coverageCurve:coverageFromSurvival(underlying.survival),
  actualDteAll:okCandidates.map(c=>c.actualDteDays).filter((x):x is number=>x!==null),
  outcomeBeforeExpiry:horizons.map(h=>outcomeBeforeExpiryRow(h,all)),
  dteBuffer:horizons.map(h=>dteBufferRow(h,all)),
  captureByThreshold:{
   25:horizons.map(h=>captureRow(h,all,25)),
   50:horizons.map(h=>captureRow(h,all,50)),
   70:horizons.map(h=>captureRow(h,all,70)),
  },
  pnlByOutcome:horizons.map(h=>pnlRow(h,all)),
  capitalTime:capitalTimeSummary(all),
  excludedIneligible:all.length-okCandidates.length,
  methodology:[
   "Eligible population: selected structures whose underlying MR event is itself eligible for Underlying Resolution's time-to-event analysis. Structures excluded there are excluded here and never folded into a resolved or unresolved bucket.",
   "Two separate gates apply: the availability/executability funnel counts structure-level availability from candidates.jsonl and availability.jsonl exactly as generated, regardless of the underlying event's own eligibility. Resolution coverage, outcome-before-expiry, DTE buffer and PnL-by-outcome additionally require the underlying event to be eligible for time-to-event analysis, since they pair a structure's DTE against T_resolution.",
   "The primary analytical variable is actual selected-contract DTE (candidates.actual_dte_days), not the nominal ~7D/~14D/~30D horizon label. Horizon families group and label candidates by their configured target_horizon_days; they are reference bands, not the analytical variable.",
   "Resolution coverage reuses Underlying Resolution's authoritative first-resolution semantics verbatim: outcome ordering, right-censoring and T_resolution are read from the canonical bundle, never re-derived. A candidate resolves before expiry when T_resolution <= actual DTE.",
   "The Thesis Survival vs Actual DTE chart is the same Kaplan-Meier event-free probability curve from Underlying Resolution, relabelled as coverage = 1 - S(t). It is not a second, competing censoring model.",
   "Outcome before expiry has four reconciling buckets: VPOC first, invalidation first, ambiguous (simultaneous), and no resolution before expiry. The last bucket includes both genuinely unresolved events and events that resolved after this candidate's actual DTE -- both mean the option would not have captured the resolution.",
   "DTE buffer = actual DTE - time to first resolution, computed only for resolved events with a known actual DTE. A negative buffer is retained and shown: it means the underlying thesis resolved, per canonical observation, after this candidate's expiry.",
   "Availability collapses two funnel stages the canonical bundle does not separately distinguish: whether an eligible expiry existed and whether both legs were retrievable both live inside a single availability status per generated candidate. 'Candidates generated' and 'Priced (available)' are the two stages the bundle actually supports.",
   "execution_mode is the configured assumption for the generation run, not an independently generated maker-and-taker outcome per candidate. Taker is reported as the conservative executable baseline; maker is reported separately as opportunity only, never as confirmed execution.",
   "Credit capture times and PnL at VPOC/invalidation/settlement are read from the canonical outcomes table's per-candidate trigger and net PnL fields. 'Before VPOC' / 'before invalidation' compare that capture's trigger timestamp against the same candidate's own VPOC/invalidation trigger; both are canonical fields, never fabricated.",
   "Worst adverse mark-to-market uses only the raw-VWAP valuation track between entry and first resolution/censoring, mirroring Underlying Resolution's pre-resolution excursion window. Post-resolution valuation points never contribute.",
   "Required capital is read from canonical margin scenarios and is never substituted with long-leg cost or theoretical maximum loss. In this bundle no margin scenario reports an available figure, so capital-day return is Unavailable rather than fabricated from a proxy.",
  ],
 };
}
