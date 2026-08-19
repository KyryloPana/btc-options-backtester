import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents,type ResolutionOutcome} from "../underlying-resolution/normalize.ts";

/**
 * Canonical research bundle 2.2.0 -> normalized Duration/DTE structures.
 *
 * This module joins `candidates.jsonl` (selected structures), `availability.jsonl`
 * (the full generated denominator, selected and unselected), `outcomes.jsonl`
 * (per-candidate outcome-at-trigger records) and `valuations.jsonl` (the 4h
 * valuation grid) against the SAME authoritative per-event resolution facts
 * Underlying Resolution already establishes (`normalizeMrEvents`). Outcome
 * ordering, censoring and first-resolution timing are never re-derived here.
 *
 * The analytical variable throughout is actual selected-contract DTE
 * (`candidates.actual_dte_days`), not the nominal `target_horizon_days` label.
 * `target_horizon_days` is used only as a grouping/reference key.
 *
 * Execution scenario: candidates.jsonl carries one row per (structure,
 * execution scenario) pair, sharing candidate_id as the stable structural
 * identity. `execution_scenario` ("maker"|"taker") and `execution_scenario_status`
 * ("evaluated"|"not_evaluated") are read verbatim -- maker and taker are two
 * genuinely, independently evaluated scenarios, never one label standing in
 * for both. A not_evaluated row keeps its structural fields (expiry, strikes,
 * DTE-eligibility band) but every execution-dependent field (actual DTE,
 * prices, PnL, capture) is null on that row, since the canonical bundle never
 * evaluated it -- this module does not fabricate a 0 or borrow the other
 * scenario's numbers.
 *
 * Canonical granularity note: `availability.jsonl` records a single
 * `status` ("priced" | "unavailable") per generated candidate. The bundle does
 * not separately distinguish "an eligible expiry existed" from "both legs were
 * retrievable" -- those two funnel stages collapse into one canonical
 * availability status.
 */

export type EntryQuality="green"|"yellow"|"red";
export type ExecutionScenario="maker"|"taker";
export type ExecutionScenarioStatus="evaluated"|"not_evaluated";
/** The four mutually exclusive, reconciling outcome-before-expiry buckets. */
export type OutcomeBeforeExpiry="vpoc_before_expiry"|"invalidation_before_expiry"|"ambiguous_before_expiry"|"no_resolution_before_expiry";

export interface EligibleDteRange {readonly min:number;readonly max:number}
export interface HorizonFamily {readonly nominalDays:number;readonly label:string;readonly eligibleDteRange:EligibleDteRange|null}

export interface CaptureObservation {
 readonly thresholdPct:25|50|70;
 readonly reached:boolean;
 readonly timeToCaptureDays:number|null;
 /** Null when the event never experienced that endpoint, not merely "false". */
 readonly beforeVpoc:boolean|null;
 readonly beforeInvalidation:boolean|null;
}

export interface DteCandidate {
 readonly eventId:string;
 readonly candidateId:string;
 /** The genuine per-row key: one structure has one row per scenario, sharing candidateId. */
 readonly structureExecutionId:string;
 readonly horizonNominalDays:number|null;
 readonly structureType:string|null;
 readonly executionScenario:ExecutionScenario|null;
 readonly executionScenarioStatus:ExecutionScenarioStatus|null;
 /** Why this scenario is not_evaluated; null when evaluated or status is unknown. */
 readonly executionScenarioReason:string|null;
 readonly entryQuality:EntryQuality|null;
 readonly synchronizationMinutes:number|null;
 readonly entryTimestampMs:number|null;
 readonly expiryTimestampMs:number|null;
 /** The primary analytical variable: actual selected-contract DTE in days. Null for a not_evaluated scenario. */
 readonly actualDteDays:number|null;

 /** Authoritative underlying facts, joined from Underlying Resolution -- never re-derived. Identical across a structure's maker/taker rows. */
 readonly underlyingOutcome:ResolutionOutcome;
 readonly underlyingCensored:boolean;
 readonly timeToResolutionDays:number|null;
 readonly timeToVpocDays:number|null;
 readonly timeToInvalidationDays:number|null;

