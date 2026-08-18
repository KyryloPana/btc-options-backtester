import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents,type ResolutionOutcome} from "../underlying-resolution/normalize.ts";

/**
 * Canonical research bundle 2.1.0 -> normalized Duration/DTE structures.
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
 * Canonical granularity note: `availability.jsonl` records a single
 * `status` ("priced" | "unavailable") per generated candidate. The bundle does
 * not separately distinguish "an eligible expiry existed" from "both legs were
 * retrievable" -- those two funnel stages collapse into one canonical
 * availability status. `execution_mode` is the configured assumption for the
 * generation run, not an independently generated maker AND taker outcome per
 * candidate, so maker/taker are reported as two labelled views of the same
 * selected structure, never as a stricter/looser funnel stage.
 */

export type EntryQuality="green"|"yellow"|"red";
export type ExecutionMode="maker"|"taker";
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
 readonly horizonNominalDays:number|null;
 readonly structureType:string|null;
 readonly entryQuality:EntryQuality|null;
 readonly executionMode:ExecutionMode|null;
 readonly synchronizationMinutes:number|null;
 readonly entryTimestampMs:number|null;
 readonly expiryTimestampMs:number|null;
 /** The primary analytical variable: actual selected-contract DTE in days. */
 readonly actualDteDays:number|null;

 /** Authoritative underlying facts, joined from Underlying Resolution -- never re-derived. */
 readonly underlyingOutcome:ResolutionOutcome;
 readonly underlyingCensored:boolean;
 readonly timeToResolutionDays:number|null;
 readonly timeToVpocDays:number|null;
 readonly timeToInvalidationDays:number|null;

 /** Null when the underlying event is ineligible for time-to-event analysis (see Underlying Resolution). */
 readonly resolvedBeforeExpiry:boolean|null;
 readonly outcomeBeforeExpiry:OutcomeBeforeExpiry|null;
 /** actualDteDays - timeToResolutionDays. Only defined for a resolved event with a known actual DTE. Negative means expiry occurred before the thesis resolved. */
 readonly dteBufferDays:number|null;

 readonly pnlAtVpocUsd:number|null;
 readonly pnlAtInvalidationUsd:number|null;
 readonly pnlAtSettlementUsd:number|null;
 /** Most adverse mark-to-market before resolution/censoring, from the raw-VWAP valuation track. Null means Unavailable. */
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
 readonly takerExecutable:number;
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
const mode=(v:unknown):ExecutionMode|null=>{const s=str(v);return s==="maker"||s==="taker"?s:null};

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
 * boundary, from the raw-VWAP valuation track only -- the conservative,
 * executable-evidence track, not the modeled one. Mirrors the pre-resolution
 * excursion correction already applied to the underlying MFE/MAE.
 */
function worstAdverse(valuations:readonly Readonly<Record<string,unknown>>[],candidateId:string,entryMs:number|null,boundaryMs:number|null):number|null{
 if(entryMs===null||boundaryMs===null)return null;
 let worst:number|null=null;
 for(const row of valuations){
  if(row.candidate_id!==candidateId||row.pricing_track!=="raw_vwap"||row.valuation_status!=="priced")continue;
  const t=ms(row.timestamp_utc);
  if(t===null||t<entryMs||t>boundaryMs)continue;
  const pnl=num(row.net_pnl_usd)??num(row.net_pnl_native);
  if(pnl===null)continue;
  if(worst===null||pnl<worst)worst=pnl;
 }
 return worst;
}

function captureObservation(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,threshold:25|50|70,entryMs:number|null,timeToVpocDays:number|null,timeToInvalidationDays:number|null):CaptureObservation|null{
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.outcome_type===`credit_capture_${threshold}`);
 if(!row)return null;
 const triggerMs=row.status==="priced"?ms(row.trigger_timestamp_utc):null;
 const timeToCaptureDays=triggerMs!==null&&entryMs!==null?(triggerMs-entryMs)/DAY:null;
 return {
  thresholdPct:threshold,reached:row.status==="priced",timeToCaptureDays,
  beforeVpoc:timeToVpocDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToVpocDays:null,
  beforeInvalidation:timeToInvalidationDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToInvalidationDays:null,
 };
}

function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.outcome_type===kind);
 if(!row||row.status!=="priced")return null;
 return num(row.net_pnl_usd)??num(row.net_pnl_native);
}

