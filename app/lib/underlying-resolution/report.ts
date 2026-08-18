import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents,type NormalizedMrEvent,type ResolutionOutcome} from "./normalize.ts";
import {fiveNumber,kaplanMeier,observedPercentiles,quantiles,riskSummary,type KaplanMeierPoint,type SurvivalObservation} from "./statistics.ts";

/**
 * The one coherent view model for Underlying Resolution. Every card, chart and
 * table in the UI reads from this object, so no value is recomputed in a
 * component and table pagination cannot reach the analytics.
 */

export const PERCENTILES=[0.2,0.5,0.8,0.9] as const;

export interface OutcomeCounts {readonly vpocFirst:number;readonly invalidationFirst:number;readonly ambiguous:number;readonly unresolved:number;readonly total:number}
export interface Percentile {readonly p:number;readonly days:number|null}

/**
 * `method` distinguishes the two legitimate estimators:
 * - `observed conditional`: every event in the conditioning set experienced the
 *   endpoint, so plain empirical percentiles apply.
 * - `kaplan-meier`: unresolved events are genuinely right-censored.
 */
export interface EndpointBlock {
 readonly label:string;
 readonly endpoint:"vpoc"|"invalidation"|"resolution";
 readonly method:"observed conditional"|"kaplan-meier";
 readonly percentiles:readonly Percentile[];
 readonly observed:number;
 readonly censored:number|null;
 readonly effectiveN:number;
 /** Set when the endpoint has no observations at all. */
 readonly emptyReason:string|null;
}

export interface ScatterPoint {readonly eventId:string;readonly distanceRange:number;readonly resolutionDays:number;readonly outcome:ResolutionOutcome}
export interface DirectionSample {readonly label:string;readonly direction:"long"|"short";readonly days:readonly number[];readonly summary:ReturnType<typeof fiveNumber>}
export interface ExcursionSummary {readonly label:string;readonly medianMfeUsd:number|null;readonly medianMaeUsd:number|null;readonly available:number;readonly total:number}
export interface DirectionalRow {readonly direction:"long"|"short"|"total";readonly label:string;readonly counts:OutcomeCounts;readonly effectiveN:number}

export interface UnderlyingResolutionReport {
 readonly events:readonly NormalizedMrEvent[];
 readonly totalEvents:number;
 readonly effectiveN:number;
 readonly excludedByReason:readonly {reason:string;count:number}[];
 readonly counts:OutcomeCounts;
 readonly observedResolutions:number;
 readonly censoredObservations:number;
 readonly endpoints:readonly EndpointBlock[];
 readonly survival:readonly KaplanMeierPoint[];
 readonly distanceVsResolution:readonly ScatterPoint[];
 readonly distanceMissing:number;
 readonly byDirection:readonly DirectionSample[];
 readonly directional:readonly DirectionalRow[];
 readonly excursionOverall:ExcursionSummary;
 readonly excursionByOutcome:readonly ExcursionSummary[];
 readonly methodology:readonly string[];
}

const RESOLVED:readonly ResolutionOutcome[]=["vpoc_first","invalidation_first","ambiguous"];
const isResolved=(e:NormalizedMrEvent)=>RESOLVED.includes(e.outcome);

function tally(events:readonly NormalizedMrEvent[]):OutcomeCounts{
 const of=(o:ResolutionOutcome)=>events.filter(e=>e.outcome===o).length;
 return {vpocFirst:of("vpoc_first"),invalidationFirst:of("invalidation_first"),ambiguous:of("ambiguous"),unresolved:of("unresolved"),total:events.length};
}

/**
 * Conditional endpoint block. Invalidation is a competing terminal outcome for
 * VPOC (and vice versa), not censoring, so the headline percentiles describe the
 * observed distribution among events that actually reached that endpoint first.
 */
function conditionalBlock(label:string,endpoint:"vpoc"|"invalidation",events:readonly NormalizedMrEvent[]):EndpointBlock{
 const target:ResolutionOutcome=endpoint==="vpoc"?"vpoc_first":"invalidation_first";
 const times=events.filter(e=>e.outcome===target)
  .map(e=>endpoint==="vpoc"?e.timeToVpocDays:e.timeToInvalidationDays)
  .filter((x):x is number=>x!==null);
 const values=observedPercentiles(times,PERCENTILES);
 return {
  label,endpoint,method:"observed conditional",
  percentiles:PERCENTILES.map((p,i)=>({p,days:values[i]??null})),
  observed:times.length,censored:null,effectiveN:times.length,
  emptyReason:times.length?null:endpoint==="vpoc"?"No VPOC-first events in the current sample.":"No invalidation-first events in the current sample.",
 };
}

/** First resolution is a genuine right-censored problem, so it stays on Kaplan-Meier. */
function resolutionObservations(events:readonly NormalizedMrEvent[]):SurvivalObservation[]{
 const out:SurvivalObservation[]=[];
 for(const e of events){
  const time=isResolved(e)?e.timeToResolutionDays:e.observationDays;
  if(time!==null&&time>=0)out.push({timeDays:time,observed:isResolved(e)});
 }
 return out;
}