 /** Null when the underlying event is ineligible for time-to-event analysis, or when this scenario was not evaluated (no actual DTE to compare against). */
 readonly resolvedBeforeExpiry:boolean|null;
 readonly outcomeBeforeExpiry:OutcomeBeforeExpiry|null;
 /** actualDteDays - timeToResolutionDays. Only defined for a resolved event with a known actual DTE. Negative means expiry occurred before the thesis resolved. */
 readonly dteBufferDays:number|null;

 readonly pnlAtVpocUsd:number|null;
 readonly pnlAtInvalidationUsd:number|null;
 readonly pnlAtSettlementUsd:number|null;
 /** Most adverse mark-to-market before resolution/censoring, from this scenario's raw-VWAP valuation track. Null means Unavailable. */
 readonly worstAdverseUsd:number|null;

 readonly capture25:CaptureObservation|null;
 readonly capture50:CaptureObservation|null;
 readonly capture70:CaptureObservation|null;

 /** Always null unless a canonical margin scenario is genuinely available -- read, never assumed. */
 readonly requiredCapitalUsd:number|null;
 readonly capitalDayReturn:number|null;

 /** Set when this candidate's underlying event could not join the authoritative resolution model. */
 readonly ineligibilityReason:string|null;
}

export interface HorizonAvailability {
 readonly nominalDays:number;
 readonly label:string;
 readonly totalEvents:number;
 readonly candidatesGenerated:number;
 readonly priced:number;
 readonly selected:number;
 /** Distinct events with a selected structure genuinely evaluated (evidence-supported) under the taker scenario. */
 readonly takerExecutable:number;
 /** Distinct events with a selected structure genuinely evaluated (evidence-supported) under the maker scenario. Never a guaranteed fill. */
 readonly makerOpportunity:number;
 readonly entryQuality:{readonly green:number;readonly yellow:number;readonly red:number;readonly unavailable:number};
 readonly synchronizationMinutes:readonly number[];
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const bool=(v:unknown):boolean|null=>typeof v==="boolean"?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const DAY=864e5;
const QUALITIES=new Set(["green","yellow","red"]);
const quality=(v:unknown):EntryQuality|null=>{const s=str(v);return s&&QUALITIES.has(s)?s as EntryQuality:null};
const scenarioOf=(v:unknown):ExecutionScenario|null=>{const s=str(v);return s==="maker"||s==="taker"?s:null};
const scenarioStatusOf=(v:unknown):ExecutionScenarioStatus|null=>{const s=str(v);return s==="evaluated"||s==="not_evaluated"?s:null};

function horizonLabel(nominalDays:number):string{return `~${nominalDays}D`}

/** Reads `candidates.eligible_dte_range` verbatim; never invents a boundary. */
function eligibleDteRange(row:Readonly<Record<string,unknown>>):EligibleDteRange|null{
 const raw=row.eligible_dte_range;
 if(!raw||typeof raw!=="object")return null;
 const min=num((raw as Record<string,unknown>).min),max=num((raw as Record<string,unknown>).max);
 return min!==null&&max!==null?{min,max}:null;
}

export function buildHorizonFamilies(dataset:AnalysisDataset):readonly HorizonFamily[]{
 const availability=dataset.tables.availability??[],candidates=dataset.tables.candidates??[];
 const nominals=new Set<number>();
 for(const row of availability){const n=num(row.target_horizon_days);if(n!==null)nominals.add(n)}
 for(const row of candidates){const n=num(row.target_horizon_days);if(n!==null)nominals.add(n)}
 return [...nominals].sort((a,b)=>a-b).map(nominalDays=>{
  const withRange=candidates.find(c=>num(c.target_horizon_days)===nominalDays&&eligibleDteRange(c)!==null);
  return {nominalDays,label:horizonLabel(nominalDays),eligibleDteRange:withRange?eligibleDteRange(withRange):null};
 });
}

/**
 * Actual selected-contract DTE, preferring the explicit day count, then hours,
 * then the raw candidate-level DTE field. All three come from the same
 * canonical `candidates` row; this is a fallback chain, not a substitution.
 */
function actualDte(row:Readonly<Record<string,unknown>>):number|null{
 return num(row.actual_dte_days)??(num(row.actual_dte_hours)!==null?num(row.actual_dte_hours)!/24:null)??num(row.actual_dte);
}

/**
 * Most adverse mark-to-market between entry and the resolution/censoring
 * boundary, from THIS scenario's raw-VWAP valuation track only -- the
 * conservative, executable-evidence track, not the modeled one. Filtering by
 * execution_scenario as well as candidate_id matters once a structure has two
 * scenario rows: without it, a maker row could silently read taker's marks.
 */
function worstAdverse(valuations:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,entryMs:number|null,boundaryMs:number|null):number|null{
 if(entryMs===null||boundaryMs===null||scenario===null)return null;
 let worst:number|null=null;
 for(const row of valuations){
  if(row.candidate_id!==candidateId||row.execution_scenario!==scenario||row.pricing_track!=="raw_vwap"||row.valuation_status!=="priced")continue;
  const t=ms(row.timestamp_utc);
  if(t===null||t<entryMs||t>boundaryMs)continue;
  const pnl=num(row.net_pnl_usd)??num(row.net_pnl_native);
  if(pnl===null)continue;
  if(worst===null||pnl<worst)worst=pnl;
 }
 return worst;
}

function captureObservation(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,threshold:25|50|70,entryMs:number|null,timeToVpocDays:number|null,timeToInvalidationDays:number|null):CaptureObservation|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===`credit_capture_${threshold}`);
 if(!row)return null;
 const triggerMs=row.status==="priced"?ms(row.trigger_timestamp_utc):null;
 const timeToCaptureDays=triggerMs!==null&&entryMs!==null?(triggerMs-entryMs)/DAY:null;
 return {
  thresholdPct:threshold,reached:row.status==="priced",timeToCaptureDays,
  beforeVpoc:timeToVpocDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToVpocDays:null,
  beforeInvalidation:timeToInvalidationDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToInvalidationDays:null,
 };
}

