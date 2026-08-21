import type {AnalysisDataset} from "../research-analysis.ts";
import {normalizeMrEvents,type ResolutionOutcome} from "../underlying-resolution/normalize.ts";
// Adverse-path evidence is a shared canonical primitive: Short-Strike answers
// the same question and must answer it identically, so both import one copy.
import {adversePath,type AdversePathObservation} from "../adverse-path.ts";
import {normalizeExecutionScenarioStatus,type ExecutionScenarioStatus} from "../execution-scenario.ts";
import {buildResearchAnalyticsModel,type ScenarioTrack} from "../research-analytics-model.ts";
export {type AdversePathObservation,type PathEvidenceStatus} from "../adverse-path.ts";

/**
 * Canonical research bundle 2.3.0 -> normalized Duration/DTE structures.
 *
 * This module joins `candidates.jsonl` (selected structures), `availability.jsonl`
 * (the full generated denominator, selected and unselected), `outcomes.jsonl`
 * (per-candidate outcome-at-trigger records) and `valuations.jsonl` (the 4h
 * valuation grid) against the SAME authoritative per-event resolution facts
 * Underlying Resolution already establishes (`normalizeMrEvents`). Outcome
 * ordering, censoring and first-resolution timing are never re-derived here.
 *
 * The analytical variable throughout is actual selected-contract DTE, not the
 * nominal `target_horizon_days` label, which is a grouping/reference band only.
 *
 * TWO KINDS OF FIELD, and the distinction is load-bearing:
 *
 *  - EXECUTION-INDEPENDENT (expiry, actual DTE, underlying first-resolution
 *    timing, resolved-before-expiry, DTE buffer, holding period): a property of
 *    the STRUCTURE. Derived once per candidate_id from its sibling rows and
 *    copied verbatim onto both scenario rows, so maker and taker can never
 *    disagree about them and an aggregate that de-duplicates by candidate_id
 *    counts each structure exactly once.
 *  - EXECUTION-DEPENDENT (entry credit, credit capture, PnL, worst adverse,
 *    synchronization, capital metrics): read only from THIS scenario's own
 *    canonical rows. One scenario's evidence never populates the other's.
 *
 * Execution scenario: candidates.jsonl carries one row per (structure,
 * execution scenario) pair, sharing candidate_id as the stable structural
 * identity. `execution_scenario` ("maker"|"taker") and `execution_scenario_status`
 * ("evaluated"|"unavailable"|"not_evaluated") are read verbatim -- maker and taker are two
 * genuinely, independently evaluated scenarios, never one label standing in
 * for both. A not_evaluated row keeps every execution-INDEPENDENT structural
 * fact but has null for every execution-DEPENDENT field, since the canonical
 * bundle never evaluated it -- this module does not fabricate a 0 or borrow the
 * other scenario's numbers.
 *
 * Canonical granularity note: `availability.jsonl` records a single
 * `status` ("priced" | "unavailable") per generated candidate. The bundle does
 * not separately distinguish "an eligible expiry existed" from "both legs were
 * retrievable" -- those two funnel stages collapse into one canonical
 * availability status.
 */

export type EntryQuality="green"|"yellow"|"red";
export type ExecutionScenario="maker"|"taker";
export type {ExecutionScenarioStatus} from "../execution-scenario.ts";

/**
 * Candidate-relative outcome buckets. These describe what happened WHILE THIS
 * STRUCTURE EXISTED, never the underlying event's eventual outcome when that
 * outcome fell outside [structure entry, expiry].
 *
 * `vpoc_before_structure_entry` is a genuinely distinct state, not a flavour of
 * resolution: the MR thesis had already reached VPOC before this structure was
 * entered, so there is no post-entry VPOC outcome to price and no DTE buffer to
 * measure against it.
 */
export type OutcomeBeforeExpiry=
 |"vpoc_before_expiry"|"invalidation_before_expiry"|"ambiguous_before_expiry"
 |"no_resolution_before_expiry"|"vpoc_before_structure_entry";

/**
 * The diagnostic split inside `no_resolution_before_expiry`. Both cases mean
 * the option did not survive long enough to observe MR resolution, so they stay
 * one visual category -- but they are never merged internally.
 */
export type NoResolutionDetail=
 /** The underlying MR did reach VPOC/invalidation, but only after this structure's expiry. */
 |"resolved_later"
 /** Neither terminal MR outcome was observed by canonical observation end. */
 |"still_unresolved";