export function normalizeDteCandidates(dataset:AnalysisDataset):readonly DteCandidate[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],valuations=dataset.tables.valuations??[],margins=dataset.tables.margin_scenarios??[];
 const eventsById=new Map(normalizeMrEvents(dataset).map(e=>[e.eventId,e]));

 return candidates.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",candidateId=str(row.candidate_id)??"unknown-candidate";
  const event=eventsById.get(eventId);
  const entry=ms(row.structure_entry_timestamp_utc),expiry=ms(row.expiry_timestamp_utc),dte=actualDte(row);

  if(!event||event.ineligibility!==null){
   return {
    eventId,candidateId,horizonNominalDays:num(row.target_horizon_days),structureType:str(row.structure_type),
    entryQuality:quality(row.entry_quality),executionMode:mode(row.execution_mode),
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
   resolvedBeforeExpiry===null?null
   :!resolvedBeforeExpiry?"no_resolution_before_expiry"
   :event.outcome==="vpoc_first"?"vpoc_before_expiry"
   :event.outcome==="invalidation_first"?"invalidation_before_expiry"
   :"ambiguous_before_expiry";
  const dteBufferDays=resolved&&event.timeToResolutionDays!==null&&dte!==null?dte-event.timeToResolutionDays:null;

  const marginRow=margins.find(m=>m.candidate_id===candidateId),
   marginAvailable=marginRow?.margin_status==="available",
   requiredCapitalUsd=marginAvailable?num(marginRow!.maximum_loss_usd)??num(marginRow!.peak_initial_margin):null;
  const pnlAtVpocUsd=pnlAt(outcomes,candidateId,"vpoc"),pnlAtInvalidationUsd=pnlAt(outcomes,candidateId,"invalidation"),pnlAtSettlementUsd=pnlAt(outcomes,candidateId,"settlement");
  const realizedPnl=event.outcome==="vpoc_first"?pnlAtVpocUsd:event.outcome==="invalidation_first"?pnlAtInvalidationUsd:!resolved?pnlAtSettlementUsd:null;
  const capitalDayReturn=requiredCapitalUsd!==null&&requiredCapitalUsd!==0&&realizedPnl!==null&&event.timeToResolutionDays!==null&&event.timeToResolutionDays>0
   ?realizedPnl/(requiredCapitalUsd*event.timeToResolutionDays):null;

  const boundaryMs=event.resolutionTimestampMs??(event.entryTimestampMs!==null&&event.observationDays!==null?event.entryTimestampMs+event.observationDays*DAY:null);

  return {
   eventId,candidateId,horizonNominalDays:num(row.target_horizon_days),structureType:str(row.structure_type),
   entryQuality:quality(row.entry_quality),executionMode:mode(row.execution_mode),
   synchronizationMinutes:num(row.spread_synchronization_minutes),entryTimestampMs:entry,expiryTimestampMs:expiry,actualDteDays:dte,
   underlyingOutcome:event.outcome,underlyingCensored:event.censored,
   timeToResolutionDays:event.timeToResolutionDays,timeToVpocDays:event.timeToVpocDays,timeToInvalidationDays:event.timeToInvalidationDays,
   resolvedBeforeExpiry,outcomeBeforeExpiry,dteBufferDays,
   pnlAtVpocUsd,pnlAtInvalidationUsd,pnlAtSettlementUsd,
   worstAdverseUsd:worstAdverse(valuations,candidateId,entry,boundaryMs),
   capture25:captureObservation(outcomes,candidateId,25,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture50:captureObservation(outcomes,candidateId,50,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture70:captureObservation(outcomes,candidateId,70,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   requiredCapitalUsd,capitalDayReturn,
   ineligibilityReason:null,
  } satisfies DteCandidate;
 });
}

/**
 * Coverage funnel and quality/sync stats per nominal horizon, at EVENT
 * granularity: one MR event is one observation even when it produced several
 * candidates at the same horizon, so every stage below counts distinct events.
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
  const taker=new Set(selectedCandidates.filter(c=>mode(c.execution_mode)==="taker").map(c=>c.event_id));
  const maker=new Set(selectedCandidates.filter(c=>mode(c.execution_mode)==="maker").map(c=>c.event_id));
  const synchronizationMinutes=selectedCandidates.map(c=>num(c.spread_synchronization_minutes)).filter((x):x is number=>x!==null);

  return {
   nominalDays,label,totalEvents,candidatesGenerated,priced,selected:selectedEvents.size,
   takerExecutable:taker.size,makerOpportunity:maker.size,
   entryQuality:{green,yellow,red,unavailable:unavailableQuality},
   synchronizationMinutes,
  } satisfies HorizonAvailability;
 });
}