function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===kind);
 if(!row||row.status!=="priced")return null;
 return num(row.net_pnl_usd)??num(row.net_pnl_native);
}

export function normalizeDteCandidates(dataset:AnalysisDataset):readonly DteCandidate[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],valuations=dataset.tables.valuations??[],margins=dataset.tables.margin_scenarios??[];
 const eventsById=new Map(normalizeMrEvents(dataset).map(e=>[e.eventId,e]));

 return candidates.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",candidateId=str(row.candidate_id)??"unknown-candidate";
  const scenario=scenarioOf(row.execution_scenario),scenarioStatus=scenarioStatusOf(row.execution_scenario_status);
  const structureExecutionId=str(row.structure_execution_id)??`${candidateId}~${scenario??"unknown"}`;
  const evaluated=scenarioStatus==="evaluated";
  const event=eventsById.get(eventId);
  const entry=ms(row.structure_entry_timestamp_utc),expiry=ms(row.expiry_timestamp_utc),dte=evaluated?actualDte(row):null;

  if(!event||event.ineligibility!==null){
   return {
    eventId,candidateId,structureExecutionId,horizonNominalDays:num(row.target_horizon_days),structureType:str(row.structure_type),
    executionScenario:scenario,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
    entryQuality:quality(row.entry_quality),
    synchronizationMinutes:num(row.spread_synchronization_minutes),entryTimestampMs:entry,expiryTimestampMs:expiry,actualDteDays:dte,
    underlyingOutcome:"unresolved",underlyingCensored:true,timeToResolutionDays:null,timeToVpocDays:null,timeToInvalidationDays:null,
    resolvedBeforeExpiry:null,outcomeBeforeExpiry:null,dteBufferDays:null,
    pnlAtVpocUsd:null,pnlAtInvalidationUsd:null,pnlAtSettlementUsd:null,worstAdverseUsd:null,
    capture25:null,capture50:null,capture70:null,requiredCapitalUsd:null,capitalDayReturn:null,
    ineligibilityReason:event?.ineligibility??"missing_underlying_event",
   } satisfies DteCandidate;
  }

  const resolved=event.outcome==="vpoc_first"||event.outcome==="invalidation_first"||event.outcome==="ambiguous";
  const resolvedBeforeExpiry=resolved&&event.timeToResolutionDays!==null&&dte!==null?event.timeToResolutionDays<=dte:resolved?null:false;
  const outcomeBeforeExpiry:OutcomeBeforeExpiry|null=
   dte===null?null
   :resolvedBeforeExpiry===null?null
   :!resolvedBeforeExpiry?"no_resolution_before_expiry"
   :event.outcome==="vpoc_first"?"vpoc_before_expiry"
   :event.outcome==="invalidation_first"?"invalidation_before_expiry"
   :"ambiguous_before_expiry";
  const dteBufferDays=resolved&&event.timeToResolutionDays!==null&&dte!==null?dte-event.timeToResolutionDays:null;

  const marginRow=margins.find(m=>m.candidate_id===candidateId),
   marginAvailable=marginRow?.margin_status==="available",
   requiredCapitalUsd=marginAvailable?num(marginRow!.maximum_loss_usd)??num(marginRow!.peak_initial_margin):null;
  const pnlAtVpocUsd=pnlAt(outcomes,candidateId,scenario,"vpoc"),pnlAtInvalidationUsd=pnlAt(outcomes,candidateId,scenario,"invalidation"),pnlAtSettlementUsd=pnlAt(outcomes,candidateId,scenario,"settlement");
  const realizedPnl=event.outcome==="vpoc_first"?pnlAtVpocUsd:event.outcome==="invalidation_first"?pnlAtInvalidationUsd:!resolved?pnlAtSettlementUsd:null;
  const capitalDayReturn=requiredCapitalUsd!==null&&requiredCapitalUsd!==0&&realizedPnl!==null&&event.timeToResolutionDays!==null&&event.timeToResolutionDays>0
   ?realizedPnl/(requiredCapitalUsd*event.timeToResolutionDays):null;

  const boundaryMs=event.resolutionTimestampMs??(event.entryTimestampMs!==null&&event.observationDays!==null?event.entryTimestampMs+event.observationDays*DAY:null);

  return {
   eventId,candidateId,structureExecutionId,horizonNominalDays:num(row.target_horizon_days),structureType:str(row.structure_type),
   executionScenario:scenario,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
   entryQuality:quality(row.entry_quality),
   synchronizationMinutes:num(row.spread_synchronization_minutes),entryTimestampMs:entry,expiryTimestampMs:expiry,actualDteDays:dte,
   underlyingOutcome:event.outcome,underlyingCensored:event.censored,
   timeToResolutionDays:event.timeToResolutionDays,timeToVpocDays:event.timeToVpocDays,timeToInvalidationDays:event.timeToInvalidationDays,
   resolvedBeforeExpiry,outcomeBeforeExpiry,dteBufferDays,
   pnlAtVpocUsd,pnlAtInvalidationUsd,pnlAtSettlementUsd,
   worstAdverseUsd:worstAdverse(valuations,candidateId,scenario,entry,boundaryMs),
   capture25:captureObservation(outcomes,candidateId,scenario,25,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture50:captureObservation(outcomes,candidateId,scenario,50,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture70:captureObservation(outcomes,candidateId,scenario,70,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   requiredCapitalUsd,capitalDayReturn,
   ineligibilityReason:null,
  } satisfies DteCandidate;
 });
}