export interface EligibleDteRange {readonly min:number;readonly max:number}
export interface HorizonFamily {readonly nominalDays:number;readonly label:string;readonly eligibleDteRange:EligibleDteRange|null}

export interface CaptureObservation {
 readonly thresholdPct:25|50|70;
 readonly reached:boolean;
 readonly timeToCaptureDays:number|null;
 /** Null when the event never experienced that endpoint, not merely "false". */
 readonly beforeVpoc:boolean|null;
 readonly beforeInvalidation:boolean|null;
 readonly evaluable:boolean;
 readonly unavailableReason:string|null;
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
 /** Canonical reason for unavailable/not-evaluated status; null when absent. */
 readonly executionScenarioReason:string|null;
 /** True for migrated single-scenario evidence, which is not an independent maker/taker observation. */
 readonly executionScenarioLegacyUndifferentiated:boolean;

 /* ---- structural identity, for matched comparisons (execution-independent) ---- */
 readonly strikeMethod:string|null;
 readonly widthUsd:number|null;
 readonly optionType:string|null;
 /**
  * event x short-strike method x width x structure type x option type. Two rows
  * sharing this key differ ONLY in horizon/actual DTE (and scenario), which is
  * exactly the controlled comparison DTE economics require.
  */
 readonly structuralVariantKey:string;

 /* ---- execution-DEPENDENT entry evidence ---- */
 readonly entryQuality:EntryQuality|null;
 readonly synchronizationMinutes:number|null;
 readonly referenceSourceTier:string|null;

 /* ---- execution-INDEPENDENT structural facts (identical on both scenario rows) ---- */
 readonly structureEntryMs:number|null;
 readonly expiryTimestampMs:number|null;
 /** The primary analytical variable: actual selected-contract DTE in days. */
 readonly actualDteDays:number|null;

 /** Authoritative underlying facts, joined from Underlying Resolution -- never re-derived. */
 readonly underlyingOutcome:ResolutionOutcome;
 readonly underlyingCensored:boolean;
 readonly timeToResolutionDays:number|null;
 readonly timeToVpocDays:number|null;
 readonly timeToInvalidationDays:number|null;

 /** True when canonical VPOC occurred strictly before this structure was entered. */
 readonly vpocBeforeStructureEntry:boolean;
 /** Days from structure entry to the first resolution that happened AT OR AFTER entry. Null when none did. */
 readonly postEntryResolutionDays:number|null;

 /** Null when the underlying event is ineligible for time-to-event analysis or expiry/DTE is unknown. */
 readonly resolvedBeforeExpiry:boolean|null;
 readonly outcomeBeforeExpiry:OutcomeBeforeExpiry|null;
 /** Populated only when outcomeBeforeExpiry is no_resolution_before_expiry. */
 readonly noResolutionDetail:NoResolutionDetail|null;
 /** actual DTE - post-entry time to resolution. Never measured against a pre-entry resolution. */
 readonly dteBufferDays:number|null;

 /** T_hold = min(post-entry first resolution, expiry), in days from structure entry. Capital-free. */
 readonly holdingDays:number|null;
 /** True when the structure was held all the way to expiry/settlement. */
 readonly heldToExpiry:boolean|null;

 /* ---- execution-DEPENDENT economics ---- */
 readonly pnlAtVpocUsd:number|null;
 readonly pnlAtInvalidationUsd:number|null;
 readonly pnlAtSettlementUsd:number|null;
 readonly observedPnlAtVpocUsd:number|null;
 readonly observedPnlAtInvalidationUsd:number|null;
 readonly observedPnlAtSettlementUsd:number|null;
 readonly adversePath:AdversePathObservation;
 readonly observedAdversePath:AdversePathObservation;
 /** Convenience mirror of adversePath.worstAdverseUsd. */
 readonly worstAdverseUsd:number|null;

 readonly capture25:CaptureObservation|null;
 readonly capture50:CaptureObservation|null;
 readonly capture70:CaptureObservation|null;
 readonly observedCapture25:CaptureObservation|null;
 readonly observedCapture50:CaptureObservation|null;
 readonly observedCapture70:CaptureObservation|null;

 /** Always null unless a canonical margin scenario is genuinely available -- read, never assumed. */
 readonly requiredCapitalUsd:number|null;
 readonly capitalDayReturn:number|null;

 /** Set when this candidate's underlying event could not join the authoritative resolution model. */
 readonly ineligibilityReason:string|null;
}

/**
 * Three genuinely distinct coverage states. Collapsing any pair of these is the
 * exact defect this type exists to prevent.
 */
