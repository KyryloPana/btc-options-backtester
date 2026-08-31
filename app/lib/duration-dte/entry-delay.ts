import type {AnalysisDataset} from "../research-analysis.ts";
import {buildResearchAnalyticsModel} from "../research-analytics-model.ts";
import type {ExecutionScenario} from "./normalize.ts";

export const ENTRY_DELAY_HOURS=[0,4,8,12] as const;
export type EntryDelayHours=(typeof ENTRY_DELAY_HOURS)[number];
export interface EntryDelayScenarioSummary {readonly supportN:number;readonly denominatorN:number;readonly economicN:number;readonly medianActualDelayHours:number|null;readonly medianRemainingDte:number|null;readonly medianCreditChangeVsReference:number|null;readonly medianOutcomePnl:number|null;readonly preEntryResolutionCount:number;}
export interface EntryDelaySupportRow {readonly delayHours:EntryDelayHours;readonly structuresWithRawEvidence:Record<ExecutionScenario,number>;readonly summaries:Record<ExecutionScenario,EntryDelayScenarioSummary>;readonly supported:boolean;}
export interface EntryDelayReport {readonly supported:boolean;readonly structuresConsidered:number;readonly rows:readonly EntryDelaySupportRow[];readonly scenarioSummary:Record<ExecutionScenario,EntryDelayScenarioSummary>;readonly reason:string|null;readonly requiredCanonicalInputs:readonly string[];}

const number=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const median=(values:number[])=>{const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);return xs.length?xs.length%2?xs[(xs.length-1)/2]:(xs[xs.length/2-1]+xs[xs.length/2])/2:null};

/**
 * Reads the additive fixed-offset table only. A legacy delayed track represents
 * one search and can never be re-used as evidence for several counterfactuals.
 */
export function buildEntryDelayReport(dataset:AnalysisDataset):EntryDelayReport{
 const observations=buildResearchAnalyticsModel(dataset).observations;
 const canonical=(dataset.tables.entry_delay_sensitivity??[]).filter(r=>[0,4,8,12].includes(Number(r.requested_delay_hours)));
 const rows=ENTRY_DELAY_HOURS.map(delayHours=>{
  const counts:Record<ExecutionScenario,number>={maker:0,taker:0};
  const summaries=Object.fromEntries((["maker","taker"] as const).map(scenario=>{const selected=canonical.filter(r=>r.execution_scenario===scenario&&r.requested_delay_hours===delayHours),available=selected.filter(r=>r.status==="available"),nums=(key:string)=>available.map(r=>number(r[key])).filter((x):x is number=>x!==null),outcome=nums("outcome_pnl_usd").length?nums("outcome_pnl_usd"):nums("outcome_pnl_native");counts[scenario]=new Set(available.map(r=>String(r.candidate_id))).size;return[scenario,{supportN:counts[scenario],denominatorN:new Set(selected.map(r=>String(r.candidate_id))).size,economicN:outcome.length,medianActualDelayHours:median(nums("actual_delay_hours")),medianRemainingDte:median(nums("remaining_actual_dte")),medianCreditChangeVsReference:median(nums("credit_change_vs_reference")),medianOutcomePnl:median(outcome),preEntryResolutionCount:selected.filter(r=>r.status==="pre_entry_resolution").length}]})) as Record<ExecutionScenario,EntryDelayScenarioSummary>;
  return {delayHours,structuresWithRawEvidence:counts,summaries,supported:counts.maker>0||counts.taker>0};
 });
 const scenarioSummary=Object.fromEntries((["maker","taker"] as const).map(scenario=>{
  const selected=canonical.filter(r=>r.execution_scenario===scenario),available=selected.filter(r=>r.status==="available");
  const nums=(key:string)=>available.map(r=>number(r[key])).filter((x):x is number=>x!==null);
  const outcome=nums("outcome_pnl_usd").length?nums("outcome_pnl_usd"):nums("outcome_pnl_native");return [scenario,{supportN:available.length,denominatorN:new Set(selected.map(r=>String(r.candidate_id))).size,economicN:outcome.length,medianActualDelayHours:median(nums("actual_delay_hours")),medianRemainingDte:median(nums("remaining_actual_dte")),medianCreditChangeVsReference:median(nums("credit_change_vs_reference")),medianOutcomePnl:median(outcome),preEntryResolutionCount:selected.filter(r=>r.status==="pre_entry_resolution").length}];
 })) as Record<ExecutionScenario,EntryDelayScenarioSummary>;
 const supported=rows.some(r=>r.supported);
 return {supported,structuresConsidered:observations.length,rows,scenarioSummary,reason:supported?null:"Not supported by current canonical export: independent fixed-offset entry-delay rows are absent or unavailable. Legacy delayed_maker/delayed_taker tracks are retained for backward compatibility but cannot answer 4h/8h/12h counterfactuals.",requiredCanonicalInputs:supported?[]:["entry_delay_sensitivity.jsonl: one independently searched row per candidate_id × requested_delay_hours × execution_scenario, including target and actual timestamps, status, economics, synchronization, and evidence provenance."]};
}
