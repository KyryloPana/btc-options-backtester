import type {AnalysisDataset} from "../research-analysis.ts";
import {buildResearchAnalyticsModel} from "../research-analytics-model.ts";
import type {ExecutionScenario} from "./normalize.ts";

export const ENTRY_DELAY_HOURS=[0,4,8,12] as const;
export type EntryDelayHours=(typeof ENTRY_DELAY_HOURS)[number];
export interface EntryDelaySupportRow {readonly delayHours:EntryDelayHours;readonly structuresWithRawEvidence:Record<ExecutionScenario,number>;readonly supported:boolean;}
export interface EntryDelayScenarioSummary {readonly supportN:number;readonly medianActualDelayHours:number|null;readonly medianRemainingDte:number|null;readonly medianCreditChangeVsReference:number|null;readonly medianOutcomePnl:number|null;readonly preEntryResolutionCount:number;}
export interface EntryDelayReport {readonly supported:boolean;readonly structuresConsidered:number;readonly rows:readonly EntryDelaySupportRow[];readonly scenarioSummary:Record<ExecutionScenario,EntryDelayScenarioSummary>;readonly reason:string|null;readonly requiredCanonicalInputs:readonly string[];}

const median=(values:number[])=>{const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);return xs.length?xs.length%2?xs[(xs.length-1)/2]:(xs[xs.length/2-1]+xs[xs.length/2])/2:null};

/** Canonical delayed snapshots are the sole source of delayed-entry support. */
export function buildEntryDelayReport(dataset:AnalysisDataset):EntryDelayReport{
 const observations=buildResearchAnalyticsModel(dataset).observations;
 const rows=ENTRY_DELAY_HOURS.map(delayHours=>{
  const counts:Record<ExecutionScenario,number>={maker:0,taker:0};
  for(const observation of observations)for(const scenario of ["maker","taker"] as const){
   const delayed=observation.tracks[scenario==="maker"?"delayed_maker":"delayed_taker"];
   if(!delayed||delayed.status!=="available"||delayed.entryTime===null)continue;
   const immediate=observation.tracks[scenario==="maker"?"immediate_maker":"immediate_taker"];
   const actualDelay=immediate?.entryTime===null||immediate?.entryTime===undefined?null:(delayed.entryTime-immediate.entryTime)/36e5;
   const declared=(delayed.entryEvidence&&typeof delayed.entryEvidence==="object")?(delayed.entryEvidence as Record<string,unknown>).delayHours:null;
   if(delayHours===0?immediate?.status==="available":actualDelay!==null&&actualDelay>=delayHours||declared===delayHours)counts[scenario]++;
  }
  // Backward-compatible canonical row form: only an explicitly priced
  // raw_vwap delayed_entry is accepted; ordinary raw closes and model marks are not.
  for(const scenario of ["maker","taker"] as const){
   const ids=new Set((dataset.tables.valuations??[]).filter(v=>v.execution_scenario===scenario&&v.pricing_track==="raw_vwap"&&v.point_role==="delayed_entry"&&v.valuation_status==="priced"&&Number(v.entry_delay_hours??delayHours)===delayHours).map(v=>String(v.candidate_id)));
   counts[scenario]=Math.max(counts[scenario],ids.size);
  }
  return {delayHours,structuresWithRawEvidence:counts,supported:counts.maker>0||counts.taker>0};
 });
 const scenarioSummary=Object.fromEntries((["maker","taker"] as const).map(scenario=>{const tracks=observations.map(o=>o.tracks[scenario==="maker"?"delayed_maker":"delayed_taker"]).filter(Boolean),available=tracks.filter(t=>t!.status==="available"),numbers=(key:string)=>available.map(t=>Number((t!.entryEvidence as Record<string,unknown>|null)?.[key])).filter(Number.isFinite);return[scenario,{supportN:available.length,medianActualDelayHours:median(numbers("delayHours")),medianRemainingDte:median(available.map(t=>t!.actualDteDays??NaN)),medianCreditChangeVsReference:median(numbers("creditChangeVsReferenceBtc")),medianOutcomePnl:median(available.map(t=>t!.economics.pnlNative??NaN)),preEntryResolutionCount:tracks.filter(t=>t!.status==="pre_entry_resolution"||/before.*entry|missed/i.test(t!.reason??"")).length}] })) as Record<ExecutionScenario,EntryDelayScenarioSummary>;
 const delayedPresent=observations.some(o=>o.tracks.delayed_maker||o.tracks.delayed_taker),supported=rows.some(r=>r.delayHours>0&&r.supported);
 return {supported,structuresConsidered:observations.length,rows,scenarioSummary,reason:supported?null:delayedPresent?"Not supported by current canonical export: delayed tracks exist, but none has an available status and usable delayed entry timestamp for the requested offsets.":"Not supported by current canonical export: canonical delayed Maker/Taker snapshots are absent; delayed execution was not evaluated for this bundle.",requiredCanonicalInputs:supported?[]:["An available delayed_maker or delayed_taker snapshot with requested offset, actual evidence timestamp, entry economics, and explicit source provenance."]};
}