export type ScenarioCoverageStatus=
 /** At least one structure was genuinely evaluated under this scenario, so a share is meaningful (and may legitimately be 0%). */
 |"measured"
 /** Structures were assessed for this scenario but canonical evidence did not support any of them. */
 |"unavailable"
 /** No structure carries this scenario at all -- it was never assessed. */
 |"not_evaluated";

export interface ScenarioCoverage {
 readonly status:ScenarioCoverageStatus;
 /** Distinct eligible MR events with >=1 structure genuinely evaluated under this scenario. */
 readonly events:number;
 /** Eligible MR events at this scope -- events that generated >=1 candidate. */
 readonly eligibleEvents:number;
 /** events / eligibleEvents. Null unless status is "measured". */
 readonly share:number|null;
 /** Inspectable explanation when status is not "measured". */
 readonly reason:string|null;
}

export interface HorizonAvailability {
 readonly nominalDays:number;
 readonly label:string;
 readonly totalEvents:number;
 /** Distinct events that generated >=1 candidate at this horizon: the executability denominator. */
 readonly eligibleEvents:number;
 readonly candidatesGenerated:number;
 readonly priced:number;
 readonly selected:number;
 readonly taker:ScenarioCoverage;
 readonly maker:ScenarioCoverage;
 readonly entryQuality:{readonly green:number;readonly yellow:number;readonly red:number;readonly unavailable:number};
 /** Per-scenario leg-synchronization measurements; maker and taker draw on different tape prints. */
 readonly synchronizationMinutes:Record<ExecutionScenario,readonly number[]>;
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const bool=(v:unknown):boolean|null=>typeof v==="boolean"?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const DAY=864e5;
const QUALITIES=new Set(["green","yellow","red"]);
const quality=(v:unknown):EntryQuality|null=>{const s=str(v);return s&&QUALITIES.has(s)?s as EntryQuality:null};
const scenarioOf=(v:unknown):ExecutionScenario|null=>{const s=str(v);return s==="maker"||s==="taker"?s:null};
const scenarioStatusOf=normalizeExecutionScenarioStatus;
const nested=(v:unknown,key:string):unknown=>v&&typeof v==="object"&&!Array.isArray(v)?(v as Record<string,unknown>)[key]:undefined;

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
 * Actual selected-contract DTE. `actual_dte` is the STRUCTURAL field, exported
 * unconditionally and identical across a structure's scenario rows;
 * `actual_dte_days`/`actual_dte_hours` are the precise scenario-entry-derived
 * values and exist only on an evaluated row. Structural facts prefer the
 * scenario-independent value so a not_evaluated row still reports the DTE its
 * structure genuinely had, rather than pretending the duration is unknown.
 */
function structuralDte(rows:readonly Readonly<Record<string,unknown>>[]):number|null{
 for(const row of rows){const v=num(row.actual_dte);if(v!==null)return v}
 for(const row of rows){
  const d=num(row.actual_dte_days);if(d!==null)return d;
  const h=num(row.actual_dte_hours);if(h!==null)return h/24;
 }
 return null;
}

/**
 * The structure's entry timestamp. Scenario rows share one target timestamp, so
 * the first non-null is the structure's; a structure whose every scenario is
 * not_evaluated has none and stays null -- never falling back to the event's
 * own entry, which would silently move the pre-entry-VPOC boundary.
 */
function structuralEntry(rows:readonly Readonly<Record<string,unknown>>[]):number|null{
 for(const row of rows){const t=ms(row.structure_entry_timestamp_utc)??ms(row.valuation_timestamp_utc);if(t!==null)return t}
 return null;
}

/** event x strike method x width x structure type x option type -- everything except horizon/DTE and scenario. */
function variantKey(row:Readonly<Record<string,unknown>>,eventId:string):string{
 const width=num(nested(row.actual_strikes,"width"));
 return [eventId,str(row.strike_method)??"unknown-method",width===null?"unknown-width":String(width),str(row.structure_type)??"unknown-structure",str(row.option_type)??"unknown-type"].join("|");
}


function captureObservation(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,threshold:25|50|70,entryMs:number|null,timeToVpocDays:number|null,timeToInvalidationDays:number|null):CaptureObservation|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===`credit_capture_${threshold}`);
 if(!row)return null;
 const legacy=row.trigger_status===undefined,reached=legacy?row.status==="priced":row.trigger_status==="reached";
 const evaluable=legacy||reached||row.trigger_status==="not_reached";
 const triggerMs=reached?ms(row.trigger_timestamp_utc):null;
 const timeToCaptureDays=triggerMs!==null&&entryMs!==null?(triggerMs-entryMs)/DAY:null;
 return {
  thresholdPct:threshold,reached,timeToCaptureDays,evaluable,
  unavailableReason:evaluable?null:str(row.evidence_reason)??(Array.isArray(row.reason_codes)?row.reason_codes.join(", "):"Raw path evidence is missing or invalid."),
  beforeVpoc:timeToVpocDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToVpocDays:null,
  beforeInvalidation:timeToInvalidationDays!==null&&timeToCaptureDays!==null?timeToCaptureDays<=timeToInvalidationDays:null,
 };
}