/**
 * Coverage funnel and quality/sync stats per nominal horizon, at EVENT
 * granularity: one MR event is one observation even when it produced several
 * candidates at the same horizon, so every stage below counts distinct events.
 *
 * takerExecutable/makerOpportunity are now read from genuine, independent
 * per-row execution_scenario_status values -- never a single configured-run
 * label standing in for both scenarios.
 */
export function buildHorizonAvailability(dataset:AnalysisDataset,families:readonly HorizonFamily[]):readonly HorizonAvailability[]{
 const availability=dataset.tables.availability??[],candidates=dataset.tables.candidates??[];
 const totalEvents=new Set(dataset.tables.events?.map(e=>e.event_id)).size;

 return families.map(({nominalDays,label})=>{
  const atHorizon=availability.filter(r=>num(r.target_horizon_days)===nominalDays);
  const byEvent=new Map<string,Readonly<Record<string,unknown>>[]>();
  for(const row of atHorizon){const id=str(row.event_id);if(!id)continue;const list=byEvent.get(id);if(list)list.push(row);else byEvent.set(id,[row])}

  const candidatesGenerated=byEvent.size;
  let priced=0,green=0,yellow=0,red=0,unavailableQuality=0;
  for(const rows of byEvent.values()){
   const chosen=rows.find(r=>bool(r.is_selected))??rows.find(r=>r.status==="priced")??rows[0]!;
   if(chosen.status==="priced"){
    priced++;
    const q=quality(chosen.entry_quality);
    if(q==="green")green++;else if(q==="yellow")yellow++;else if(q==="red")red++;else unavailableQuality++;
   }
  }

  const selectedCandidates=candidates.filter(c=>num(c.target_horizon_days)===nominalDays);
  const selectedEvents=new Set(selectedCandidates.map(c=>c.event_id));
  const taker=new Set(selectedCandidates.filter(c=>scenarioOf(c.execution_scenario)==="taker"&&scenarioStatusOf(c.execution_scenario_status)==="evaluated").map(c=>c.event_id));
  const maker=new Set(selectedCandidates.filter(c=>scenarioOf(c.execution_scenario)==="maker"&&scenarioStatusOf(c.execution_scenario_status)==="evaluated").map(c=>c.event_id));
  // Synchronization gap is scenario-specific evidence (maker and taker draw
  // on different tape prints, so their leg-timestamp gaps can genuinely
  // differ) -- every evaluated scenario row contributes its own measurement,
  // not_evaluated rows contribute none.
  const synchronizationMinutes=selectedCandidates.map(c=>num(c.spread_synchronization_minutes)).filter((x):x is number=>x!==null);

  return {
   nominalDays,label,totalEvents,candidatesGenerated,priced,selected:selectedEvents.size,
   takerExecutable:taker.size,makerOpportunity:maker.size,
   entryQuality:{green,yellow,red,unavailable:unavailableQuality},
   synchronizationMinutes,
  } satisfies HorizonAvailability;
 });
}

export interface GlobalScenarioCoverage {readonly totalEvents:number;readonly takerExecutableEvents:number;readonly makerOpportunityEvents:number}

/**
 * All-horizons-combined coverage: distinct events with at least one selected
 * structure genuinely evaluated (evidence-supported) under each scenario.
 * Computed once, directly from candidates.jsonl, independent of which
 * horizon a structure was generated at -- used for headline totals where
 * summing the per-horizon HorizonAvailability figures would double-count an
 * event selected at more than one horizon.
 */
export function globalScenarioCoverage(dataset:AnalysisDataset):GlobalScenarioCoverage{
 const candidates=dataset.tables.candidates??[];
 const totalEvents=new Set(dataset.tables.events?.map(e=>e.event_id)).size;
 const taker=new Set(candidates.filter(c=>scenarioOf(c.execution_scenario)==="taker"&&scenarioStatusOf(c.execution_scenario_status)==="evaluated").map(c=>c.event_id));
 const maker=new Set(candidates.filter(c=>scenarioOf(c.execution_scenario)==="maker"&&scenarioStatusOf(c.execution_scenario_status)==="evaluated").map(c=>c.event_id));
 return {totalEvents,takerExecutableEvents:taker.size,makerOpportunityEvents:maker.size};
}
