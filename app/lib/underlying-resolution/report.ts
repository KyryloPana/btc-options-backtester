import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents,type NormalizedMrEvent,type ResolutionOutcome} from "./normalize.ts";
import {kaplanMeier,quantiles,riskSummary,type KaplanMeierPoint,type SurvivalObservation} from "./statistics.ts";

/**
 * The one coherent view model for Underlying Resolution. Every card, chart,
 * table and cohort in the UI reads from this object, so no calculation is
 * duplicated in a component and table pagination cannot reach the analytics.
 */

export const PERCENTILES=[0.2,0.5,0.8,0.9] as const;
/** Descriptive cohort boundary in range widths -- not an optimized threshold. */
export const DISTANCE_BOUNDARY_RANGE=0.5;
/** Descriptive resolution-speed boundaries in days (24h and 72h). */
export const SPEED_BOUNDARY_DAYS=[1,3] as const;

export interface OutcomeCounts {readonly vpocFirst:number;readonly invalidationFirst:number;readonly ambiguous:number;readonly unresolved:number;readonly total:number}
export interface TimeToEventBlock {readonly label:string;readonly endpoint:"vpoc"|"invalidation"|"resolution";readonly effectiveN:number;readonly observed:number;readonly censored:number;readonly percentiles:readonly {p:number;days:number|null}[]}
export interface CohortRow {readonly label:string;readonly effectiveN:number;readonly observed:number;readonly censored:number;readonly counts:OutcomeCounts;readonly medianMfeUsd:number|null;readonly medianMaeUsd:number|null;readonly excursionUnavailable:number}
export interface DirectionalRow {readonly direction:"long"|"short"|"total";readonly label:string;readonly counts:OutcomeCounts;readonly effectiveN:number}
export interface UnderlyingResolutionReport {
 readonly events:readonly NormalizedMrEvent[];
 readonly eligible:readonly NormalizedMrEvent[];
 readonly totalEvents:number;
 readonly effectiveN:number;
 readonly excludedByReason:readonly {reason:string;count:number}[];
 readonly counts:OutcomeCounts;
 readonly timeToEvent:readonly TimeToEventBlock[];
 readonly survival:readonly KaplanMeierPoint[];
 readonly resolutionTimesByOutcome:readonly {label:string;outcome:ResolutionOutcome;days:readonly number[]}[];
 readonly resolutionTimesByDirection:readonly {label:string;direction:"long"|"short";days:readonly number[]}[];
 readonly resolutionTimesByDistance:readonly {label:string;days:readonly number[]}[];
 readonly directional:readonly DirectionalRow[];
 readonly distanceCohorts:readonly CohortRow[];
 readonly speedCohorts:readonly CohortRow[];
 readonly methodology:readonly string[];
}

const RESOLVED:readonly ResolutionOutcome[]=["vpoc_first","invalidation_first","ambiguous"];
const isResolved=(e:NormalizedMrEvent)=>RESOLVED.includes(e.outcome);

function tally(events:readonly NormalizedMrEvent[]):OutcomeCounts{
 const of=(o:ResolutionOutcome)=>events.filter(e=>e.outcome===o).length;
 return {vpocFirst:of("vpoc_first"),invalidationFirst:of("invalidation_first"),ambiguous:of("ambiguous"),unresolved:of("unresolved"),total:events.length};
}

/** Exit time for an event that did not experience the endpoint in question. */
const censoringTime=(e:NormalizedMrEvent)=>e.timeToResolutionDays??e.observationDays;

/**
 * Observations for one endpoint. Competing outcomes are treated as censored:
 * the event was under observation and simply never experienced this endpoint.
 */
function observationsFor(events:readonly NormalizedMrEvent[],endpoint:"vpoc"|"invalidation"|"resolution"):SurvivalObservation[]{
 const out:SurvivalObservation[]=[];
 for(const e of events){
  if(endpoint==="resolution"){
   const t=isResolved(e)?e.timeToResolutionDays:e.observationDays;
   if(t!==null&&t>=0)out.push({timeDays:t,observed:isResolved(e)});
   continue;
  }
  // `ambiguous` means both levels were touched, so it is an observed event for
  // each individual endpoint even though the ordering is indeterminate.
  const hit=endpoint==="vpoc"?e.timeToVpocDays:e.timeToInvalidationDays;
  if(hit!==null&&hit>=0){out.push({timeDays:hit,observed:true});continue}
  const censor=censoringTime(e);
  if(censor!==null&&censor>=0)out.push({timeDays:censor,observed:false});
 }
 return out;
}

function block(label:string,endpoint:"vpoc"|"invalidation"|"resolution",events:readonly NormalizedMrEvent[]):TimeToEventBlock{
 const obs=observationsFor(events,endpoint),summary=riskSummary(obs),values=quantiles(obs,PERCENTILES);
 return {label,endpoint,...summary,percentiles:PERCENTILES.map((p,i)=>({p,days:values[i]??null}))};
}

const median=(values:readonly number[]):number|null=>{
 const sorted=[...values].sort((a,b)=>a-b);
 if(!sorted.length)return null;
 const mid=sorted.length>>1;
 return sorted.length%2?sorted[mid]!:((sorted[mid-1]!+sorted[mid]!)/2);
};

function cohort(label:string,events:readonly NormalizedMrEvent[]):CohortRow{
 const withExcursion=events.filter(e=>e.excursion!==null);
 return {
  label,effectiveN:events.length,
  observed:events.filter(isResolved).length,
  censored:events.filter(e=>!isResolved(e)).length,
  counts:tally(events),
  medianMfeUsd:median(withExcursion.map(e=>e.excursion!.mfeUsd)),
  medianMaeUsd:median(withExcursion.map(e=>e.excursion!.maeUsd)),
  excursionUnavailable:events.length-withExcursion.length,
 };
}