function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===kind);
 if(!row)return null;
 const canonical=row.raw_status!==undefined;
 if(canonical&&(row.trigger_status!=="reached"||row.raw_status!=="priced"))return null;
 if(!canonical&&row.status!=="priced")return null;
 return canonical?(num(row.raw_net_pnl_usd)??num(row.raw_net_pnl_native)):(num(row.net_pnl_usd)??num(row.net_pnl_native));
}

const trackTime=(r:Readonly<Record<string,unknown>>):number|null=>{
 const value=num(r.timestamp)??num(r.valuationTimestamp)??num(r.decisionTimestamp);
 if(value!==null)return value;
 return ms(r.timestamp_utc)??ms(r.valuation_timestamp_utc)??ms(r.decision_timestamp_utc);
};
const trackPnlUsd=(r:Readonly<Record<string,unknown>>):number|null=>num(r.estimatedNetPnlUsd)??num(r.net_pnl_usd)??num(r.raw_net_pnl_usd);
const trackPnlNative=(r:Readonly<Record<string,unknown>>):number|null=>num(r.estimatedNetPnlBtc)??num(r.net_pnl_native)??num(r.raw_net_pnl_native);
function namedOutcome(track:ScenarioTrack|undefined,kind:"vpoc"|"invalidation"|"settlement"):Readonly<Record<string,unknown>>|undefined{
 if(!track)return undefined;
 return Object.entries(track.outcomes).find(([label])=>kind==="settlement"?/settlement|terminal|expiry/i.test(label):new RegExp(kind,"i").test(label))?.[1];
}
function referencePnl(track:ScenarioTrack|undefined,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 const row=namedOutcome(track,kind);return row?(trackPnlUsd(row)??trackPnlNative(row)):null;
}
function referenceCapture(track:ScenarioTrack|undefined,threshold:25|50|70,entry:number|null,vpocDays:number|null,invalidationDays:number|null):CaptureObservation|null{
 if(!track||track.status!=="available")return null;
 const credit=track.economics.netCredit??track.economics.grossCredit;
 if(credit===null||credit<=0)return {thresholdPct:threshold,reached:false,timeToCaptureDays:null,beforeVpoc:null,beforeInvalidation:null,evaluable:false,unavailableReason:"Reference opening credit is missing or non-positive."};
 const marks=track.valuationPath.map(r=>({t:trackTime(r),p:trackPnlNative(r)})).filter((x):x is {t:number;p:number}=>x.t!==null&&x.p!==null&&entry!==null&&x.t>=entry).sort((a,b)=>a.t-b.t);
 if(!marks.length)return {thresholdPct:threshold,reached:false,timeToCaptureDays:null,beforeVpoc:null,beforeInvalidation:null,evaluable:false,unavailableReason:"Reference valuation path has no priced mark in the candidate window."};
 const hit=marks.find(x=>x.p/credit>=threshold/100),days=hit&&entry!==null?(hit.t-entry)/DAY:null;
 return {thresholdPct:threshold,reached:!!hit,timeToCaptureDays:days,evaluable:true,unavailableReason:null,beforeVpoc:days!==null&&vpocDays!==null?days<=vpocDays:null,beforeInvalidation:days!==null&&invalidationDays!==null?days<=invalidationDays:null};
}
function referenceAdverse(track:ScenarioTrack|undefined,entry:number|null,boundary:number|null):AdversePathObservation{
 if(!track||track.status!=="available")return {worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0,status:"no_raw_marks",reason:"Reference track unavailable."};
 const marks=track.valuationPath.map(r=>({t:trackTime(r),p:trackPnlUsd(r)??trackPnlNative(r)})).filter((x):x is {t:number;p:number}=>x.t!==null&&x.p!==null&&entry!==null&&x.t>=entry&&(boundary===null||x.t<=boundary)).sort((a,b)=>a.t-b.t);
 if(!marks.length)return {worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0,status:"no_raw_marks",reason:"Reference path has no priced mark in the candidate observation window."};
 const firstProfit=marks.findIndex(x=>x.p>0),before=firstProfit<0?[]:marks.slice(0,firstProfit+1);
 return {worstAdverseUsd:Math.min(...marks.map(x=>x.p)),maeBeforeProfitUsd:before.length?Math.min(...before.map(x=>x.p)):null,profitObserved:firstProfit>=0,rawMarksInWindow:marks.length,status:"available",reason:null};
}