function resolutionBlock(events:readonly NormalizedMrEvent[]):EndpointBlock{
 const obs=resolutionObservations(events),summary=riskSummary(obs),values=quantiles(obs,PERCENTILES);
 return {
  label:"Time to First Resolution",endpoint:"resolution",method:"kaplan-meier",
  percentiles:PERCENTILES.map((p,i)=>({p,days:values[i]??null})),
  observed:summary.observed,censored:summary.censored,effectiveN:summary.effectiveN,
  emptyReason:summary.effectiveN?null:"No events with a usable observation window.",
 };
}

const median=(values:readonly number[]):number|null=>{
 const summary=fiveNumber(values);
 return summary?summary.median:null;
};

function excursionSummary(label:string,events:readonly NormalizedMrEvent[]):ExcursionSummary{
 const withPath=events.filter(e=>e.excursion!==null);
 return {
  label,
  medianMfeUsd:median(withPath.map(e=>e.excursion!.mfeUsd)),
  medianMaeUsd:median(withPath.map(e=>e.excursion!.maeUsd)),
  available:withPath.length,total:events.length,
 };
}

export function buildUnderlyingResolutionReport(dataset:AnalysisDataset):UnderlyingResolutionReport{
 const events=normalizeMrEvents(dataset),eligible=events.filter(e=>e.ineligibility===null);
 const reasons=new Map<string,number>();
 for(const e of events)if(e.ineligibility)reasons.set(e.ineligibility,(reasons.get(e.ineligibility)??0)+1);

 const byDirection=(d:"long"|"short")=>eligible.filter(e=>e.direction===d);
 const resolutionDays=(list:readonly NormalizedMrEvent[])=>list.map(e=>e.timeToResolutionDays).filter((x):x is number=>x!==null);
 const directionSample=(label:string,direction:"long"|"short"):DirectionSample=>{
  const days=resolutionDays(byDirection(direction));
  return {label,direction,days,summary:fiveNumber(days)};
 };

 return {
  events,totalEvents:events.length,effectiveN:eligible.length,
  excludedByReason:[...reasons].map(([reason,count])=>({reason,count})),
  counts:tally(eligible),
  observedResolutions:eligible.filter(isResolved).length,
  censoredObservations:eligible.filter(e=>!isResolved(e)).length,
  endpoints:[
   conditionalBlock("Successful → VPOC","vpoc",eligible),
   conditionalBlock("Failed → Invalidation","invalidation",eligible),
   resolutionBlock(eligible),
  ],
  survival:kaplanMeier(resolutionObservations(eligible)),
  // Descriptive relationship only -- no regression or predictive claim.
  distanceVsResolution:eligible.flatMap(e=>e.remainingDistanceRange===null||e.timeToResolutionDays===null?[]
   :[{eventId:e.eventId,distanceRange:e.remainingDistanceRange,resolutionDays:e.timeToResolutionDays,outcome:e.outcome}]),
  distanceMissing:eligible.filter(e=>e.remainingDistanceRange===null).length,
  byDirection:[directionSample("Bullish MR","long"),directionSample("Bearish MR","short")],
  directional:[
   {direction:"long",label:"Bullish",counts:tally(byDirection("long")),effectiveN:byDirection("long").length},
   {direction:"short",label:"Bearish",counts:tally(byDirection("short")),effectiveN:byDirection("short").length},
   {direction:"total",label:"Total",counts:tally(eligible),effectiveN:eligible.length},
  ],
  excursionOverall:excursionSummary("All eligible events",eligible),
  excursionByOutcome:[
   excursionSummary("VPOC first",eligible.filter(e=>e.outcome==="vpoc_first")),
   excursionSummary("Invalidation first",eligible.filter(e=>e.outcome==="invalidation_first")),
  ],
  methodology:[
   "Eligible population: every MR event in the canonical bundle with a usable observation window. Events without one are reported under data sufficiency and never counted as failures.",
   "Outcome ordering and right-censoring are read from canonical sequence_status and censoring_status; this report does not re-derive them. VPOC-first is a successful resolution, invalidation-first a failed one.",
   "Ambiguous means VPOC and invalidation carry the same canonical timestamp and ordering cannot be established. Intrabar ordering is never fabricated, and an ambiguous event is never counted as a success or a failure.",
   "Unresolved events are right-censored at the canonical observation_end_timestamp_utc. Censored is not failed.",
   "Time to VPOC and Time to Invalidation are observed conditional distributions: plain empirical percentiles among events that actually reached that endpoint first. The competing outcome is a terminal MR result, not censoring, so Kaplan-Meier is deliberately not used for these two.",
   "Time to First Resolution is a genuine right-censored problem and uses Kaplan-Meier percentiles: the smallest time at which event-free probability falls to or below 1-p. Where the curve never descends that far the percentile is Not estimable.",
   "The event-free probability curve shows the chance an MR event has not yet reached first resolution by time t. The band is a 95% log-log interval from Greenwood's variance, shown only where estimable.",
   "MFE/MAE measure the excursion the position had to survive while the thesis was open: entry to first resolution for resolved events, entry to observation end for censored ones. Price action after resolution is excluded. Events without a stored hourly path show Unavailable, never zero.",
   "Remaining distance to VPOC is canonical vpoc_distance expressed in range widths from canonical range_low/range_high. ATR is not part of the canonical bundle and is not used. Events without a usable distance are omitted from the distance plot only, and remain in every count.",
   "Timing compares vpoc_trigger_timestamp_utc against invalidation_decision_timestamp_utc, the same pair the canonical ordering uses, so a displayed time can never contradict the canonical outcome. All times are calendar days.",
  ],
 };
}
