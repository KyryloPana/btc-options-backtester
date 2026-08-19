import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents} from "../underlying-resolution/normalize.ts";
import {observedPercentiles} from "../underlying-resolution/statistics.ts";
import {realizedPnlOf,type DteCandidate,type HorizonFamily} from "./normalize.ts";
import {share} from "./statistics.ts";

/**
 * Resolution-speed sensitivity: how dependent is each DTE choice on the MR
 * thesis resolving quickly?
 *
 * Cohorts are cut from the NATURALLY OBSERVED first-resolution distribution --
 * the same authoritative per-event timings Underlying Resolution established --
 * never from invented price paths or arbitrary day thresholds:
 *
 *   fast   : T_resolution <  P25
 *   normal : P25 <= T_resolution <= P75
 *   slow   : T_resolution >  P75
 *
 * Events that never resolved stay in their own explicit `unresolved` cohort;
 * they are not slow, and folding them into "slow" would understate how often a
 * thesis simply never arrives.
 *
 * Every statistic is computed inside ONE execution scenario. Maker and taker
 * observations are never mixed within a single number.
 */

export type ResolutionSpeedCohort="fast"|"normal"|"slow"|"unresolved";
export const RESOLUTION_SPEED_COHORTS=["fast","normal","slow","unresolved"] as const;

export interface ResolutionSpeedBoundaries {
 readonly p25Days:number|null;
 readonly p75Days:number|null;
 readonly resolvedEventsN:number;
 readonly unresolvedEventsN:number;
}

export interface ResolutionSpeedCell {
 readonly cohort:ResolutionSpeedCohort;
 readonly n:number;
 /** Share of structures in this cell whose thesis resolved at or before expiry. */
 readonly survivedToResolutionShare:number|null;
 /** Share held to settlement/expiry without a post-entry resolution. */
 readonly settlementShare:number|null;
 readonly medianPnlUsd:number|null;
 readonly medianWorstAdverseUsd:number|null;
 readonly medianCapture50Days:number|null;
}

export interface ResolutionSpeedRow {
 readonly horizon:HorizonFamily;
 readonly cells:readonly ResolutionSpeedCell[];
}

export interface ResolutionSpeedReport {
 readonly boundaries:ResolutionSpeedBoundaries;
 readonly rows:readonly ResolutionSpeedRow[];
 readonly available:boolean;
 readonly reason:string|null;
}

const median=(values:readonly number[]):number|null=>values.length?observedPercentiles(values,[0.5])[0]??null:null;
const defined=(values:readonly (number|null)[]):number[]=>values.filter((x):x is number=>x!==null);

/**
 * Cohort boundaries from the authoritative first-resolution distribution over
 * ELIGIBLE events, counting each event once regardless of how many structures
 * it generated.
 */
export function resolutionSpeedBoundaries(dataset:AnalysisDataset):ResolutionSpeedBoundaries{
 const events=normalizeMrEvents(dataset).filter(e=>e.ineligibility===null);
 const resolved=defined(events.map(e=>e.timeToResolutionDays));
 const [p25,p75]=observedPercentiles(resolved,[0.25,0.75]);
 return {p25Days:p25??null,p75Days:p75??null,resolvedEventsN:resolved.length,unresolvedEventsN:events.length-resolved.length};
}

/** Cohort membership for one event's canonical first-resolution time. */
export function cohortOf(timeToResolutionDays:number|null,b:ResolutionSpeedBoundaries):ResolutionSpeedCohort{
 if(timeToResolutionDays===null)return "unresolved";
 if(b.p25Days!==null&&timeToResolutionDays<b.p25Days)return "fast";
 if(b.p75Days!==null&&timeToResolutionDays>b.p75Days)return "slow";
 return "normal";
}

/**
 * @param candidates rows for ONE execution scenario only -- the caller scopes
 * the population so no cell can ever blend maker and taker evidence.
 */
export function buildResolutionSpeedReport(dataset:AnalysisDataset,candidates:readonly DteCandidate[],horizons:readonly HorizonFamily[]):ResolutionSpeedReport{
 const boundaries=resolutionSpeedBoundaries(dataset);
 if(boundaries.resolvedEventsN<2)return {
  boundaries,rows:[],available:false,
  reason:`Cohort boundaries need at least two resolved MR events to place a P25/P75 cut; this bundle has ${boundaries.resolvedEventsN}. Arbitrary day thresholds are not substituted.`,
 };

 const eligible=candidates.filter(c=>c.ineligibilityReason===null&&c.executionScenarioStatus==="evaluated");
 const rows=horizons.map(horizon=>{
  const at=eligible.filter(c=>c.horizonNominalDays===horizon.nominalDays);
  const cells=RESOLUTION_SPEED_COHORTS.map(cohort=>{
   const group=at.filter(c=>cohortOf(c.timeToResolutionDays,boundaries)===cohort);
   const determinate=group.filter(c=>c.resolvedBeforeExpiry!==null);
   return {
    cohort,n:group.length,
    survivedToResolutionShare:share(determinate.filter(c=>c.resolvedBeforeExpiry===true).length,determinate.length),
    settlementShare:share(group.filter(c=>c.heldToExpiry===true).length,group.filter(c=>c.heldToExpiry!==null).length),
    medianPnlUsd:median(defined(group.map(realizedPnlOf))),
    medianWorstAdverseUsd:median(defined(group.map(c=>c.worstAdverseUsd))),
    medianCapture50Days:median(defined(group.map(c=>c.capture50?.reached?c.capture50.timeToCaptureDays:null))),
   } satisfies ResolutionSpeedCell;
  });
  return {horizon,cells};
 });
 return {boundaries,rows,available:true,reason:null};
}