export function normalizeDteCandidates(dataset:AnalysisDataset):readonly DteCandidate[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],valuations=dataset.tables.valuations??[],margins=dataset.tables.margin_scenarios??[];
 const eventsById=new Map(normalizeMrEvents(dataset).map(e=>[e.eventId,e]));
 const analytical=buildResearchAnalyticsModel(dataset);
 const observationFor=(eventId:string,candidateId:string)=>analytical.observations.find(o=>o.eventId===eventId&&o.candidateId===candidateId);

 // Group a structure's scenario rows so every execution-INDEPENDENT fact is
 // derived once per candidate_id and copied identically onto both rows.
 const rowsByCandidate=new Map<string,Readonly<Record<string,unknown>>[]>();
 for(const row of candidates){
  const id=str(row.candidate_id)??"unknown-candidate";
  const list=rowsByCandidate.get(id);if(list)list.push(row);else rowsByCandidate.set(id,[row]);
 }

 return candidates.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",candidateId=str(row.candidate_id)??"unknown-candidate";
  const scenario=scenarioOf(row.execution_scenario),scenarioStatus=scenarioStatusOf(row.execution_scenario_status);
  const structureExecutionId=str(row.structure_execution_id)??`${candidateId}~${scenario??"unknown"}`;
  const siblings=rowsByCandidate.get(candidateId)??[row];
  const event=eventsById.get(eventId);
  const evaluated=scenarioStatus==="evaluated";

  // Execution-independent structural facts, identical across scenario rows.
  const entry=structuralEntry(siblings),expiry=ms(row.expiry_timestamp_utc),dte=structuralDte(siblings);
  const structural={
   eventId,candidateId,structureExecutionId,horizonNominalDays:num(row.target_horizon_days),structureType:str(row.structure_type),
   executionScenario:scenario,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
   executionScenarioLegacyUndifferentiated:row.execution_scenario_legacy_undifferentiated===true,
   strikeMethod:str(row.strike_method),widthUsd:num(nested(row.actual_strikes,"width")),optionType:str(row.option_type),
   structuralVariantKey:variantKey(row,eventId),
   entryQuality:evaluated?quality(row.entry_quality):null,
   synchronizationMinutes:evaluated?num(row.spread_synchronization_minutes):null,
   referenceSourceTier:observationFor(eventId,candidateId)?.tracks.reference?.sourceTier??null,
   structureEntryMs:entry,expiryTimestampMs:expiry,actualDteDays:dte,
  };

  if(!event||event.ineligibility!==null){
   return {
    ...structural,
    underlyingOutcome:"unresolved",underlyingCensored:true,timeToResolutionDays:null,timeToVpocDays:null,timeToInvalidationDays:null,
    vpocBeforeStructureEntry:false,postEntryResolutionDays:null,
    resolvedBeforeExpiry:null,outcomeBeforeExpiry:null,noResolutionDetail:null,dteBufferDays:null,
    holdingDays:null,heldToExpiry:null,
    pnlAtVpocUsd:null,pnlAtInvalidationUsd:null,pnlAtSettlementUsd:null,
    observedPnlAtVpocUsd:null,observedPnlAtInvalidationUsd:null,observedPnlAtSettlementUsd:null,
    adversePath:{worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0,status:"no_observation_window",
     reason:"The underlying MR event is ineligible for time-to-event analysis, so no post-entry observation window is defined."},
    worstAdverseUsd:null,
    capture25:null,capture50:null,capture70:null,requiredCapitalUsd:null,capitalDayReturn:null,
    observedAdversePath:{worstAdverseUsd:null,maeBeforeProfitUsd:null,profitObserved:false,rawMarksInWindow:0,status:"no_observation_window",reason:"No observation window."},
    observedCapture25:null,observedCapture50:null,observedCapture70:null,
    ineligibilityReason:event?.ineligibility??"missing_underlying_event",
   } satisfies DteCandidate;
  }

  // Absolute canonical resolution timestamps, reconstructed from the SAME
  // authoritative per-event facts Underlying Resolution established.
  const eventEntry=event.entryTimestampMs;
  const abs=(d:number|null)=>d===null||eventEntry===null?null:eventEntry+d*DAY;
  const vpocMs=abs(event.timeToVpocDays),invalidationMs=abs(event.timeToInvalidationDays);

  // A resolution that predates the structure is not a post-entry outcome.
  const vpocBeforeStructureEntry=vpocMs!==null&&entry!==null&&vpocMs<entry;
  const postEntry=[vpocMs,invalidationMs].filter((t):t is number=>t!==null&&(entry===null||t>=entry));
  const postEntryResolutionMs=postEntry.length?Math.min(...postEntry):null;
  const postEntryResolutionDays=postEntryResolutionMs===null||entry===null?null:(postEntryResolutionMs-entry)/DAY;

  const resolvedBeforeExpiry=expiry===null||dte===null?null
   :postEntryResolutionMs!==null?postEntryResolutionMs<=expiry
   :false;

  // Which post-entry endpoint came first, for candidate-relative bucketing.
  const firstIsVpoc=postEntryResolutionMs!==null&&vpocMs!==null&&postEntryResolutionMs===vpocMs,
   firstIsInvalidation=postEntryResolutionMs!==null&&invalidationMs!==null&&postEntryResolutionMs===invalidationMs;

  const outcomeBeforeExpiry:OutcomeBeforeExpiry|null=
   resolvedBeforeExpiry===null?null
   :vpocBeforeStructureEntry?"vpoc_before_structure_entry"
   :!resolvedBeforeExpiry?"no_resolution_before_expiry"
   :firstIsVpoc&&firstIsInvalidation?"ambiguous_before_expiry"
   :firstIsVpoc?"vpoc_before_expiry"
   :firstIsInvalidation?"invalidation_before_expiry"
   :"no_resolution_before_expiry";

  // Split the no-resolution bucket diagnostically without merging the states.
  const noResolutionDetail:NoResolutionDetail|null=outcomeBeforeExpiry!=="no_resolution_before_expiry"?null
   :event.timeToResolutionDays!==null?"resolved_later"
   :"still_unresolved";

  // Never measured against a resolution that occurred before the structure existed.
  const dteBufferDays=expiry!==null&&postEntryResolutionMs!==null?(expiry-postEntryResolutionMs)/DAY:null;

  // T_hold = min(post-entry first resolution, expiry). Capital plays no part.
  const holdingEndMs=postEntryResolutionMs!==null&&expiry!==null?Math.min(postEntryResolutionMs,expiry):postEntryResolutionMs??expiry;
  const holdingDays=holdingEndMs===null||entry===null?null:(holdingEndMs-entry)/DAY;
  const heldToExpiry=expiry===null?null:postEntryResolutionMs===null||postEntryResolutionMs>expiry;

  const marginRow=margins.find(m=>m.candidate_id===candidateId),
   marginAvailable=marginRow?.margin_status==="available",
   requiredCapitalUsd=marginAvailable?num(marginRow!.maximum_loss_usd)??num(marginRow!.peak_initial_margin):null;
  const observedPnlAtVpocUsd=pnlAt(outcomes,candidateId,scenario,"vpoc"), observedPnlAtInvalidationUsd=pnlAt(outcomes,candidateId,scenario,"invalidation"), observedPnlAtSettlementUsd=pnlAt(outcomes,candidateId,scenario,"settlement");
  const reference=observationFor(eventId,candidateId)?.tracks.reference;
  const pnlAtVpocRaw=reference?referencePnl(reference,"vpoc"):observedPnlAtVpocUsd, pnlAtInvalidationUsd=reference?referencePnl(reference,"invalidation"):observedPnlAtInvalidationUsd, pnlAtSettlementUsd=reference?referencePnl(reference,"settlement"):observedPnlAtSettlementUsd;
  // A VPOC that predates the structure has no post-entry PnL: pricing it would
  // value an outcome at a timestamp before the position existed.
  const pnlAtVpocUsd=vpocBeforeStructureEntry?null:pnlAtVpocRaw;

  // Candidate-relative realized PnL: keyed off what happened WHILE THE
  // STRUCTURE EXISTED, never the event's eventual outcome.
  const realizedPnl=
   outcomeBeforeExpiry==="vpoc_before_expiry"?pnlAtVpocUsd
   :outcomeBeforeExpiry==="invalidation_before_expiry"?pnlAtInvalidationUsd
   :outcomeBeforeExpiry==="no_resolution_before_expiry"?pnlAtSettlementUsd
   :null;
  const capitalDayReturn=requiredCapitalUsd!==null&&requiredCapitalUsd!==0&&realizedPnl!==null&&holdingDays!==null&&holdingDays>0
   ?realizedPnl/(requiredCapitalUsd*holdingDays):null;

  // The adverse-path window ends at the post-entry resolution, or at whichever
  // of expiry / canonical observation end comes first when it never resolved.
  const observationEndMs=eventEntry!==null&&event.observationDays!==null?eventEntry+event.observationDays*DAY:null;
  const boundaryMs=postEntryResolutionMs??(expiry!==null&&observationEndMs!==null?Math.min(expiry,observationEndMs):expiry??observationEndMs);
  const observedPath=adversePath(valuations,candidateId,scenario,scenarioStatus==="evaluated",entry,boundaryMs);
  const path=reference?referenceAdverse(reference,entry,boundaryMs):observedPath;

  return {
   ...structural,
   underlyingOutcome:event.outcome,underlyingCensored:event.censored,
   timeToResolutionDays:event.timeToResolutionDays,timeToVpocDays:event.timeToVpocDays,timeToInvalidationDays:event.timeToInvalidationDays,
   vpocBeforeStructureEntry,postEntryResolutionDays,
   resolvedBeforeExpiry,outcomeBeforeExpiry,noResolutionDetail,dteBufferDays,
   holdingDays,heldToExpiry,
   pnlAtVpocUsd,pnlAtInvalidationUsd,pnlAtSettlementUsd,
   observedPnlAtVpocUsd,observedPnlAtInvalidationUsd,observedPnlAtSettlementUsd,
   adversePath:path,observedAdversePath:observedPath,worstAdverseUsd:path.worstAdverseUsd,
   capture25:reference?referenceCapture(reference,25,entry,event.timeToVpocDays,event.timeToInvalidationDays):captureObservation(outcomes,candidateId,scenario,25,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture50:reference?referenceCapture(reference,50,entry,event.timeToVpocDays,event.timeToInvalidationDays):captureObservation(outcomes,candidateId,scenario,50,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   capture70:reference?referenceCapture(reference,70,entry,event.timeToVpocDays,event.timeToInvalidationDays):captureObservation(outcomes,candidateId,scenario,70,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   observedCapture25:captureObservation(outcomes,candidateId,scenario,25,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   observedCapture50:captureObservation(outcomes,candidateId,scenario,50,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   observedCapture70:captureObservation(outcomes,candidateId,scenario,70,entry,event.timeToVpocDays,event.timeToInvalidationDays),
   requiredCapitalUsd,capitalDayReturn,
   ineligibilityReason:null,
  } satisfies DteCandidate;
 });
}

/**
 * Realized PnL at the outcome that actually occurred WHILE THIS STRUCTURE
 * EXISTED. Keyed off the candidate-relative bucket, never the underlying
 * event's eventual outcome: a structure whose event reached VPOC only after
 * expiry is a settlement result, and a structure entered after VPOC has no
 * post-entry VPOC result at all.
 */
export function realizedPnlOf(c:DteCandidate):number|null{
 switch(c.outcomeBeforeExpiry){
  case "vpoc_before_expiry":return c.pnlAtVpocUsd;
  case "invalidation_before_expiry":return c.pnlAtInvalidationUsd;
  case "no_resolution_before_expiry":return c.pnlAtSettlementUsd;
  default:return null;
 }
}

/**
 * Coverage for one execution scenario over a set of candidate rows, keeping
 * "not evaluated", "unavailable" and a genuine 0% strictly distinct.
 *
 * The denominator is ELIGIBLE MR EVENTS (events that generated at least one
 * candidate at this scope), never the count of selected candidate rows: one
 * event that produced six width variants is still one MR opportunity, and must
 * not outvote an event that produced one.
 */
function scenarioCoverage(rows:readonly Readonly<Record<string,unknown>>[],scenario:ExecutionScenario,eligibleEvents:number):ScenarioCoverage{
 const forScenario=rows.filter(r=>scenarioOf(r.execution_scenario)===scenario);
 if(!forScenario.length)return {status:"not_evaluated",events:0,eligibleEvents,share:null,
  reason:`No selected structure carries a ${scenario} row here, so ${scenario} coverage was never assessed. This is not a 0% result.`};
 const evaluated=forScenario.filter(r=>scenarioStatusOf(r.execution_scenario_status)==="evaluated");
 if(!evaluated.length){
  const reasons=[...new Set(forScenario.map(r=>str(r.execution_scenario_reason)).filter((x):x is string=>x!==null))];
  const unavailable=forScenario.some(r=>scenarioStatusOf(r.execution_scenario_status)==="unavailable");
  return {status:unavailable?"unavailable":"not_evaluated",events:0,eligibleEvents,share:null,
   reason:`All ${forScenario.length} ${scenario} row(s) here are ${unavailable?"unavailable":"not_evaluated"}.${reasons.length?` Reported reason: ${reasons[0]}`:""}`};
 }
 const events=new Set(evaluated.map(r=>str(r.event_id)).filter((x):x is string=>x!==null)).size;
 return {status:"measured",events,eligibleEvents,share:eligibleEvents>0?events/eligibleEvents:null,reason:null};
}

/**
 * Coverage funnel and quality/sync stats per nominal horizon, at EVENT
 * granularity: one MR event is one observation even when it produced several
 * width/strike variants at the same horizon, so every stage below counts
 * distinct events and no event gains statistical weight by generating more
 * structures.
 */
export function buildHorizonAvailability(dataset:AnalysisDataset,families:readonly HorizonFamily[]):readonly HorizonAvailability[]{
 const availability=dataset.tables.availability??[],candidates=dataset.tables.candidates??[];
 const totalEvents=new Set(dataset.tables.events?.map(e=>e.event_id)).size;

 return families.map(({nominalDays,label})=>{
  const atHorizon=availability.filter(r=>num(r.target_horizon_days)===nominalDays);
  const byEvent=new Map<string,Readonly<Record<string,unknown>>[]>();
  for(const row of atHorizon){const id=str(row.event_id);if(!id)continue;const list=byEvent.get(id);if(list)list.push(row);else byEvent.set(id,[row])}

  const eligibleEvents=byEvent.size;
  let priced=0,green=0,yellow=0,red=0,unavailableQuality=0;
  for(const rows of byEvent.values()){
   // One event, one vote: the selected row represents the event at this
   // horizon, falling back to any priced row, then to the first generated one.
   const chosen=rows.find(r=>bool(r.is_selected))??rows.find(r=>r.status==="priced")??rows[0]!;
   if(chosen.status==="priced"){
    priced++;
    const q=quality(chosen.entry_quality);
    if(q==="green")green++;else if(q==="yellow")yellow++;else if(q==="red")red++;else unavailableQuality++;
   }
  }

  const selectedCandidates=candidates.filter(c=>num(c.target_horizon_days)===nominalDays);
  const selectedEvents=new Set(selectedCandidates.map(c=>c.event_id));
  const sync=(scenario:ExecutionScenario)=>selectedCandidates
   .filter(c=>scenarioOf(c.execution_scenario)===scenario&&scenarioStatusOf(c.execution_scenario_status)==="evaluated")
   .map(c=>num(c.spread_synchronization_minutes)).filter((x):x is number=>x!==null);

  return {
   nominalDays,label,totalEvents,eligibleEvents,
   candidatesGenerated:eligibleEvents,priced,selected:selectedEvents.size,
   taker:scenarioCoverage(selectedCandidates,"taker",eligibleEvents),
   maker:scenarioCoverage(selectedCandidates,"maker",eligibleEvents),
   entryQuality:{green,yellow,red,unavailable:unavailableQuality},
   synchronizationMinutes:{maker:sync("maker"),taker:sync("taker")},
  } satisfies HorizonAvailability;
 });
}

export interface GlobalScenarioCoverage {
 readonly totalEvents:number;
 readonly eligibleEvents:number;
 readonly taker:ScenarioCoverage;
 readonly maker:ScenarioCoverage;
}

/**
 * All-horizons-combined coverage at event granularity. Computed once from
 * candidates.jsonl against the events that genuinely generated candidates --
 * summing the per-horizon figures would double-count an event selected at more
 * than one horizon, and the configured-run label is never consulted.
 */
export function globalScenarioCoverage(dataset:AnalysisDataset):GlobalScenarioCoverage{
 const candidates=dataset.tables.candidates??[],availability=dataset.tables.availability??[];
 const totalEvents=new Set(dataset.tables.events?.map(e=>e.event_id)).size;
 const eligibleEvents=new Set(availability.map(r=>str(r.event_id)).filter((x):x is string=>x!==null)).size;
 return {
  totalEvents,eligibleEvents,
  taker:scenarioCoverage(candidates,"taker",eligibleEvents),
  maker:scenarioCoverage(candidates,"maker",eligibleEvents),
 };
}