const resolutionDays=(events:readonly NormalizedMrEvent[])=>events.map(e=>e.timeToResolutionDays).filter((x):x is number=>x!==null);

export function buildUnderlyingResolutionReport(dataset:AnalysisDataset):UnderlyingResolutionReport{
 const events=normalizeMrEvents(dataset),eligible=events.filter(e=>e.ineligibility===null);
 const reasons=new Map<string,number>();
 for(const e of events)if(e.ineligibility)reasons.set(e.ineligibility,(reasons.get(e.ineligibility)??0)+1);

 const byDirection=(d:"long"|"short")=>eligible.filter(e=>e.direction===d);
 const near=eligible.filter(e=>e.remainingDistanceRange!==null&&e.remainingDistanceRange<DISTANCE_BOUNDARY_RANGE),
  far=eligible.filter(e=>e.remainingDistanceRange!==null&&e.remainingDistanceRange>=DISTANCE_BOUNDARY_RANGE),
  distanceMissing=eligible.filter(e=>e.remainingDistanceRange===null);

 const resolved=eligible.filter(isResolved),
  fast=resolved.filter(e=>e.timeToResolutionDays!==null&&e.timeToResolutionDays<SPEED_BOUNDARY_DAYS[0]),
  mid=resolved.filter(e=>e.timeToResolutionDays!==null&&e.timeToResolutionDays>=SPEED_BOUNDARY_DAYS[0]&&e.timeToResolutionDays<SPEED_BOUNDARY_DAYS[1]),
  slow=resolved.filter(e=>e.timeToResolutionDays!==null&&e.timeToResolutionDays>=SPEED_BOUNDARY_DAYS[1]),
  notAssignable=eligible.filter(e=>!isResolved(e));

 return {
  events,eligible,totalEvents:events.length,effectiveN:eligible.length,
  excludedByReason:[...reasons].map(([reason,count])=>({reason,count})),
  counts:tally(eligible),
  timeToEvent:[
   block("Time to VPOC","vpoc",eligible),
   block("Time to Invalidation","invalidation",eligible),
   block("Time to First Resolution","resolution",eligible),
  ],
  survival:kaplanMeier(observationsFor(eligible,"resolution")),
  resolutionTimesByOutcome:[
   {label:"Successful (VPOC before invalidation)",outcome:"vpoc_first",days:resolutionDays(eligible.filter(e=>e.outcome==="vpoc_first"))},
   {label:"Failed (invalidation before VPOC)",outcome:"invalidation_first",days:resolutionDays(eligible.filter(e=>e.outcome==="invalidation_first"))},
   {label:"Ambiguous (simultaneous)",outcome:"ambiguous",days:resolutionDays(eligible.filter(e=>e.outcome==="ambiguous"))},
  ],
  resolutionTimesByDirection:[
   {label:"Bullish MR",direction:"long",days:resolutionDays(byDirection("long"))},
   {label:"Bearish MR",direction:"short",days:resolutionDays(byDirection("short"))},
  ],
  resolutionTimesByDistance:[
   {label:"< "+DISTANCE_BOUNDARY_RANGE+"x range",days:resolutionDays(near)},
   {label:">= "+DISTANCE_BOUNDARY_RANGE+"x range",days:resolutionDays(far)},
  ],
  directional:[
   {direction:"long",label:"Bullish",counts:tally(byDirection("long")),effectiveN:byDirection("long").length},
   {direction:"short",label:"Bearish",counts:tally(byDirection("short")),effectiveN:byDirection("short").length},
   {direction:"total",label:"Total",counts:tally(eligible),effectiveN:eligible.length},
  ],
  distanceCohorts:[
   cohort("< "+DISTANCE_BOUNDARY_RANGE+"x range",near),
   cohort(">= "+DISTANCE_BOUNDARY_RANGE+"x range",far),
   cohort("Distance unavailable",distanceMissing),
  ],
  speedCohorts:[
   cohort("< 24h",fast),
   cohort("24-72h",mid),
   cohort(">= 72h",slow),
   cohort("Unresolved (not assignable)",notAssignable),
  ],
  methodology:[
   "Outcome ordering and right-censoring are read from the canonical bundle fields sequence_status and censoring_status; this report does not re-derive them.",
   "Timing compares vpoc_trigger_timestamp_utc against invalidation_decision_timestamp_utc -- the same pair the canonical ordering uses -- so a displayed time can never contradict the canonical outcome.",
   "The observation horizon is the canonical observation_end_timestamp_utc of the event. Option entry/expiry windows are never used as the MR observation or censoring horizon.",
   "Right-censored events are unresolved, not failed. They remain in the Kaplan-Meier risk set until their censoring time and are counted in every denominator.",
   "Percentiles are Kaplan-Meier quantiles, not raw order statistics: the smallest time at which event-free probability falls to or below 1-p. Where the curve never descends that far the percentile is Not estimable rather than a number.",
   "Time to VPOC and Time to Invalidation treat the competing outcome as censoring. An ambiguous event touched both levels and counts as observed for each individual endpoint, but is never counted as a success or a failure.",
   "Remaining distance to VPOC is canonical vpoc_distance (USD), expressed in range widths using canonical range_low/range_high. ATR is not part of the canonical bundle and is not used.",
   "MFE/MAE are derived from canonical hourly underlying_path OHLC between entry and observation end. Events without a stored path show Unavailable, never zero.",
   "Events with no observation window are held out of time-to-event analysis and reported under data sufficiency rather than being censored at time zero.",
  ],
 };
}
