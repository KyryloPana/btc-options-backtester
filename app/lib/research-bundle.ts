import { assessCandidateAnalyticalTracks, canonicalJson, migrateResearchSelectionStore, type JsonValue } from "./research-selections.ts";
import { reconcileCandidateSpread } from "./semantic-spread.ts";
import { buildEventFuturesBaseline, FUTURES_ENGINE_VERSION } from "./futures-baseline.ts";
import { resolveEventTiming } from "./event-timing.ts";
import { OUTCOMES_OUTSIDE_EXPORT_CONTRACT, RESEARCH_OUTCOME_IDENTITY_VERSION, canonicalOutcomeId, outcomeHoldingHours, outcomeSourceStatus, outcomeTriggerStatus, resolveOutcomeLabels } from "./research-outcomes.ts";
import { CONFIGURATION_IDENTITY_VERSION, describeMethodologyStaleness, diagnoseMethodologyStaleness, effectiveConfigurationHash, methodologyIdentity } from "./configuration-identity.ts";
import { BUILD_PROVENANCE_UNAVAILABLE, buildProvenanceStatus } from "./build-provenance.ts";
import { buildResearchMarginSnapshot, canonicalMarginReason, LEGACY_MARGIN_NOT_COMPUTED_REASON } from "./research-margin.ts";
import { CANONICAL_TRACKS, describeCanonicalTracks, legVolatility } from "./research-tracks.ts";
import type { ExpiryPayoffInput } from "./expiry-payoff.ts";
import { STRUCTURAL_LOSS_SIGN_CONVENTION, canonicalStructuralLoss, type CanonicalStructuralLoss } from "./maximum-economic-loss.ts";
import { EVENT_VOLATILITY_STATE_METHOD_VERSION, STRUCTURE_VOLATILITY_STATE_METHOD_VERSION, type EventVolatilityStateRow, type StructureVolatilityStateRow } from "./volatility/volatility-state.ts";

export const RESEARCH_BUNDLE_SCHEMA_VERSION="3.7.0" as const;
/** Bundle schema versions this app can still import (see importResearchBundle). */
export const LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS=["1.0.0","2.0.0","2.1.0","2.2.0","2.3.0","3.0.0","3.1.0","3.2.0","3.3.0","3.4.0","3.5.0","3.6.0"] as const;
export const RESEARCH_BUNDLE_FILES=["run.json","events.jsonl","underlying_path.jsonl","structure_economics.jsonl","candidates.jsonl","valuations.jsonl","outcomes.jsonl","availability.jsonl","margin_scenarios.jsonl","evidence_trades.jsonl","futures_comparisons.jsonl","futures_path.jsonl","event_volatility_state.jsonl","structure_volatility_state.jsonl"] as const;
export const REQUIRED_OUTCOMES=["vpoc","invalidation","credit_capture_25","credit_capture_50","credit_capture_70","fixed_3d","fixed_5d","fixed_7d","settlement"] as const;
export const RESEARCH_REASON_CODES=["entry_priced","entry_unavailable","direct_vwap","model_reconstructed","quality_green","quality_yellow","quality_red","quality_unavailable","valuation_priced","pricing_track_unavailable","outside_executable_window","raw_source_evidence","executable_evidence","missing_target_index","missing_pricing_track","outcome_priced","outcome_not_reached","outcome_after_expiry","outcome_ambiguous_sequence","outcome_reached_but_unpriced","outcome_source_absent","outcome_source_unavailable","outcome_label_unmapped","candidate_priced","candidate_unavailable","verified_historical_margin_model_unavailable","margin_no_canonical_valuation_path","margin_missing_index","margin_missing_short_mark","margin_missing_long_mark","margin_historical_rule_unverified","margin_deployment_unsupported","margin_not_recomputed","futures_instrument_unavailable","unsupported_futures_instrument","futures_reference_series_unavailable","futures_reference_series_incomplete","futures_entry_observation_unavailable","futures_exit_observation_unavailable","futures_series_gap_at_entry_decision","futures_series_gap_at_decision","futures_entry_bar_resolution_lag","futures_direction_unavailable","futures_event_vpoc_unavailable","futures_event_invalidation_unavailable","futures_event_resolution_ambiguous","futures_vpoc_target_not_reached","futures_event_vpoc_not_configured","futures_invalidation_not_reached","futures_event_invalidation_not_configured","futures_exit_endpoint_unavailable","funding_not_evaluated","futures_invalidation_distance_unavailable","futures_fee_schedule_unavailable","futures_no_funding_interval_elapsed","matched_endpoint_unavailable","observed_futures_execution_unavailable","funding_unavailable","funding_partial","futures_margin_unavailable"] as const;
export type ResearchReasonCode=(typeof RESEARCH_REASON_CODES)[number];
const RESEARCH_REASON_CODE_SET:ReadonlySet<string>=new Set(RESEARCH_REASON_CODES);
type Row=Record<string,JsonValue>;
export interface ResearchBundle {files:Record<(typeof RESEARCH_BUNDLE_FILES)[number],string>;run:Row}
const obj=(value:JsonValue):Record<string,JsonValue>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,JsonValue>:{};
const num=(v:JsonValue)=>typeof v==="number"?v:null;
const plausibleMs=(v:number|null)=>v!==null&&Number.isInteger(v)&&v>=946684800000&&v<=4102444800000;
const iso=(v:number|null)=>v===null?null:new Date(v).toISOString();
const isoMs=(v:number|null,path:string)=>{if(v===null)return null;if(!plausibleMs(v))throw new Error(`${path} must be a millisecond Unix timestamp in the supported UTC range.`);return iso(v)};
const hash=(value:unknown)=>{let h=2166136261;for(const c of JSON.stringify(value)){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return(h>>>0).toString(36)};
const economic={contract_style:"inverse",contract_multiplier:1,premium_currency:"BTC",settlement_currency:"BTC",quote_currency:"USD",native_currency:"BTC"} as const;
const row=(base:Record<string,unknown>):Row=>canonicalJson(base) as Row;
const lines=(rows:Row[])=>rows.map(r=>JSON.stringify(r)).join("\n")+(rows.length?"\n":"");
/**
 * Canonical outcome identity comes from ONE semantic table, never from string
 * shape: `"3D"` normalizes to `"3d"`, which never matched `fixed_3d`, so valid
 * persisted fixed-time outcomes were exported as generic unavailable rows.
 * `null` means genuinely unmapped and is reported, never coerced.
 */
const outcomeIndex=(snapshots:readonly JsonValue[])=>{
 const byOutcome=new Map<string,Record<string,JsonValue>>(),unmapped:string[]=[];
 for(const snapshot of snapshots){
  const o=obj(snapshot),label=String(o.label??"");
  const outcome=canonicalOutcomeId(label);
  if(outcome===null){if(label)unmapped.push(label);continue}
  byOutcome.set(outcome,o);
 }
 return{byOutcome,unmapped};
};
// One canonical definition, shared with the analytics compatibility projection
// so a report can never invent an outcome state the engines did not produce.
const sourceOutcomeStatus=outcomeSourceStatus;
const triggerStatus=outcomeTriggerStatus;
const qualityCode=(quality:JsonValue):ResearchReasonCode=>quality==="green"?"quality_green":quality==="yellow"?"quality_yellow":quality==="red"?"quality_red":"quality_unavailable";
const missingFieldCode=(field:JsonValue):ResearchReasonCode=>field==="targetIndex"?"missing_target_index":"missing_pricing_track";

export function summarizeResearchBundleErrors(errors:readonly string[],limit=3){const counts=new Map<string,number>();for(const error of errors)counts.set(error,(counts.get(error)??0)+1);const unique=[...counts].map(([message,count])=>({message,count}));const shown=unique.slice(0,limit).map(({message,count})=>`${message}${count>1?` (${count} rows)`:""}`);return{summary:`Research bundle validation failed: ${shown.join(" ")}${unique.length>limit?` ${unique.length-limit} more unique errors.`:""}`,unique,total:errors.length};}

/**
 * Optional facts the exporter cannot derive from the selection store alone.
 * `tradeDatasetMrEventCount` is the canonical MR-event denominator and comes
 * from the ACTIVE trade dataset -- never from the selection store, and never a
 * hardcoded historic count.
 */
/**
 * Volatility state is computed by the asynchronous, network-backed volatility
 * pipeline and INJECTED here as a snapshot. The bundle stays synchronous and
 * reproducible: the rows embed the values actually used plus the series
 * identity that produced them, and years of reference history stay in the
 * standalone cache rather than in every bundle.
 *
 * Omitting it exports both tables empty and marks them `unavailable`. That is
 * the honest state for a bundle built without the volatility pipeline -- never
 * a table of zeroes.
 */
export interface ResearchVolatilityStates {
 events?:readonly EventVolatilityStateRow[];
 structures?:readonly StructureVolatilityStateRow[];
}
export interface ResearchBundleContext {tradeDatasetMrEventCount?:number|null;volatility?:ResearchVolatilityStates}
export function buildResearchBundle(value:unknown,generatedAtUtc=new Date().toISOString(),datasetUpdatedAt?:string,context:ResearchBundleContext={}):ResearchBundle{
 // migrateResearchSelectionStore validates AND normalizes any known schema
 // version (including legacy ones) to the current SelectedStructure shape, so
 // buildResearchBundle never has to special-case an old, pre-scenario store.
 let store;try{store=migrateResearchSelectionStore(value)}catch(e){throw new Error(`Invalid persisted research selections: ${e instanceof Error?e.message:String(e)}`)}
 const selected=store.events.flatMap(e=>e.selectedStructures.map(s=>({e,s}))).sort((a,b)=>a.s.candidateId.localeCompare(b.s.candidateId));
 const runId=`bundle~${store.datasetId}~${generatedAtUtc.replace(/\D/g,"")}`;
 // ONE configuration identity: order-insensitive, methodology-only, and free of
 // generation-timestamp noise. The source-run key is derived from it rather
 // than from an order-sensitive JSON.stringify of the whole snapshot.
 const configurationHashes=new Map(store.events.map(e=>[e.eventId,effectiveConfigurationHash(e.generationSnapshot.configuration)]));
 const sourceIds=new Map(store.events.map(e=>[e.eventId,`${e.selectedStructures[0]?.venue??"deribit"}~source~${configurationHashes.get(e.eventId)}`]));
 // A statistical research bundle must not silently mix methodologies. Events
 // generated under a different methodology are stale and must be REGENERATED --
 // never migrated by editing metadata.
 const distinctMethodologies=[...new Set(configurationHashes.values())];
 const methodology=diagnoseMethodologyStaleness(store.events.map(e=>({eventId:e.eventId,configuration:e.generationSnapshot.configuration})));
 if(!methodology.compatible)throw new Error(describeMethodologyStaleness(methodology));
 const events:Row[]=store.events.sort((a,b)=>a.eventId.localeCompare(b.eventId)).map(e=>{const source=obj(e.sourceRun),event=obj(source.event??source);const timing=resolveEventTiming({sourceRun:e.sourceRun,underlyingHourlyPath:e.generationSnapshot.underlyingHourlyPath});const entry=timing.entryTimestamp,vpoc=timing.vpocTriggerTimestamp,level=timing.invalidationPrice,invalid=timing.invalidationDecisionTimestamp,observationEnd=timing.observationEndTimestamp,sequence=timing.sequenceStatus;const venue=e.selectedStructures[0]?.venue??e.generationSnapshot.candidates[0]?.venue??"deribit";return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,venue,signal_timestamp_utc:typeof event.entryDate==="string"?isoMs(Date.parse(`${event.entryDate}T00:00:00Z`),`event ${e.eventId} entryDate`):null,entry_timestamp_utc:isoMs(entry,`event ${e.eventId} entryTimestamp`),entry_decision_available_timestamp_utc:isoMs(entry,`event ${e.eventId} entryTimestamp`),entry_precision:"hourly",direction:event.direction??null,entry_price:event.entryPrice??null,extreme_price:event.extremePrice??null,vpoc_price:event.vpocPrice??null,invalidation_price:level,range_low:event.rangeLow??null,range_high:event.rangeHigh??null,vpoc_trigger_timestamp_utc:iso(vpoc),vpoc_decision_timestamp_utc:iso(timing.vpocDecisionTimestamp),invalidation_trigger_timestamp_utc:iso(timing.invalidationTriggerTimestamp),invalidation_decision_timestamp_utc:iso(invalid),observation_end_timestamp_utc:isoMs(observationEnd,`event ${e.eventId} observation end`),censoring_status:sequence==="unresolved"?"right_censored":"resolved",sequence_status:sequence,exit_timestamp_utc:iso(num(event.exitTimestamp)),exit_price:event.exitPrice??null,duration_hours:entry!==null&&observationEnd!==null?(observationEnd-entry)/36e5:null,vpoc_distance:event.vpocPrice!=null&&event.entryPrice!=null?Number(event.vpocPrice)-Number(event.entryPrice):null,invalidation_distance:level!==null&&event.entryPrice!=null?level-Number(event.entryPrice):null})});
 const paths:Row[]=store.events.flatMap(e=>e.generationSnapshot.underlyingHourlyPath.map(c=>row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,venue:e.selectedStructures[0]?.venue??"deribit",timestamp_utc:iso(c.openTime),open:c.open,high:c.high,low:c.low,close:c.close,index_price:c.close,source:"stored-event-candle",interval:"1h",timestamp_convention:"candle-open"}))).sort((a,b)=>String(a.event_id).localeCompare(String(b.event_id))||String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));
/**
  * Candidates.jsonl carries one row per (structure, execution scenario) pair.
  * candidate_id is the STABLE STRUCTURAL identity, shared across the maker and
  * taker rows for the same structure -- it is intentionally not row-unique
  * here; structure_execution_id is. Structural fields (expiry, strikes,
  * option type, DTE) never vary by scenario and are identical on both rows.
  * A not_evaluated scenario keeps its structural fields but every
  * execution-dependent field is null, never fabricated or borrowed from the
  * other scenario.
  */
 const invalidScenarioKeys=new Set<string>();
/**
 * ONE scenario-independent economic record per candidate_id.
 *
 * This is the record that says the structure EXISTS economically. Execution
 * rows overlay it; they never decide whether it exists. It is emitted once per
 * candidate_id -- not once for maker and again for taker -- so a downstream
 * consumer counts each structure exactly once.
 *
 * Maximum economic loss is computed from the authoritative inverse-option
 * payoff, with its units, reference index and method stated alongside it. It is
 * never presented as an unconditional BTC number, and the protective long's
 * premium plus fees is never called "margin" or "required balance": those are
 * account quantities and live in margin_scenarios.jsonl.
 */
 const structureEconomics:Row[]=selected.map(({e,s})=>{
  const c=obj(s.candidateSnapshot),reference=obj((s.referenceValuation??null) as JsonValue),refEntry=obj(reference.entrySnapshot);
  const modeledConservative=obj(obj((s.modeledExecution??null) as JsonValue).conservative),modeledEntry=obj(modeledConservative.entrySnapshot);
  const generated=e.generationSnapshot.candidates.find(x=>x.candidateId===s.candidateId);
  const expiry=num(c.expiryTimestamp),optionTypeRaw=c.optionType,optionType=typeof optionTypeRaw==="string"&&optionTypeRaw.trim()?optionTypeRaw:null;
  const shortStrike=num(c.shortStrike),longStrike=num(c.longStrike);
  const quantity=num(s.quantity),index=num(refEntry.entryTargetIndex)??num(refEntry.targetIndex);
  const shortPremium=num(obj(refEntry.sold).priceBtcPerContract),longPremium=num(obj(refEntry.bought).priceBtcPerContract);
  const grossReference=num(refEntry.grossSpreadBtc),feesReference=num(refEntry.openingFeesBtc),netReference=num(refEntry.netOpeningCashFlowBtc);
  const referenceEntryTs=num(refEntry.valuationTimestamp)??num(refEntry.targetTimestamp);
  const actualWidth=num(c.actualWidth)??(shortStrike!==null&&longStrike!==null?Math.abs(shortStrike-longStrike):null);
  const requestedWidth=num(generated?.requestedStrikes?.width??null);
  // ONE canonical bounded STRUCTURAL loss, shared with the margin layer --
  // never width minus credit, never the divergent BTC-settlement extremum, and
  // never a fixed BTC delivery fee converted at an arbitrary huge settlement
  // index. Delivery fees travel separately with their own scenario.
  let maxLoss:CanonicalStructuralLoss={status:"unavailable",usd:null,btcAtReferenceIndex:null,referenceIndex:index,worstStructuralIndex:null,breakevenIndex:null,method:null,methodVersion:null,assumption:null,signConvention:null,settlementFees:{includedInStructuralLoss:false,globalFeeInclusiveMaximum:"unbounded",globalFeeInclusiveMaximumReason:"Not evaluated: reference entry economics are incomplete.",scenarioIndex:null,scenarioLabel:null,scenarioDeliveryFeesBtc:null,scenarioDeliveryFeesUsd:null},reason:"Reference entry economics are incomplete, so the exact inverse payoff cannot be evaluated."};
  if(optionType&&(optionType==="C"||optionType==="P")&&shortStrike!==null&&longStrike!==null&&shortPremium!==null&&longPremium!==null&&index!==null&&index>0&&quantity!==null&&quantity>0&&feesReference!==null&&feesReference>=0&&expiry!==null){
   const input:ExpiryPayoffInput={optionType,shortStrike,longStrike,shortEntryPremiumBtc:shortPremium,longEntryPremiumBtc:longPremium,entryIndex:index,amount:quantity,openingFeesBtc:feesReference,expiryTimestamp:expiry};
   maxLoss=canonicalStructuralLoss(input);
  }
  return row({
   run_id:runId,source_run_id:sourceIds.get(e.eventId),venue:s.venue,event_id:e.eventId,candidate_id:s.candidateId,
   strategy_variant_id:s.strategyVariantId??s.candidateId,structure_type:c.structure??c.spreadKind??null,option_type:optionType,
   target_horizon_days:c.targetDte??null,
   requested_expiry_timestamp_utc:null,actual_expiry_timestamp_utc:isoMs(expiry,`structure ${s.candidateId} expiry`),
   expiry_timestamp_utc:isoMs(expiry,`structure ${s.candidateId} expiry`),
   reference_entry_timestamp_utc:isoMs(referenceEntryTs,`structure ${s.candidateId} reference entry`),
   actual_dte_hours:expiry!==null&&referenceEntryTs!==null?(expiry-referenceEntryTs)/36e5:null,
   actual_dte_days:expiry!==null&&referenceEntryTs!==null?(expiry-referenceEntryTs)/864e5:null,
   requested_short_strike:num(generated?.requestedStrikes?.short??null),actual_short_strike:shortStrike,
   requested_long_strike:num(generated?.requestedStrikes?.long??null),actual_long_strike:longStrike,
   requested_width:requestedWidth,actual_width:actualWidth,
   width_substituted:requestedWidth!==null&&actualWidth!==null&&requestedWidth!==actualWidth,
   short_instrument:obj(c.instruments).short??null,long_instrument:obj(c.instruments).long??null,
   quantity,reference_underlying_index:index,
   gross_reference_entry_credit_native:grossReference,reference_opening_fees_native:feesReference,
   net_reference_opening_cash_flow_native:netReference,
   modeled_conservative_gross_native:modeledConservative.status==="evaluated"?num(modeledEntry.grossSpreadBtc):null,
   modeled_conservative_net_native:modeledConservative.status==="evaluated"?num(modeledEntry.netOpeningCashFlowBtc):null,
   modeled_conservative_status:typeof modeledConservative.status==="string"?modeledConservative.status:"not_evaluated",
   breakeven_index:maxLoss.breakevenIndex,
   breakeven_method:maxLoss.breakevenIndex===null?null:"numerical bisection over the canonical inverse net payoff",
   maximum_structural_loss_status:maxLoss.status,
   maximum_structural_loss_native:maxLoss.btcAtReferenceIndex,maximum_structural_loss_usd:maxLoss.usd,
   maximum_structural_loss_units:{native:"BTC",quote:"USD",sign_convention:STRUCTURAL_LOSS_SIGN_CONVENTION},
   maximum_structural_loss_reference_index:maxLoss.referenceIndex??index,
   maximum_structural_loss_settlement_index:maxLoss.worstStructuralIndex,
   maximum_structural_loss_method:maxLoss.method,
   maximum_structural_loss_method_version:maxLoss.methodVersion,
   maximum_structural_loss_assumption:maxLoss.assumption,
   maximum_structural_loss_unavailable_reason:maxLoss.reason,
   // Delivery fees are reported here, never folded into the structural maximum:
   // a fixed BTC fee has unbounded USD value as the settlement index grows.
   settlement_fee_treatment:{
    included_in_structural_loss:maxLoss.settlementFees.includedInStructuralLoss,
    global_fee_inclusive_maximum:maxLoss.settlementFees.globalFeeInclusiveMaximum,
    global_fee_inclusive_maximum_reason:maxLoss.settlementFees.globalFeeInclusiveMaximumReason,
    scenario_index:maxLoss.settlementFees.scenarioIndex,
    scenario_label:maxLoss.settlementFees.scenarioLabel,
    scenario_delivery_fees_btc:maxLoss.settlementFees.scenarioDeliveryFeesBtc,
    scenario_delivery_fees_usd:maxLoss.settlementFees.scenarioDeliveryFeesUsd,
   },
   credit_per_actual_width:netReference!==null&&actualWidth!==null&&actualWidth>0&&index!==null?netReference*index/actualWidth:null,
   credit_per_maximum_structural_loss:netReference!==null&&maxLoss.usd!==null&&maxLoss.usd!==0&&index!==null?netReference*index/maxLoss.usd:null,
   // Every contracted track carries an explicit status here, so a consumer can
   // tell "unsupported for this structure, and why" from "absent from the file".
   tracks:describeCanonicalTracks(s as unknown as Record<string,unknown>).map(t=>({
    track:t.track,status:t.status,reason_code:t.reasonCode,reason:t.reason,
    // Entry and path availability separately, so entry-only delayed evidence is
    // never read as a complete economic track.
    entry_status:t.entryStatus,path_status:t.pathStatus,
    entry_basis:t.entryBasis,entry_timestamp_utc:iso(t.entryTimestampMs),
    valuation_basis:t.valuationBasis,execution_evidence:t.executionEvidence,
    valuation_source:t.valuationSource,engine_version:t.engineVersion,
    execution_scenario:t.executionScenario,provenance:t.provenance,
    // What the producing engine actually persisted. This is what lets the
    // validator tell "the source track produced no outcomes" (honest absence)
    // from "the exporter silently dropped outcomes that existed".
    source_valuation_point_count:t.valuationPath.length,
    source_outcome_snapshot_count:t.outcomeSnapshots.length,
    // A faithful digest of what the producing engine persisted, so the
    // validator can compare source semantics against the exported rows rather
    // than merely checking that some rows exist.
    source_outcomes:t.outcomeSnapshots.map(snapshot=>{const o=obj(snapshot),label=String(o.label??"");return{
     source_label:label,outcome:canonicalOutcomeId(label),source_status:String(o.status??"unavailable"),
     decision_timestamp_utc:iso(num(o.decisionTimestamp)),valuation_timestamp_utc:iso(num(o.valuationTimestamp)),
     pnl_native:num(o.estimatedNetPnlBtc)??num(o.estimatedNetPnl),
     conversion_index:num(o.conversionIndex)??num(o.targetIndex),
     closing_fees_native:num(o.feesBtc),quality:o.estimateQuality??null}}),
    unmapped_source_labels:resolveOutcomeLabels(t.outcomeSnapshots.map(x=>obj(x).label)).filter(x=>x.outcome===null&&x.label).map(x=>x.label),
   })),
   ...economic,
  });
 });

 const candidates:Row[]=selected.flatMap(({e,s})=>(["maker","taker"] as const).map(mode=>{
  const scenario=s.executionScenarios[mode],initiallyEvaluated=scenario.status==="evaluated";let evaluated=initiallyEvaluated,forcedUnavailableReason:string|null=null;
  const c=obj(s.candidateSnapshot),entry=evaluated?obj(scenario.entrySnapshot):{},expiry=num(c.expiryTimestamp),short=obj(entry.sold),long=obj(entry.bought),index=num(entry.entryTargetIndex);
   const candidate=row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,strategy_variant_id:s.strategyVariantId??s.candidateId,structure_execution_id:`${s.candidateId}~${mode}`,selection_id:s.selectionId,venue:s.venue,is_selected:true,selected_at_utc:s.selectedAtUtc,contract_resolution:s.contractResolution??null,reference_valuation:s.referenceValuation??null,delayed_execution:s.delayedExecution??null,modeled_execution:s.modeledExecution??null,structure_type:c.structure??c.spreadKind??null,direction:obj(obj(e.sourceRun).event).direction??null,target_horizon_days:c.targetDte??null,eligible_dte_range:e.generationSnapshot.candidates.find(x=>x.candidateId===s.candidateId)?.eligibleDteRange??null,expiry_timestamp_utc:isoMs(expiry,`candidate ${s.candidateId} expiry`),actual_dte:c.actualDte??null,expiry_weekday_utc:expiry===null?null:new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:"UTC"}).format(expiry),is_friday_expiry:expiry===null?null:new Date(expiry).getUTCDay()===5,expiry_rank:c.expiryRank??null,expiry_selection_reason:c.expirySelectionReason??null,strike_method:c.strikeMethod??e.generationSnapshot.candidates.find(x=>x.candidateId===s.candidateId)?.strikeMethod??null,requested_strikes:e.generationSnapshot.candidates.find(x=>x.candidateId===s.candidateId)?.requestedStrikes??null,actual_strikes:{short:c.shortStrike??null,long:c.longStrike??null,width:c.actualWidth??null},instruments:c.instruments??{short:short.instrumentName??null,long:long.instrumentName??null},option_type:c.optionType??null,quantity:s.quantity,...economic,
   execution_scenario:mode,
   execution_scenario_status:scenario.status,
   execution_scenario_reason:scenario.reason,
   execution_scenario_legacy_undifferentiated:scenario.legacyUndifferentiated??false,
   structure_entry_timestamp_utc:evaluated?isoMs(num(entry.valuationTimestamp)??num(entry.targetTimestamp),`candidate ${s.candidateId} ${mode} entry`):null,
   actual_dte_hours:evaluated&&expiry!==null&&num(entry.valuationTimestamp??entry.targetTimestamp)!==null?(expiry-num(entry.valuationTimestamp??entry.targetTimestamp)!)/36e5:null,
   actual_dte_days:evaluated&&expiry!==null&&num(entry.valuationTimestamp??entry.targetTimestamp)!==null?(expiry-num(entry.valuationTimestamp??entry.targetTimestamp)!)/864e5:null,
   entry_quality:evaluated?entry.estimateQuality??c.quality??null:null,
   entry_reason_codes:evaluated?[entry.status==="priced"?"entry_priced":"entry_unavailable",entry.priceSource==="direct-vwap"?"direct_vwap":"model_reconstructed",qualityCode(entry.estimateQuality??c.quality??null)]:["entry_unavailable"],
   quality_reason:evaluated?entry.qualityReason??entry.reason??null:scenario.reason,
   spread_synchronization_minutes:evaluated?entry.synchronizationGapMinutes??null:null,
   valuation_timestamp_utc:evaluated?isoMs(num(entry.valuationTimestamp)??num(entry.targetTimestamp),`candidate ${s.candidateId} ${mode} entry`):null,
   entry_legs:evaluated?{short:{action:"sell",instrument:short.instrumentName??null,price_native:short.priceBtcPerContract??null,price_usd:num(short.priceBtcPerContract)!==null&&index!==null?num(short.priceBtcPerContract)!*index:null,unslipped_price_native:short.unslippedPriceBtcPerContract??null,iv_percentage:obj(short.model).anchorIvApiPercent??null,iv_decimal:obj(short.model).anchorIvDecimal??null,evidence_timestamps:short.supportingTimestamps??[],trade_count:num(short.supportingTradeCount)??(Array.isArray(short.supportingTrades)?short.supportingTrades.length:null),traded_amount:short.observedAmount??null,nearest_gap_minutes:short.nearestGapMinutes??null},long:{action:"buy",instrument:long.instrumentName??null,price_native:long.priceBtcPerContract??null,price_usd:num(long.priceBtcPerContract)!==null&&index!==null?num(long.priceBtcPerContract)!*index:null,unslipped_price_native:long.unslippedPriceBtcPerContract??null,iv_percentage:obj(long.model).anchorIvApiPercent??null,iv_decimal:obj(long.model).anchorIvDecimal??null,evidence_timestamps:long.supportingTimestamps??[],trade_count:num(long.supportingTradeCount)??(Array.isArray(long.supportingTrades)?long.supportingTrades.length:null),traded_amount:long.observedAmount??null,nearest_gap_minutes:long.nearestGapMinutes??null}}:null,
   entry_index_price:evaluated?index:null,
   evidence_window_minutes:evaluated?entry.evidenceWindowMinutes??null:null,
   gross_credit_debit_native:evaluated?entry.grossSpreadBtc??null:null,
   opening_fees_native:evaluated?entry.openingFeesBtc??null:null,
   net_opening_cash_flow_native:evaluated?entry.netOpeningCashFlowBtc??null:null,
   long_leg_cash_cost_plus_entry_fees:evaluated&&num(long.priceBtcPerContract)!==null&&num(entry.openingFeesBtc)!==null?num(long.priceBtcPerContract)!*s.quantity+num(entry.openingFeesBtc)!:null,
   breakeven:null,credit_to_width:null,credit_to_maximum_loss:null,
   pricing_tracks:evaluated?{raw_vwap:entry.priceSource==="direct-vwap"?entry:null,iv_normalized:entry.priceSource==="model-reconstructed"?entry:null}:null,
  });
  const semantic=reconcileCandidateSpread(candidate as Record<string,unknown>);
  if(!semantic.valid&&initiallyEvaluated){
   forcedUnavailableReason=semantic.diagnostics.map(d=>d.reason).join("; ")||"Scenario-specific entry economics failed credit-spread validation.";
   evaluated=false;invalidScenarioKeys.add(`${s.candidateId}~${mode}`);
   const unavailable=row({...candidate,execution_scenario_status:"unavailable",execution_scenario_reason:forcedUnavailableReason,structure_entry_timestamp_utc:null,actual_dte_hours:null,actual_dte_days:null,entry_quality:null,entry_reason_codes:["entry_unavailable"],quality_reason:forcedUnavailableReason,spread_synchronization_minutes:null,valuation_timestamp_utc:null,entry_legs:null,entry_index_price:null,evidence_window_minutes:null,gross_credit_debit_native:null,opening_fees_native:null,net_opening_cash_flow_native:null,long_leg_cash_cost_plus_entry_fees:null,pricing_tracks:null});
   const checked=reconcileCandidateSpread(unavailable as Record<string,unknown>);return row({...checked.row,reconciliation_diagnostics:semantic.diagnostics});
  }
  if(!semantic.valid)throw new Error(`Research export blocked: ${semantic.diagnostics.map(d=>`${d.candidateId} (${d.eventId}): ${d.reason}`).join("; ")}`);return row({...semantic.row,reconciliation_diagnostics:semantic.diagnostics});
 }));
 /** One row per (structure, execution scenario, timestamp, pricing track). Never evaluated -> zero rows, not fabricated rows. */
 let omittedValuationsBeforeEntry=0,omittedValuationsAfterExpiry=0;
 const valuations:Row[]=selected.flatMap(({e,s})=>(["maker","taker"] as const).flatMap(mode=>{
  if(s.executionScenarios[mode].status!=="evaluated"||invalidScenarioKeys.has(`${s.candidateId}~${mode}`))return[];
  return s.executionScenarios[mode].valuationPathSnapshot.flatMap((p0,index)=>{const p=obj(p0),timestamp=num(p.timestamp),tracks:[[string,JsonValue],[string,JsonValue]]=[["raw_vwap",p.rawEstimate??null],["iv_normalized",p.modelEstimate??p.ivNormalizedEstimate??null]];const entrySnapshot=obj(s.executionScenarios[mode].entrySnapshot),entry=num(entrySnapshot.valuationTimestamp)??num(entrySnapshot.targetTimestamp),expiry=num(obj(s.candidateSnapshot).expiryTimestamp);if(timestamp!==null&&entry!==null&&timestamp<entry){omittedValuationsBeforeEntry++;return[]}if(timestamp!==null&&expiry!==null&&timestamp>expiry){omittedValuationsAfterExpiry++;return[]}return tracks.map(([track,estimate0])=>{const estimate=obj(estimate0),priced=p.status==="priced"&&estimate0!==null,raw=track==="raw_vwap",short=obj(estimate.sold),long=obj(estimate.bought),target=num(p.targetIndex),fees=priced?(raw?p.rawClosingFeesBtc:p.closingFeesBtc)??estimate.openingFeesBtc??null:null,pnl=priced?(raw?p.rawEstimatedNetPnlBtc:p.estimatedNetPnlBtc)??null:null,closingPer=raw?p.rawClosingSpreadValueBtcPerContract:p.closingSpreadValueBtcPerContract,closing=raw?p.rawClosingSpreadValueBtc:p.closingSpreadValueBtc;return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,execution_scenario:mode,analytics_track:mode==="maker"?"strict_maker":"strict_taker",valuation_id:`${s.venue}~valuation~${hash([s.candidateId,mode,timestamp,track])}`,venue:s.venue,...economic,timestamp_utc:isoMs(timestamp,`valuation ${s.candidateId} ${mode}`),window_role:"executable_observation",elapsed_hours:index*4,remaining_dte:null,pricing_track:track,target_underlying_index:target,index_resolution_source:obj(p.indexResolution).sourceCandleTimestamp??null,index_resolution_method:obj(p.indexResolution).lookupMethod??null,short_leg:{close_action:"buy",price_native:short.priceBtcPerContract??p.shortModelPriceBtc??null,iv_decimal:p.shortIvDecimal??obj(short.model).anchorIvDecimal??null,iv_source:p.soldIvSource??p.ivSource??null,evidence_timestamps:short.supportingTimestamps??[],trade_count:num(short.supportingTradeCount)??(Array.isArray(short.supportingTrades)?short.supportingTrades.length:null),traded_amount:short.observedAmount??null,nearest_gap_minutes:short.nearestGapMinutes??null},long_leg:{close_action:"sell",price_native:long.priceBtcPerContract??p.longModelPriceBtc??null,iv_decimal:p.longIvDecimal??obj(long.model).anchorIvDecimal??null,iv_source:p.longIvSource??p.ivSource??null,evidence_timestamps:long.supportingTimestamps??[],trade_count:num(long.supportingTradeCount)??(Array.isArray(long.supportingTrades)?long.supportingTrades.length:null),traded_amount:long.observedAmount??null,nearest_gap_minutes:long.nearestGapMinutes??null},local_iv_source:p.ivSource??null,quality:estimate.estimateQuality??p.estimateQuality??"unavailable",reason_codes:priced?["valuation_priced",qualityCode(estimate.estimateQuality??p.estimateQuality)]:["pricing_track_unavailable"],quality_reason:estimate.qualityReason??null,closing_spread_value_per_contract_native:priced?closingPer??null:null,scaled_closing_cash_flow_native:priced?closing??null:null,gross_pnl_native:pnl,closing_fees_native:fees,net_pnl_native:pnl,net_pnl_usd:pnl!==null&&target!==null?Number(pnl)*target:null,credit_capture_percentage:null,valuation_status:priced?"priced":"unavailable",missing_field_codes:priced?[]:[missingFieldCode(p.missingField)],unavailable_reason_codes:priced?[]:["pricing_track_unavailable"],unavailable_reason:priced?null:(raw?p.rawUnavailableReason:p.unavailableReason)??null,point_role:index===0?"entry":"scheduled_4h"})})});
 }));
 /** One row per (structure, execution scenario, required outcome type). Never evaluated -> zero rows for that scenario, not fabricated rows. */
 const outcomes:Row[]=selected.flatMap(({e,s})=>(["maker","taker"] as const).flatMap(mode=>{const scenario=s.executionScenarios[mode];if(scenario.status!=="evaluated"||invalidScenarioKeys.has(`${s.candidateId}~${mode}`))return[];const {byOutcome:by,unmapped}=outcomeIndex(scenario.outcomeSnapshots);const entrySnapshot=obj(scenario.entrySnapshot);return REQUIRED_OUTCOMES.map(kind=>{const o=by.get(kind),sourceStatus=sourceOutcomeStatus(o),trigger=triggerStatus(o),pnl=o?num(o.estimatedNetPnlBtc)??num(o.estimatedNetPnl):null,index=o?num(o.conversionIndex)??num(o.targetIndex):null;const oo=obj(o??null),decision=num(oo.decisionTimestamp),valuation=num(oo.valuationTimestamp),expiry=num(obj(s.candidateSnapshot).expiryTimestamp),entry=num(entrySnapshot.valuationTimestamp)??num(entrySnapshot.targetTimestamp),inWindow=valuation!==null&&entry!==null&&expiry!==null&&valuation>=entry&&valuation<=expiry;const evaluated=trigger==="reached"&&sourceStatus==="estimated";return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,execution_scenario:mode,analytics_track:mode==="maker"?"strict_maker":"strict_taker",outcome_id:`${s.venue}~outcome~${hash([s.candidateId,mode,kind])}`,venue:s.venue,outcome_type:kind,outcome_identity_version:RESEARCH_OUTCOME_IDENTITY_VERSION,source_label:o?String(o.label??""):null,source_status:sourceStatus,unmapped_source_labels:unmapped,status:evaluated?"evaluated":"unavailable",trigger_status:trigger,outcome_target_timestamp_utc:o?isoMs(decision,`outcome target ${s.candidateId} ${mode}`):null,trigger_timestamp_utc:inWindow?isoMs(decision,`outcome trigger ${s.candidateId} ${mode}`):null,decision_available_timestamp_utc:inWindow?isoMs(decision,`outcome decision ${s.candidateId} ${mode}`):null,valuation_timestamp_utc:inWindow?isoMs(valuation,`outcome valuation ${s.candidateId} ${mode}`):null,window_role:inWindow?"executable_observation":"outside_executable_window",before_expiry:trigger!=="after_expiry",before_invalidation:null,holding_hours:outcomeHoldingHours({reached:evaluated,entryTimestampMs:entry,valuationTimestampMs:valuation,decisionTimestampMs:decision,expiryTimestampMs:expiry}),raw_status:trigger!=="reached"?"not_applicable":o?.rawEstimate!=null||kind==="settlement"?"priced":"unavailable",iv_normalized_status:trigger!=="reached"?"not_applicable":o?.modelEstimate!=null||kind==="settlement"?"priced":"unavailable",raw_net_pnl_native:o?.rawEstimate!=null||kind==="settlement"?pnl:null,raw_net_pnl_usd:(o?.rawEstimate!=null||kind==="settlement")&&pnl!==null&&index!==null?pnl*index:null,iv_normalized_net_pnl_native:o?.modelEstimate!=null||kind==="settlement"?pnl:null,iv_normalized_net_pnl_usd:(o?.modelEstimate!=null||kind==="settlement")&&pnl!==null&&index!==null?pnl*index:null,net_pnl_native:null,net_pnl_usd:null,closing_fees_native:o?o.feesBtc??null:null,quality:o?.estimateQuality??"unavailable",reason_codes:[...(trigger==="reached"?(pnl===null?["outcome_reached_but_unpriced"]:evaluated?["outcome_priced"]:["outcome_source_unavailable"]):trigger==="not_reached"?["outcome_not_reached"]:trigger==="after_expiry"?["outcome_after_expiry"]:sourceStatus==="absent"?["outcome_source_absent"]:["outcome_ambiguous_sequence"]),...(unmapped.length?["outcome_label_unmapped"]:[])],evidence_reason:o?.evidenceReason??null})});}));
/**
 * Economic rows for the tracks that are NOT strict immediate execution.
 *
 * This is the fix for the execution gate. The immediate builders above emit
 * nothing when a scenario is unevaluated, so a structurally resolved candidate
 * with a good reference valuation used to export zero economic rows. These
 * tracks are derived from their own engines' persisted snapshots and are
 * therefore present regardless of whether any fill evidence exists.
 *
 * Timestamps are the producing engine's own: a delayed track keeps its real
 * delayed opening timestamp and is never backdated to the reference entry.
 * Points outside [track entry, expiry] are dropped rather than clamped.
 */
 const independentValuations:Row[]=[],independentOutcomes:Row[]=[];
 for(const {e,s} of selected){
  const expiry=num(obj(s.candidateSnapshot).expiryTimestamp);
  for(const t of describeCanonicalTracks(s as unknown as Record<string,unknown>)){
   if(t.status!=="available"||t.track==="strict_maker"||t.track==="strict_taker")continue;
   const trackMeta={analytics_track:t.track,track_status:t.status,track_reason_code:t.reasonCode,
    track_entry_status:t.entryStatus,track_path_status:t.pathStatus,
    entry_basis:t.entryBasis,entry_timestamp_utc:iso(t.entryTimestampMs),valuation_basis:t.valuationBasis,
    execution_evidence:t.executionEvidence,valuation_source:t.valuationSource,
    provenance:t.provenance,engine_version:t.engineVersion};
   for(const [index,point0] of t.valuationPath.entries()){
    const p=obj(point0),timestamp=num(p.timestamp);
    // Causality: never before the track's own entry, never after expiry.
    if(timestamp!==null&&t.entryTimestampMs!==null&&timestamp<t.entryTimestampMs){omittedValuationsBeforeEntry++;continue}
    if(timestamp!==null&&expiry!==null&&timestamp>expiry){omittedValuationsAfterExpiry++;continue}
    const estimate=obj(p.rawEstimate??p.modelEstimate??p.ivNormalizedEstimate??null);
    const short=obj(estimate.sold),long=obj(estimate.bought);
    // The delayed engine names its post-entry point fields `estimatedPnlBtc`
    // and `underlyingIndex`; the reference engines use `estimatedNetPnlBtc`
    // and `targetIndex`. Reading only the latter made every delayed valuation
    // row unavailable while the track still claimed to be available.
    const target=num(p.targetIndex)??num(p.underlyingIndex);
    const pnl=num(p.estimatedNetPnlBtc)??num(p.estimatedPnlBtc);
    const shortIv=legVolatility(short,p.shortIvDecimal,p.soldIvSource??p.ivSource);
    const longIv=legVolatility(long,p.longIvDecimal,p.longIvSource??p.ivSource);
    independentValuations.push(row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,
     candidate_id:s.candidateId,execution_scenario:t.executionScenario,...trackMeta,
     valuation_id:`${s.venue}~valuation~${hash([s.candidateId,t.track,timestamp])}`,venue:s.venue,...economic,
     timestamp_utc:isoMs(timestamp,`valuation ${s.candidateId} ${t.track}`),
     window_role:"executable_observation",elapsed_hours:index*4,remaining_dte:null,
     pricing_track:t.track,target_underlying_index:target,
     index_resolution_source:obj(p.indexResolution).sourceCandleTimestamp??null,
     index_resolution_method:obj(p.indexResolution).lookupMethod??null,
     valuation_status:pnl===null?"unavailable":"priced",
     net_pnl_native:pnl,net_pnl_usd:pnl!==null&&target!==null?pnl*target:null,
     // Per-leg IV preserved in normalized form for a future volatility module.
     // No spread-level IV is synthesised, and none of this affects execution quality.
     short_leg_volatility:{iv_decimal:shortIv.ivDecimal,iv_api_percentage:shortIv.ivApiPercent,iv_units:shortIv.ivUnits,
      iv_source:shortIv.ivSource,iv_source_timestamp_utc:iso(shortIv.ivSourceTimestampMs),observation:shortIv.observation,
      anchor_index:shortIv.anchorIndex,target_index:shortIv.targetIndex,dte_days:shortIv.dteDays},
     long_leg_volatility:{iv_decimal:longIv.ivDecimal,iv_api_percentage:longIv.ivApiPercent,iv_units:longIv.ivUnits,
      iv_source:longIv.ivSource,iv_source_timestamp_utc:iso(longIv.ivSourceTimestampMs),observation:longIv.observation,
      anchor_index:longIv.anchorIndex,target_index:longIv.targetIndex,dte_days:longIv.dteDays},
     reason_codes:pnl===null?["pricing_track_unavailable"]:["valuation_priced"]}));
   }
   // A track whose own outcome engine produced nothing has no outcomes to
   // export. Emitting the required set anyway would fabricate structure and
   // mislabel absence as an ambiguous trigger. This is an honest absence, not
   // the execution gate: reference outcomes appear whenever the reference
   // engine produced them, regardless of any fill evidence.
   if(!t.outcomeSnapshots.length)continue;
   const {byOutcome:by,unmapped}=outcomeIndex(t.outcomeSnapshots);
   for(const kind of REQUIRED_OUTCOMES){
    const o=by.get(kind),sourceStatus=sourceOutcomeStatus(o),trigger=triggerStatus(o);
    // An outcome the engine never produced is honest absence and is skipped,
    // rather than exported as a fabricated unavailable row.
    if(sourceStatus==="absent")continue;
    const evaluated=trigger==="reached"&&sourceStatus==="estimated";
    const pnl=o?num(o.estimatedNetPnlBtc)??num(o.estimatedNetPnl):null;
    const index=o?num(o.conversionIndex)??num(o.targetIndex):null;
    const oo=obj(o??null),decision=num(oo.decisionTimestamp),valuation=num(oo.valuationTimestamp);
    const inWindow=valuation!==null&&t.entryTimestampMs!==null&&expiry!==null&&valuation>=t.entryTimestampMs&&valuation<=expiry;
    independentOutcomes.push(row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,
     candidate_id:s.candidateId,execution_scenario:t.executionScenario,...trackMeta,
     outcome_id:`${s.venue}~outcome~${hash([s.candidateId,t.track,kind])}`,venue:s.venue,outcome_type:kind,
     outcome_identity_version:RESEARCH_OUTCOME_IDENTITY_VERSION,source_label:o?String(o.label??""):null,
     source_status:sourceStatus,unmapped_source_labels:unmapped,
     status:evaluated?"evaluated":"unavailable",trigger_status:trigger,
     outcome_target_timestamp_utc:o?isoMs(decision,`outcome target ${s.candidateId} ${t.track}`):null,
     trigger_timestamp_utc:inWindow?isoMs(decision,`outcome trigger ${s.candidateId} ${t.track}`):null,
     decision_available_timestamp_utc:inWindow?isoMs(decision,`outcome decision ${s.candidateId} ${t.track}`):null,
     valuation_timestamp_utc:inWindow?isoMs(valuation,`outcome valuation ${s.candidateId} ${t.track}`):null,
     window_role:inWindow?"executable_observation":"outside_executable_window",
     before_expiry:trigger!=="after_expiry",before_invalidation:null,
     // Measured from THIS track's own actual entry, so a delayed track reports
     // the interval it genuinely held for rather than the signal-anchored one.
     holding_hours:outcomeHoldingHours({reached:evaluated,entryTimestampMs:t.entryTimestampMs,valuationTimestampMs:valuation,decisionTimestampMs:decision,expiryTimestampMs:expiry}),
     net_pnl_native:evaluated?pnl:null,
     net_pnl_usd:evaluated&&pnl!==null&&index!==null?pnl*index:null,
     closing_fees_native:o?o.feesBtc??null:null,quality:o?.estimateQuality??"unavailable",
     reason_codes:[...(trigger==="reached"?(pnl===null?["outcome_reached_but_unpriced"]:evaluated?["outcome_priced"]:["outcome_source_unavailable"])
      :trigger==="not_reached"?["outcome_not_reached"]:trigger==="after_expiry"?["outcome_after_expiry"]:["outcome_ambiguous_sequence"]),
      ...(unmapped.length?["outcome_label_unmapped"]:[])],
     evidence_reason:o?.evidenceReason??null}));
   }
  }
 }

 const availability:Row[]=store.events.flatMap(e=>e.generationSnapshot.candidates.map(c=>{const selectedStructure=e.selectedStructures.find(s=>s.candidateId===c.candidateId);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,availability_id:`${c.candidateId}~generation~${hash([c.requestedStrikes,c.targetHorizon,c.strikeMethod])}`,candidate_id:c.candidateId,strategy_variant_id:selectedStructure?.strategyVariantId??c.candidateId,venue:c.venue,is_selected:Boolean(selectedStructure),contract_resolution:selectedStructure?.contractResolution??null,reference_valuation:selectedStructure?.referenceValuation??null,delayed_execution:selectedStructure?.delayedExecution??null,modeled_execution:selectedStructure?.modeledExecution??null,structure_type:c.structure,target_horizon_days:c.targetHorizon,strike_method:c.strikeMethod,width:c.actualStrikes.width??c.requestedStrikes.width,requested_strikes:c.requestedStrikes,actual_strikes:c.actualStrikes,actual_expiry_timestamp_utc:iso(c.actualExpiryTimestamp),requested_expiry_timestamp_utc:null,instruments:null,status:c.status,reason_codes:[c.status==="priced"?"candidate_priced":"candidate_unavailable"],availability_reasons:c.availabilityReasons,entry_quality:c.entryQuality,retrieval_status:selectedStructure?.contractResolution?.status??"metadata_unavailable",generation_configuration:e.generationSnapshot.configuration})})).sort((a,b)=>String(a.candidate_id).localeCompare(String(b.candidate_id))||String(a.availability_id).localeCompare(String(b.availability_id)));
 const margins=selected.map(({e,s})=>{
  // A store saved before the canonical margin wiring existed carries the legacy
  // placeholder ("No margin result was produced."), which used to export as
  // margin_not_recomputed even though the execution-independent reference
  // valuation needed to compute it is sitting right there. Recompute at export
  // time through the SAME versioned estimator the live path uses -- never a
  // second margin model -- and only when the persisted snapshot is genuinely
  // absent or that placeholder. A recomputation that legitimately fails still
  // reports its own specific reason code.
  const persisted=obj(s.marginSnapshot);
  const stale=!Object.keys(persisted).length
   ||persisted.reasonCode==="margin_not_recomputed"
   ||persisted.reason===LEGACY_MARGIN_NOT_COMPUTED_REASON
   ||persisted.unavailabilityReason===LEGACY_MARGIN_NOT_COMPUTED_REASON;
  const m=stale?obj(buildResearchMarginSnapshot(s)):persisted,available=m.status==="available"||m.state==="ok",deployment=obj(m.deployment),openingIm=num(m.openingInitialMarginBtc)??num(m.initialMarginBtc),openingMm=num(m.openingMaintenanceMarginBtc)??num(m.maintenanceMarginBtc),peakIm=num(m.peakInitialMarginBtc),peakMm=num(m.peakMaintenanceMarginBtc);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,margin_scenario_id:`${s.venue}~margin~${hash(s.candidateId)}`,venue:s.venue,margin_status:available?"available":"unavailable",margin_model:deployment.model??null,method_version:m.engineVersion??m.ruleVersion??null,rule_version:m.ruleVersion??null,provenance:m.provenance??null,account_configuration:deployment.accountAssumption??null,collateral_currency:deployment.collateralCurrency??"BTC",settlement_currency:"BTC",incremental_initial_margin:available?openingIm:null,incremental_maintenance_margin:available?openingMm:null,peak_initial_margin:available?peakIm:null,peak_maintenance_margin:available?peakMm:null,peak_timestamp_utc:available?iso(num(m.peakInitialTimestamp)??num(m.observationTimestamp)):null,capital_days_margin:available?num(m.capitalDaysMarginBtc):null,maximum_structural_loss_native:num(m.maximumStructuralLossBtcAtReferenceIndex)??num(m.theoreticalMaximumSpreadLossBtc),
   maximum_structural_loss_usd:num(m.maximumStructuralLossUsd),
   maximum_structural_loss_settlement_index:num(m.worstStructuralSettlementIndex),
   settlement_fee_treatment:(m.settlementFeeTreatment??null) as JsonValue,
   maximum_structural_loss_units:{native:"BTC",quote:"USD",sign_convention:STRUCTURAL_LOSS_SIGN_CONVENTION},
   maximum_structural_loss_method:typeof m.maximumLossMethod==="string"?m.maximumLossMethod:null,
   maximum_structural_loss_method_version:typeof m.maximumLossMethodVersion==="string"?m.maximumLossMethodVersion:null,
   maximum_structural_loss_assumption:typeof m.maximumLossAssumption==="string"?m.maximumLossAssumption:null,reference_index:num(m.referenceIndex)??num(m.indexPrice),calculation_method:available?(m.method??m.evidenceModel??"historical Standard Margin reconstruction"):null,data_quality:available?"historical_formula_reconstruction":"unavailable",reason_codes:available?[]:[String(m.reasonCode??canonicalMarginReason(m.reason??m.unavailabilityReason))],unavailable_reason:available?null:String(m.reason??m.unavailabilityReason??"Verified historical margin reconstruction is unavailable."),margin_measurement:"model_estimated_historical_requirement",
   margin_measurement_note:"Reconstructed from the versioned Deribit Standard Margin formula against causal historical marks. This is a model-estimated historical requirement, not evidence of the balance Deribit actually reserved in the historical account.",
   capital_days_basis:available?"initial_margin_btc":null,
   capital_days_definition:available?"Initial margin in BTC integrated piecewise-constant between canonical valuation points from the reference entry to expiry, with the final point held to the terminal timestamp; equivalent to capital-days-to-expiry on the initial-margin basis.":null,
   portfolio_margin_status:"unavailable",
   portfolio_margin_reason:"Portfolio Margin requires complete contemporaneous account state and a Deribit risk-engine response; no runnable historical implementation exists, and Standard Margin is never substituted for it.",
   margin_inputs:{path:m.path??null,mark_price_btc:m.markPriceBtc??null,vertical_treatment:m.verticalTreatment??null,integration_convention:m.integrationConvention??null} });});
 /** Each usage reference now carries execution_scenario, so provenance shows exactly which scenario a given raw trade supported -- never left ambiguous between maker and taker. */
 const evidence=store.events.flatMap(e=>{const catalog=new Map((e.evidenceCatalog??[]).map(t=>[t.evidenceId,t]));const grouped=new Map<string,{t:Record<string,JsonValue>;usages:Row[]}>();for(const s of e.selectedStructures){if(s.evidenceUsages?.length){for(const u of s.evidenceUsages){const t0=catalog.get(u.evidenceId);if(!t0)continue;const t=t0 as unknown as Record<string,JsonValue>;const item=grouped.get(u.evidenceId)??{t,usages:[]};item.usages.push(row({candidate_id:s.candidateId,execution_scenario:u.executionScenario??null,role:u.role,valuation_timestamp_utc:iso(num(u.valuationTimestamp)),pricing_track:u.pricingTrack,leg:u.leg}));grouped.set(u.evidenceId,item)}}else for(const [i,t0] of (s.evidenceTradeSnapshots??[]).entries()){const t=obj(t0),id=`${s.venue}~evidence~${hash([s.candidateId,t.tradeId??i,t.timestamp])}`;grouped.set(id,{t:{...t,evidenceId:id,venue:s.venue} as Record<string,JsonValue>,usages:[row({candidate_id:s.candidateId,execution_scenario:null,role:"saved-source-trade",valuation_timestamp_utc:null,pricing_track:null,leg:null})]})}}return[...grouped].map(([id,{t,usages}])=>{const iv=num(t.ivDecimal),price=num(t.price),index=num(t.indexPrice);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:usages[0]?.candidate_id??null,valuation_id:null,evidence_id:`${id}~${hash(e.eventId)}`,venue:t.venue??"deribit",instrument:t.instrument??t.instrumentName??null,trade_id:t.tradeId??null,timestamp_utc:isoMs(num(t.timestamp),`evidence ${id}`),timestamp_semantics:"raw_market_trade_time",window_role:usages.some(u=>{const s=selected.find(x=>x.s.candidateId===u.candidate_id)?.s;const scenarioMode=u.execution_scenario==="maker"||u.execution_scenario==="taker"?u.execution_scenario:null;const entrySnapshot=s&&scenarioMode?obj(s.executionScenarios[scenarioMode].entrySnapshot):{};const et=num(entrySnapshot.valuationTimestamp)??num(entrySnapshot.targetTimestamp),ex=s?num(obj(s.candidateSnapshot).expiryTimestamp):null,vt=Date.parse(String(u.valuation_timestamp_utc));return et!==null&&ex!==null&&Number.isFinite(vt)&&vt>=et&&vt<=ex})?"executable_evidence":"raw_source_outside_executable_window",direction:t.direction??null,native_currency:"BTC",price_native:price,price_usd:price!==null&&index!==null?price*index:null,amount:t.amount??null,iv_api_percentage:t.ivApiPercent??(iv===null?null:iv*100),iv_decimal:iv,index_price:index,block_id:t.blockTradeId??null,rfq_id:t.rfqId??null,evidence_role:"catalog-trade",usage_references:usages,source_endpoint_file:"persisted-selection-evidence-catalog",pricing_track:null})})});
 const futuresBuilt=store.events.map(e=>buildEventFuturesBaseline(e,"vpoc"));
 const futures=futuresBuilt.map(({comparison},i)=>row({run_id:runId,source_run_id:sourceIds.get(store.events[i].eventId),venue:"deribit",...comparison}));
 const futuresPath=futuresBuilt.flatMap(({path},i)=>path.map(p=>row({run_id:runId,source_run_id:sourceIds.get(store.events[i].eventId),venue:"deribit",...p})));
 // Volatility state, attached from the injected snapshot. Rows for events or
 // candidates this store does not contain are dropped rather than exported
 // with a broken foreign key; nothing is synthesized for a missing one.
 const eventIdSet=new Set(store.events.map(e=>e.eventId));
 const selectedByCandidate=new Map(selected.map(({e,s})=>[s.candidateId,{e,s}]));
 const eventVolatility:Row[]=(context.volatility?.events??[])
  .filter(v=>eventIdSet.has(v.event_id))
  .map(v=>row({run_id:runId,source_run_id:sourceIds.get(v.event_id),venue:store.events.find(e=>e.eventId===v.event_id)?.selectedStructures[0]?.venue??"deribit",...(v as unknown as Record<string,unknown>)}))
  .sort((a,b)=>String(a.event_id).localeCompare(String(b.event_id)));
 const structureVolatility:Row[]=(context.volatility?.structures??[])
  .filter(v=>selectedByCandidate.has(v.candidate_id))
  .map(v=>{const hit=selectedByCandidate.get(v.candidate_id)!;return row({run_id:runId,source_run_id:sourceIds.get(hit.e.eventId),venue:hit.s.venue,...(v as unknown as Record<string,unknown>)})})
  .sort((a,b)=>String(a.candidate_id).localeCompare(String(b.candidate_id)));

 const sourceRuns=store.events.map(e=>({source_run_id:sourceIds.get(e.eventId),venue:e.selectedStructures[0]?.venue??e.generationSnapshot.candidates[0]?.venue??"deribit",event_id:e.eventId,configuration:e.generationSnapshot.configuration,effective_configuration_hash:configurationHashes.get(e.eventId),configuration_identity_version:CONFIGURATION_IDENTITY_VERSION,application_build:e.generationSnapshot.configuration.applicationBuild??BUILD_PROVENANCE_UNAVAILABLE,generation_timestamp_utc:e.generationSnapshot.generatedAtUtc}));
 const migratedValuationWindowDiagnostics=selected.flatMap(({e,s})=>(["maker","taker"] as const).flatMap(executionScenario=>{const diagnostic=s.executionScenarios[executionScenario].valuationWindowMigration;return diagnostic?[{event_id:e.eventId,candidate_id:s.candidateId,execution_scenario:executionScenario,...diagnostic}]:[]}));
 const run=row({schema_version:RESEARCH_BUNDLE_SCHEMA_VERSION,futures_engine_version:FUTURES_ENGINE_VERSION,valuation_window_diagnostics:{migrated:migratedValuationWindowDiagnostics,builder_omitted_before_entry:omittedValuationsBeforeEntry,builder_omitted_after_expiry:omittedValuationsAfterExpiry},run_id:runId,generated_at_utc:generatedAtUtc,dataset_id:store.datasetId,dataset_version_updated_at:datasetUpdatedAt??store.updatedAtUtc,application_commit_build_id:[...new Set(sourceRuns.map(x=>x.application_build))],pricing_engine_versions:[...new Set(sourceRuns.map(x=>x.configuration.pricingEngineVersion))],quality_rules_versions:[...new Set(sourceRuns.map(x=>x.configuration.qualityRulesVersion))],valuation_methodology_version:"simple-model-reconstruction/1.0.0",valuation_intervals:[...new Set(sourceRuns.map(x=>x.configuration.valuationInterval))],timezone:"UTC",included_pricing_tracks:["raw_vwap","iv_normalized"],included_execution_scenarios:["maker","taker"],dte_windows:sourceRuns.map(x=>x.configuration.dteWindows),expiry_selection_modes:[...new Set(sourceRuns.map(x=>x.configuration.expirySelectionMode))],evidence_windows:sourceRuns.map(x=>x.configuration.historicalEvidenceWindows),synchronization_thresholds:sourceRuns.map(x=>x.configuration.synchronizationThresholds),quality_thresholds:sourceRuns.map(x=>x.configuration.qualityThresholds),model_assumptions:sourceRuns.map(x=>x.configuration.modelAssumptions),fee_assumptions:sourceRuns.map(x=>x.configuration.feeAssumptions),settlement_rules:sourceRuns.map(x=>x.configuration.settlementRules),trade_dataset_mr_event_count:num(context.tradeDatasetMrEventCount??null)??null,trade_dataset_mr_event_count_source:num(context.tradeDatasetMrEventCount??null)!==null?"active_trade_dataset":"unavailable",persisted_research_event_count:events.length,events_with_generated_candidates_count:new Set(availability.map(x=>x.event_id)).size,events_with_selected_candidates_count:new Set(candidates.map(x=>x.event_id)).size,events_with_stored_underlying_paths_count:new Set(paths.map(x=>x.event_id)).size,selected_structure_count:new Set(candidates.map(x=>x.candidate_id)).size,selected_structure_execution_row_count:candidates.length,generated_denominator_count:availability.length,venues:[...new Set(store.events.flatMap(e=>e.generationSnapshot.candidates.map(c=>c.venue))) ],venue_configuration:{deribit:economic,bybit:null,binance:null},effective_configuration_hash:distinctMethodologies[0]??null,methodology_identity:methodologyIdentity(store.events[0]?.generationSnapshot.configuration??{}) as unknown as JsonValue,build_provenance_status:buildProvenanceStatus(sourceRuns.map(x=>x.application_build)),source_runs:sourceRuns,table_availability:{underlying_path:paths.length?"available":"unavailable",structure_economics:structureEconomics.some(r=>r.maximum_structural_loss_status==="available")?"available":"unavailable",candidates:candidates.length?"available":"unavailable",availability:availability.length?"available":"unavailable",valuations:[...valuations,...independentValuations].some(v=>v.valuation_status==="priced")?"available":"unavailable",outcomes:[...outcomes,...independentOutcomes].some(o=>o.status==="evaluated")?"available":"unavailable",margin_scenarios:margins.some(m=>m.margin_status==="available")?"available":"unavailable",evidence_trades:evidence.length?"available":"unavailable",futures_comparisons:futures.some(f=>f.availability==="available")?"available":"unavailable",futures_path:futuresPath.length?"available":"unavailable",event_volatility_state:eventVolatility.length?"available":"unavailable",structure_volatility_state:structureVolatility.length?"available":"unavailable"},volatility_method_versions:{event_volatility_state:EVENT_VOLATILITY_STATE_METHOD_VERSION,structure_volatility_state:STRUCTURE_VOLATILITY_STATE_METHOD_VERSION}});
 const files=Object.fromEntries(RESEARCH_BUNDLE_FILES.map(name=>[name,name==="run.json"?JSON.stringify(run)+"\n":lines(({"events.jsonl":events,"underlying_path.jsonl":paths,"structure_economics.jsonl":structureEconomics,"candidates.jsonl":candidates,"valuations.jsonl":[...valuations,...independentValuations],"outcomes.jsonl":[...outcomes,...independentOutcomes],"availability.jsonl":availability,"margin_scenarios.jsonl":margins,"evidence_trades.jsonl":evidence,"futures_comparisons.jsonl":futures,"futures_path.jsonl":futuresPath,"event_volatility_state.jsonl":eventVolatility,"structure_volatility_state.jsonl":structureVolatility})[name]??[])])) as ResearchBundle["files"];
 const validation=validateResearchBundle(files);if(!validation.ok)throw new Error(summarizeResearchBundleErrors(validation.errors).summary);return{files,run};
}

export function validateResearchBundle(files:Partial<Record<string,string>>):{ok:boolean;errors:string[]}{
 const errors:string[]=[];for(const name of RESEARCH_BUNDLE_FILES)if(typeof files[name]!=="string")errors.push(`Missing ${name}.`);if(errors.length)return{ok:false,errors};
 let run:Row;try{run=JSON.parse(files["run.json"]!)}catch{return{ok:false,errors:["run.json is invalid JSON."]}}
 if(run.schema_version!==RESEARCH_BUNDLE_SCHEMA_VERSION)errors.push(`Unknown schema version ${String(run.schema_version)}.`);
 const finite=(value:unknown,path:string)=>{if(typeof value==="number"&&!Number.isFinite(value))errors.push(`${path} contains a nonfinite number.`);else if(value&&typeof value==="object")for(const [key,child] of Object.entries(value))finite(child,`${path}.${key}`)};finite(run,"run.json");
 const parsed=new Map<string,Row[]>();for(const name of RESEARCH_BUNDLE_FILES.filter(n=>n.endsWith(".jsonl"))){const rows:Row[]=[];for(const [i,line] of files[name]!.split("\n").entries()){if(!line)continue;try{const r=JSON.parse(line);if(!r||typeof r!=="object"||Array.isArray(r))throw 0;if(!r.venue)errors.push(`${name}:${i+1} has no venue.`);finite(r,`${name}:${i+1}`);rows.push(r)}catch{errors.push(`${name}:${i+1} is invalid JSONL.`)}}parsed.set(name,rows)}
 const rows=(name:string)=>parsed.get(name)??[], ids=(name:string,key:string)=>{const seen=new Set<JsonValue>();for(const r of rows(name)){if(r[key]==null)errors.push(`${name} has a missing ${key}.`);else if(seen.has(r[key]))errors.push(`${name} has duplicate ${key}: ${String(r[key])}.`);else seen.add(r[key])}return seen};
 // candidate_id is the STRUCTURAL identity shared by a structure's maker and
 // taker rows, so it is deliberately not row-unique in candidates.jsonl --
 // structure_execution_id is the genuine per-row key there instead.
 const collect=(name:string,key:string)=>{const seen=new Set<JsonValue>();for(const r of rows(name)){if(r[key]==null)errors.push(`${name} has a missing ${key}.`);else seen.add(r[key])}return seen};
 const eventIds=ids("events.jsonl","event_id"),candidateIds=collect("candidates.jsonl","candidate_id"),structureExecutionIds=ids("candidates.jsonl","structure_execution_id"),availabilityIds=collect("availability.jsonl","candidate_id"),availabilityRowIds=ids("availability.jsonl","availability_id");void structureExecutionIds;void availabilityRowIds;ids("valuations.jsonl","valuation_id");ids("outcomes.jsonl","outcome_id");ids("margin_scenarios.jsonl","margin_scenario_id");ids("evidence_trades.jsonl","evidence_id");ids("futures_comparisons.jsonl","comparison_id");
 // Exactly one scenario-independent economic record per structure. Two rows for
 // one candidate_id would mean the record had been duplicated per execution
 // scenario, which is the architecture this table exists to prevent.
 const economicsIds=ids("structure_economics.jsonl","candidate_id");
 for(const id of candidateIds)if(!economicsIds.has(id))errors.push(`Candidate ${String(id)} has no scenario-independent structure-economics record.`);
 for(const id of economicsIds)if(!candidateIds.has(id))errors.push(`Structure-economics record ${String(id)} has no candidate row.`);
 for(const r of rows("structure_economics.jsonl")){
  const tracks=Array.isArray(r.tracks)?r.tracks:null;
  if(!tracks)  {errors.push(`Structure-economics record ${String(r.candidate_id)} is missing its analytical track statuses.`);continue}
  const named=new Set(tracks.map(t=>String(obj(t as JsonValue).track)));
  for(const track of CANONICAL_TRACKS)if(!named.has(track))errors.push(`Structure-economics record ${String(r.candidate_id)} omits the status of track ${track}.`);
 }
 for(const r of rows("candidates.jsonl"))if(r.execution_scenario!=="maker"&&r.execution_scenario!=="taker")errors.push(`Candidate ${String(r.candidate_id)} has an invalid execution_scenario: ${String(r.execution_scenario)}.`);
 const runId=run.run_id,sourceRuns=new Set((Array.isArray(run.source_runs)?run.source_runs:[]).map(x=>obj(x).source_run_id));for(const [name,table] of parsed)for(const r of table){if(r.run_id!==runId)errors.push(`${name} has incompatible run_id.`);if(!sourceRuns.has(r.source_run_id))errors.push(`${name} has unknown or flattened source_run_id.`)}
 for(const r of rows("candidates.jsonl")){if(!eventIds.has(r.event_id))errors.push(`Candidate ${r.candidate_id} has a broken event foreign key.`);if(r.is_selected!==true)errors.push(`Candidate ${r.candidate_id} was not explicitly selected.`);if(!availabilityIds.has(r.candidate_id))errors.push(`Selected candidate ${r.candidate_id} is absent from availability.`)}
 for(const name of ["valuations.jsonl","outcomes.jsonl","margin_scenarios.jsonl","evidence_trades.jsonl"])for(const r of rows(name))if(!candidateIds.has(r.candidate_id))errors.push(`${name} has a broken candidate foreign key: ${r.candidate_id}.`);
 const availabilitySelected=new Set(rows("availability.jsonl").filter(r=>r.is_selected===true).map(r=>r.candidate_id));for(const id of candidateIds)if(!availabilitySelected.has(id))errors.push(`Exported candidate ${String(id)} is absent from saved selections.`);
 const currency=(r:Row,name:string)=>{if(r.venue==="deribit"&&((r.contract_style!=null&&r.contract_style!=="inverse")||(r.native_currency!=null&&r.native_currency!=="BTC")||(r.premium_currency!=null&&r.premium_currency!=="BTC")||(r.settlement_currency!=null&&r.settlement_currency!=="BTC")||(r.quote_currency!=null&&r.quote_currency!=="USD")||(r.contract_multiplier!=null&&r.contract_multiplier!==1)))errors.push(`${name} has a Deribit venue/currency contradiction.`);if(r.venue==="bybit"&&r.contract_style==="linear"&&((r.native_currency!=null&&r.native_currency!=="USDC")||(r.premium_currency!=null&&r.premium_currency!=="USDC")||(r.settlement_currency!=null&&r.settlement_currency!=="USDC")||(r.quote_currency!=null&&r.quote_currency!=="USD")||(r.contract_multiplier!=null&&(num(r.contract_multiplier)===null||Number(r.contract_multiplier)<=0))))errors.push(`${name} has a Bybit linear-USDC venue/currency contradiction.`)};for(const [name,table] of parsed)for(const r of table)currency(r,name);
 const timestamps=(value:unknown,path:string)=>{if(value&&typeof value==="object")for(const [key,child] of Object.entries(value)){if(key.endsWith("_timestamp_utc")&&child!==null&&(typeof child!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(child)||!Number.isFinite(Date.parse(child))))errors.push(`${path}.${key} is not a valid UTC timestamp.`);timestamps(child,`${path}.${key}`)}};timestamps(run,"run.json");for(const [name,table] of parsed)table.forEach((r,i)=>timestamps(r,`${name}:${i+1}`));
 // Keyed by (candidate_id, execution_scenario), since the two scenario rows
 // for one structure can have different entry evidence timestamps -- a plain
 // candidate_id map would let one scenario's bounds silently validate the
 // other's rows.
 const candidates=new Map(rows("candidates.jsonl").map(r=>[`${String(r.candidate_id)}~${String(r.execution_scenario)}`,r]));
 for(const r of rows("valuations.jsonl")){const c=candidates.get(`${String(r.candidate_id)}~${String(r.execution_scenario)}`),t=Date.parse(String(r.timestamp_utc));if(c&&Number.isFinite(t)){const entry=Date.parse(String(c.structure_entry_timestamp_utc??c.valuation_timestamp_utc)),expiry=Date.parse(String(c.expiry_timestamp_utc)),context=`event ${String(r.event_id)} / ${String(r.candidate_id)} / ${String(r.execution_scenario)}`;if(Number.isFinite(entry)&&t<entry)errors.push(`${context}: valuation ${String(r.timestamp_utc)} is before entry ${new Date(entry).toISOString()} (expiry ${String(c.expiry_timestamp_utc)}); timestamp outside entry-to-expiry bounds.`);else if(Number.isFinite(expiry)&&t>expiry)errors.push(`${context}: valuation ${String(r.timestamp_utc)} is after expiry ${new Date(expiry).toISOString()} (entry ${String(c.structure_entry_timestamp_utc??c.valuation_timestamp_utc)}); timestamp outside entry-to-expiry bounds.`);if(r.window_role!=="executable_observation")errors.push(`${context}: valuation ${String(r.timestamp_utc)} is not executable (entry ${String(c.structure_entry_timestamp_utc??c.valuation_timestamp_utc)}, expiry ${String(c.expiry_timestamp_utc)}).`)}}
 for(const r of rows("outcomes.jsonl")){const c=candidates.get(`${String(r.candidate_id)}~${String(r.execution_scenario)}`),t=Date.parse(String(r.valuation_timestamp_utc??r.trigger_timestamp_utc));if(c&&Number.isFinite(t)){const entry=Date.parse(String(c.structure_entry_timestamp_utc??c.valuation_timestamp_utc)),expiry=Date.parse(String(c.expiry_timestamp_utc));if((Number.isFinite(entry)&&t<entry)||(Number.isFinite(expiry)&&t>expiry))errors.push(`${String(r.candidate_id)} (${String(r.execution_scenario)}) has a timestamp outside entry-to-expiry bounds.`)}}
 const statusEnums:Record<string,Set<string>>={"availability.jsonl":new Set(["priced","unavailable"]),"valuations.jsonl":new Set(["priced","unavailable"]),"margin_scenarios.jsonl":new Set(["available","unavailable"])};for(const [name,allowed] of Object.entries(statusEnums))for(const r of rows(name)){const key=name==="availability.jsonl"?"status":name==="valuations.jsonl"?"valuation_status":"margin_status";if(!allowed.has(String(r[key])))errors.push(`${name} has unknown ${key}: ${String(r[key])}.`)}
 for(const r of rows("margin_scenarios.jsonl")){const codes=Array.isArray(r.reason_codes)?r.reason_codes:[];if(r.margin_status==="available"&&codes.length)errors.push("margin_scenarios.jsonl available row has reason codes.");if(r.margin_status==="unavailable"&&!codes.length)errors.push("margin_scenarios.jsonl unavailable row has no canonical reason code.");}
 const reason=/^[a-z0-9][a-z0-9_-]*$/;for(const [name,table] of parsed)for(const r of table)for(const key of ["entry_reason_codes","reason_codes","unavailable_reason_codes","missing_field_codes"])if(Array.isArray(r[key]))for(const code of r[key] as JsonValue[])if(typeof code!=="string"||!reason.test(code)||!RESEARCH_REASON_CODE_SET.has(code))errors.push(`${name} ${key} has unknown reason code ${String(code)}.`);
 // ---------------------------------------------------------------------------
 // Final integrity rules. These extend the existing validator rather than
 // standing beside it, so there is exactly one place a bundle is judged.
 // ---------------------------------------------------------------------------
 const economicsByCandidate=new Map(rows("structure_economics.jsonl").map(r=>[String(r.candidate_id),r]));
 const nearlyEqual=(a:number,b:number)=>Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
 for(const r of rows("structure_economics.jsonl")){
  const id=String(r.candidate_id);
  // Requested-vs-actual provenance and the actual horizon must survive export.
  for(const key of ["requested_short_strike","requested_long_strike","requested_width","actual_short_strike","actual_long_strike","actual_width","width_substituted","expiry_timestamp_utc","reference_entry_timestamp_utc","actual_dte_hours","actual_dte_days"])
   if(!(key in r))errors.push(`Structure economics ${id} is missing ${key}.`);
  const units=obj(r.maximum_structural_loss_units as JsonValue);
  if(units.sign_convention!=="positive_magnitude")errors.push(`Structure economics ${id} does not state the canonical maximum-loss sign convention.`);
  if(r.maximum_structural_loss_status==="available"){
   const usd=num(r.maximum_structural_loss_usd),native=num(r.maximum_structural_loss_native),index=num(r.maximum_structural_loss_reference_index);
   if(usd===null||usd<0)errors.push(`Structure economics ${id} reports an available maximum loss that is not a positive USD magnitude.`);
   if(index===null||index<=0)errors.push(`Structure economics ${id} states no positive reference index for its BTC maximum loss.`);
   if(usd!==null&&index!==null&&index>0&&native!==null&&!nearlyEqual(native,usd/index))errors.push(`Structure economics ${id} BTC maximum loss is not the USD loss converted at the stated reference index.`);
   if(!r.maximum_structural_loss_method||!r.maximum_structural_loss_method_version)errors.push(`Structure economics ${id} does not name its maximum-loss method and version.`);
  }else if(r.maximum_structural_loss_unavailable_reason==null)errors.push(`Structure economics ${id} has no maximum loss and no reason.`);
  // The protective long's premium plus fees is an economic cost, never an
  // account requirement; nothing in this table may be labelled as margin.
  for(const key of Object.keys(r))if(/margin|required_balance/i.test(key))errors.push(`Structure economics ${id} names a capital requirement (${key}); margin belongs in margin_scenarios.jsonl.`);
 }
 // One canonical maximum-loss calculation: the two economic tables must agree.
 for(const m of rows("margin_scenarios.jsonl")){
  const economics=economicsByCandidate.get(String(m.candidate_id));if(!economics)continue;
  const marginUsd=num(m.maximum_structural_loss_usd),economicsUsd=num(economics.maximum_structural_loss_usd);
  if(marginUsd!==null&&economicsUsd!==null&&!nearlyEqual(marginUsd,economicsUsd))errors.push(`${String(m.candidate_id)} reports different maximum structural losses in structure_economics (${economicsUsd}) and margin_scenarios (${marginUsd}).`);
  const marginNative=num(m.maximum_structural_loss_native),economicsNative=num(economics.maximum_structural_loss_native);
  if(marginNative!==null&&economicsNative!==null&&!nearlyEqual(marginNative,economicsNative))errors.push(`${String(m.candidate_id)} reports different BTC maximum-loss representations across the two economic tables.`);
  const marginIndex=num(m.reference_index),economicsIndex=num(economics.maximum_structural_loss_reference_index);
  if(marginIndex!==null&&economicsIndex!==null&&!nearlyEqual(marginIndex,economicsIndex))errors.push(`${String(m.candidate_id)} states different maximum-loss reference indices across the two economic tables.`);
 }
 // Every selected structure has a margin scenario, available or explicitly not.
 const marginCandidates=new Set(rows("margin_scenarios.jsonl").map(r=>String(r.candidate_id)));
 for(const id of candidateIds)if(!marginCandidates.has(String(id)))errors.push(`Selected candidate ${String(id)} has no margin scenario row.`);
 // --- analytics tracks: rows must reflect what the producing engine persisted ---
 const trackRows=new Map<string,Row>();
 for(const r of rows("structure_economics.jsonl"))for(const t of (Array.isArray(r.tracks)?r.tracks:[]))trackRows.set(`${String(r.candidate_id)}~${String(obj(t as JsonValue).track)}`,obj(t as JsonValue));
 const countBy=(name:string)=>{const counts=new Map<string,number>();for(const r of rows(name)){const key=`${String(r.candidate_id)}~${String(r.analytics_track)}`;counts.set(key,(counts.get(key)??0)+1)}return counts};
 const valuationCounts=countBy("valuations.jsonl"),outcomeCounts=countBy("outcomes.jsonl");
 const pricedValuationCounts=new Map<string,number>();
 for(const r of rows("valuations.jsonl"))if(r.valuation_status==="priced"){const key=`${String(r.candidate_id)}~${String(r.analytics_track)}`;pricedValuationCounts.set(key,(pricedValuationCounts.get(key)??0)+1)}
 for(const [key,t] of trackRows){
  const valued=t.status==="valued"||t.status==="evaluated";
  if(valued&&Number(t.source_valuation_point_count??0)>0&&!(valuationCounts.get(key)??0))errors.push(`${key} persisted ${String(t.source_valuation_point_count)} valuation points but exported none.`);
  // For a DELAYED track, "available" must mean a usable economic path and never
  // merely delayed opening evidence. Reference and modeled availability
  // semantics are deliberately not redefined here.
  if(t.status==="available"&&String(t.track).startsWith("delayed_")&&!pricedValuationCounts.get(key))errors.push(`${key} is available but every exported valuation row is unavailable; entry-only delayed evidence must not be reported as a complete economic track.`);
  if(t.status==="available"&&t.path_status!=="available")errors.push(`${key} is available while its path_status is ${String(t.path_status)}.`);
  // Honest absence is allowed: a track whose engine produced no outcome
  // snapshots exports none. Only a DROP of existing snapshots is an error.
  // Only snapshots whose canonical policy is INSIDE the exported contract can
  // be dropped; a recognised-but-unexported marker is not a missing row.
  const exportable=(Array.isArray(t.source_outcomes)?t.source_outcomes:[]).filter(raw=>{const o=obj(raw as JsonValue);
   return o.outcome!=null&&!(OUTCOMES_OUTSIDE_EXPORT_CONTRACT as readonly string[]).includes(String(o.outcome))}).length;
  if(exportable>0&&!(outcomeCounts.get(key)??0))errors.push(`${key} persisted ${exportable} exportable outcome snapshots but exported none.`);
 }
 // --- source-to-export outcome fidelity ---
 // Not merely "some rows exist": every persisted source snapshot is resolved to
 // its canonical policy and compared against the row that claims to carry it.
 const outcomeRows=new Map<string,Row>();
 for(const r of [...rows("outcomes.jsonl")])outcomeRows.set(`${String(r.candidate_id)}~${String(r.analytics_track)}~${String(r.outcome_type)}`,r);
 for(const [key,descriptor] of trackRows){
  for(const raw of (Array.isArray(descriptor.source_outcomes)?descriptor.source_outcomes:[])){
   const source=obj(raw as JsonValue),outcome=source.outcome;
   if(outcome==null){errors.push(`${key} persisted outcome label ${JSON.stringify(source.source_label)} that no canonical policy maps to.`);continue}
   // Recognised but deliberately outside the exported contract: not a drop.
   if((OUTCOMES_OUTSIDE_EXPORT_CONTRACT as readonly string[]).includes(String(outcome)))continue;
   const exported=outcomeRows.get(`${key}~${String(outcome)}`);
   if(!exported){errors.push(`${key} persisted a ${String(outcome)} outcome that the exporter dropped.`);continue}
   if(exported.source_status!==source.source_status)errors.push(`${key} ${String(outcome)} exported source_status ${String(exported.source_status)} but the snapshot says ${String(source.source_status)}.`);
   // An evaluated source snapshot must never be exported as unavailable.
   if(source.source_status==="estimated"&&exported.status!=="evaluated"&&exported.trigger_status==="reached")
    errors.push(`${key} ${String(outcome)} was evaluated in the source but exported as ${String(exported.status)}.`);
   for(const [sourceKey,exportKey] of [["decision_timestamp_utc","outcome_target_timestamp_utc"],["valuation_timestamp_utc","valuation_timestamp_utc"]] as const){
    if(source[sourceKey]!=null&&exported[exportKey]!=null&&source[sourceKey]!==exported[exportKey])
     errors.push(`${key} ${String(outcome)} ${exportKey} is ${String(exported[exportKey])} but the snapshot says ${String(source[sourceKey])}.`);
   }
   const sourcePnl=num(source.pnl_native),exportedPnl=num(exported.net_pnl_native)??num(exported.raw_net_pnl_native)??num(exported.iv_normalized_net_pnl_native);
   if(source.source_status==="estimated"&&sourcePnl!==null&&exportedPnl!==null&&Math.abs(sourcePnl-exportedPnl)>1e-12)
    errors.push(`${key} ${String(outcome)} exported PnL ${exportedPnl} but the snapshot says ${sourcePnl}.`);
  }
 }
 // Holding time is measured from the track's own entry and can never be
 // negative, and an unreached outcome has none.
 for(const r of rows("outcomes.jsonl")){
  const holding=num(r.holding_hours);
  if(holding===null){if(r.status==="evaluated"&&r.valuation_timestamp_utc!=null)errors.push(`${String(r.candidate_id)} ${String(r.outcome_type)} is evaluated at a known valuation timestamp but reports no holding time.`);continue}
  if(holding<0)errors.push(`${String(r.candidate_id)} ${String(r.outcome_type)} reports a negative holding time.`);
  if(r.status!=="evaluated")errors.push(`${String(r.candidate_id)} ${String(r.outcome_type)} is ${String(r.status)} but reports a holding time.`);
  const descriptor=trackRows.get(`${String(r.candidate_id)}~${String(r.analytics_track)}`);
  const entry=Date.parse(String(descriptor?.entry_timestamp_utc)),close=Date.parse(String(r.valuation_timestamp_utc??r.outcome_target_timestamp_utc));
  if(Number.isFinite(entry)&&Number.isFinite(close)&&Math.abs(holding-(close-entry)/36e5)>1e-6)
   errors.push(`${String(r.candidate_id)} ${String(r.outcome_type)} holding time is not measured from that track's own entry.`);
  const expiry=Date.parse(String(economicsByCandidate.get(String(r.candidate_id))?.expiry_timestamp_utc));
  if(Number.isFinite(expiry)&&Number.isFinite(close)&&close>expiry)errors.push(`${String(r.candidate_id)} ${String(r.outcome_type)} reports a holding time past expiry.`);
 }
 // An outcome row may state "this labelled outcome was not reached" without a
 // snapshot, but it can never claim an EVALUATED result the engine never produced.
 for(const r of rows("outcomes.jsonl")){
  const key=`${String(r.candidate_id)}~${String(r.analytics_track)}`,descriptor=trackRows.get(key);
  if(r.status==="evaluated"&&descriptor&&Number(descriptor.source_outcome_snapshot_count??0)===0)errors.push(`${key} exports an evaluated ${String(r.outcome_type)} outcome that no persisted snapshot supports.`);
 }
 const seenValuation=new Set<string>();
 for(const r of rows("valuations.jsonl")){
  const track=String(r.analytics_track),key=`${String(r.candidate_id)}~${track}`,descriptor=trackRows.get(key);
  if(!descriptor){errors.push(`Valuation row references undeclared analytics track ${track} for ${String(r.candidate_id)}.`);continue}
  const identity=`${key}~${String(r.timestamp_utc)}~${String(r.pricing_track??"single")}`;
  if(seenValuation.has(identity))errors.push(`Duplicate valuation row for ${identity}.`);else seenValuation.add(identity);
  const at=Date.parse(String(r.timestamp_utc)),entry=Date.parse(String(descriptor.entry_timestamp_utc));
  const expiry=Date.parse(String(economicsByCandidate.get(String(r.candidate_id))?.expiry_timestamp_utc));
  if(Number.isFinite(at)&&Number.isFinite(entry)&&at<entry)errors.push(`${key} has a valuation at ${String(r.timestamp_utc)} before that track's own entry ${String(descriptor.entry_timestamp_utc)}.`);
  if(Number.isFinite(at)&&Number.isFinite(expiry)&&at>expiry)errors.push(`${key} has a valuation at ${String(r.timestamp_utc)} after expiry.`);
 }
 // A delayed track is never backdated onto the reference entry.
 for(const r of rows("structure_economics.jsonl")){
  const reference=Date.parse(String(obj(trackRows.get(`${String(r.candidate_id)}~reference_fair_value`)??{}).entry_timestamp_utc));
  for(const track of ["delayed_maker","delayed_taker"]){
   const descriptor=trackRows.get(`${String(r.candidate_id)}~${track}`);if(!descriptor)continue;
   const entry=Date.parse(String(descriptor.entry_timestamp_utc));
   if(Number.isFinite(entry)&&Number.isFinite(reference)&&entry<reference)errors.push(`${String(r.candidate_id)} ${track} opens before the reference entry; a delayed fill is never backdated.`);
  }
 }
 // Per-leg IV survives with its own units and observation status or not at all.
 for(const r of rows("valuations.jsonl"))for(const leg of ["short_leg_volatility","long_leg_volatility"]){
  const volatility=obj(r[leg] as JsonValue);if(!Object.keys(volatility).length)continue;
  if(volatility.iv_decimal!=null&&(volatility.iv_units==null||volatility.observation==null))errors.push(`${String(r.candidate_id)} ${leg} carries an IV without its units and observation status.`);
 }
 // --- per event ---
 for(const r of rows("events.jsonl")){
  const unresolved=r.sequence_status==="unresolved";
  if(unresolved!==(r.censoring_status==="right_censored"))errors.push(`Event ${String(r.event_id)} censoring status contradicts its sequence status.`);
 }
 const futuresPathByComparison=new Map<string,number>();
 for(const r of rows("futures_path.jsonl"))futuresPathByComparison.set(String(r.comparison_id),(futuresPathByComparison.get(String(r.comparison_id))??0)+1);
 for(const r of rows("futures_comparisons.jsonl")){
  if(!eventIds.has(r.event_id))errors.push(`Futures comparison ${String(r.comparison_id)} has a broken event foreign key.`);
  const endpoints=Array.isArray(r.endpoints)?r.endpoints.map(x=>obj(x as JsonValue)):[];
  const anyEndpointAvailable=endpoints.some(e=>e.status==="available");
  // One unavailable policy endpoint never erases the rest of the benchmark.
  if(anyEndpointAvailable&&r.availability!=="available")errors.push(`Futures comparison ${String(r.comparison_id)} discards an observable benchmark because one endpoint is unavailable.`);
  if(r.availability==="available"&&!(futuresPathByComparison.get(String(r.comparison_id))??0))errors.push(`Futures comparison ${String(r.comparison_id)} is available but exported no causal path.`);
  for(const endpoint of endpoints)if(endpoint.status!=="available"&&endpoint.reason_code==null)errors.push(`Futures comparison ${String(r.comparison_id)} has an unavailable ${String(endpoint.policy)} endpoint with no reason code.`);
 }
 for(const r of rows("futures_path.jsonl"))if(!eventIds.has(r.event_id))errors.push(`Futures path row has a broken event foreign key: ${String(r.event_id)}.`);
 // --- run level ---
 const configurationHashes=new Set((Array.isArray(run.source_runs)?run.source_runs:[]).map(x=>obj(x as JsonValue).effective_configuration_hash).filter(x=>x!=null));
 if(configurationHashes.size>1)errors.push(`Aggregate run mixes ${configurationHashes.size} research methodologies: ${[...configurationHashes].join(", ")}.`);
 if(configurationHashes.size===1&&run.effective_configuration_hash!==[...configurationHashes][0])errors.push("run.json effective_configuration_hash disagrees with its source runs.");
 const builds=(Array.isArray(run.source_runs)?run.source_runs:[]).map(x=>obj(x as JsonValue).application_build);
 const expectedBuildStatus=builds.length>0&&builds.every(b=>typeof b==="string"&&b.trim()!==""&&b!=="unavailable:no-build-metadata")?"available":"unavailable";
 if(run.build_provenance_status!==expectedBuildStatus)errors.push(`run.json build_provenance_status is ${String(run.build_provenance_status)} but its source runs are ${expectedBuildStatus}.`);
 const datasetCount=num(run.trade_dataset_mr_event_count);
 if(datasetCount!==null&&datasetCount<Number(run.persisted_research_event_count??0))errors.push(`The active dataset reports ${datasetCount} MR events, fewer than the ${String(run.persisted_research_event_count)} persisted research events.`);
 if(datasetCount===null&&run.trade_dataset_mr_event_count_source!=="unavailable")errors.push("run.json claims a dataset denominator source without a denominator.");
 // The manifest is derived from actual output in BOTH directions: usable rows
 // can never read as unavailable, and no usable rows can never read as available.
 const availabilityChecks:Array<[string,boolean]>=[
  ["underlying_path",rows("underlying_path.jsonl").length>0],
  ["structure_economics",rows("structure_economics.jsonl").some(r=>r.maximum_structural_loss_status==="available")],
  ["candidates",rows("candidates.jsonl").length>0],
  ["availability",rows("availability.jsonl").length>0],
  ["valuations",rows("valuations.jsonl").some(r=>r.valuation_status==="priced")],
  ["outcomes",rows("outcomes.jsonl").some(r=>r.status==="evaluated")],
  ["margin_scenarios",rows("margin_scenarios.jsonl").some(r=>r.margin_status==="available")],
  ["evidence_trades",rows("evidence_trades.jsonl").length>0],
  ["futures_comparisons",rows("futures_comparisons.jsonl").some(r=>r.availability==="available")],
  ["futures_path",rows("futures_path.jsonl").length>0],
 ];
 const manifest=obj(run.table_availability as JsonValue);
 for(const [table,usable] of availabilityChecks){
  const stated=manifest[table];
  if(stated===undefined)errors.push(`run.json does not state availability for ${table}.`);
  else if(usable&&stated!=="available")errors.push(`${table} has usable rows but the manifest says ${String(stated)}.`);
  else if(!usable&&stated==="available")errors.push(`${table} has no usable rows but the manifest says available.`);
 }
 // Completeness is checked per (candidate_id, execution_scenario): an
 // evaluated scenario must have both pricing tracks and every required
 // outcome; a genuinely not_evaluated scenario correctly has zero rows here
 // and must NOT be flagged as incomplete.
 for(const c of rows("candidates.jsonl")){
  if(c.execution_scenario_status!=="evaluated")continue;
  const id=c.candidate_id,scenario=c.execution_scenario;
  const tracks=new Set(rows("valuations.jsonl").filter(r=>r.candidate_id===id&&r.execution_scenario===scenario).map(r=>r.pricing_track));
  if(!tracks.has("raw_vwap")||!tracks.has("iv_normalized"))errors.push(`Candidate ${String(id)} (${String(scenario)}) is missing required pricing tracks.`);
  const kinds=new Set(rows("outcomes.jsonl").filter(r=>r.candidate_id===id&&r.execution_scenario===scenario).map(r=>r.outcome_type));
  for(const kind of REQUIRED_OUTCOMES)if(!kinds.has(kind))errors.push(`Candidate ${String(id)} (${String(scenario)}) is missing required outcome ${kind}.`);
 }
 // Candidate retention is structural, not synonymous with immediate fill
 // evidence. Reference valuation is an independent economic track, but its
 // contents must pass the canonical audit before it can qualify a structure.
 const eventEntryTimes=new Map(rows("events.jsonl").map(e=>[e.event_id,Date.parse(String(e.entry_timestamp_utc??e.signal_timestamp_utc))]));
 for(const id of candidateIds){
  const scenarios=rows("candidates.jsonl").filter(r=>r.candidate_id===id);
  const base=scenarios[0]??{},audit=assessCandidateAnalyticalTracks({referenceValuation:base.reference_valuation,executionScenarios:Object.fromEntries(scenarios.map(r=>[String(r.execution_scenario),{status:r.execution_scenario_status}])),contractResolution:base.contract_resolution,candidateSnapshot:{expiryTimestamp:Date.parse(String(base.expiry_timestamp_utc))},quantity:base.quantity,eventEntryTimestamp:eventEntryTimes.get(base.event_id)});
  if(!audit.admissible)errors.push(`Candidate ${String(id)} has no valid analytical track.${audit.referenceErrors.length?` Reference valuation: ${audit.referenceErrors.join("; ")}.`:""}`);
 }
 const close=(a:number,b:number)=>Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b));for(const c of rows("candidates.jsonl")){const legs=obj(c.entry_legs),short=num(obj(legs.short).price_native),long=num(obj(legs.long).price_native),qty=num(c.quantity),fees=num(c.opening_fees_native),gross=num(c.gross_credit_debit_native),net=num(c.net_opening_cash_flow_native);if(short!==null&&long!==null&&qty!==null&&gross!==null&&!close(gross,(short-long)*qty))errors.push(`Candidate ${String(c.candidate_id)} has unreconciled opening gross.`);if(gross!==null&&fees!==null&&net!==null&&!close(net,gross-fees))errors.push(`Candidate ${String(c.candidate_id)} has unreconciled opening total.`)}for(const v of rows("valuations.jsonl")){const pnl=num(v.net_pnl_native),index=num(v.target_underlying_index),usd=num(v.net_pnl_usd);if(pnl!==null&&index!==null&&usd!==null&&!close(usd,pnl*index))errors.push(`Valuation ${String(v.valuation_id)} has unreconciled USD PnL.`)}
 // ---------------------------------------------------------------------------
 // Volatility state (schema 3.7.0).
 //
 // These tables exist to carry MARKET evidence, so the validator's job is to
 // make three failures impossible to serialize: a metric that reports 0 or a
 // stale carry-forward instead of admitting it is missing; a derived quantity
 // standing on an unavailable endpoint; and a model-produced volatility
 // reaching a market-evidence consumer.
 // ---------------------------------------------------------------------------
 const volatilityMethodVersions=new Set<string>();
 const eventVolatilityRows=rows("event_volatility_state.jsonl");
 const structureVolatilityRows=rows("structure_volatility_state.jsonl");
 const arr=(v:JsonValue):Record<string,JsonValue>[]=>Array.isArray(v)?v.map(x=>obj(x)):[];
 /** A metric that is not available must be null. Never 0, never a stale value. */
 const nullWhenUnavailable=(entry:Record<string,JsonValue>,valueKeys:readonly string[],context:string)=>{
  if(entry.status!=="available"&&entry.status!=="unavailable"){errors.push(`${context} has unknown status: ${String(entry.status)}.`);return}
  if(entry.status==="available"){
   if(!entry.unavailable_reason&&!entry.unavailable_reason_code)return;
   errors.push(`${context} is available but carries an unavailable reason.`);return;
  }
  for(const key of valueKeys)if(entry[key]!==null&&entry[key]!==undefined)
   errors.push(`${context} is unavailable but still reports ${key}=${String(entry[key])}; a missing metric must be null.`);
 };
 const seriesIdentity=(r:Row,context:string)=>{
  if(typeof r.reference_series_id!=="string"||!r.reference_series_id)errors.push(`${context} has no reference_series_id.`);
  if(typeof r.reference_series_content_hash!=="string"||!r.reference_series_content_hash)errors.push(`${context} has no reference_series_content_hash.`);
  if(typeof r.method_version==="string")volatilityMethodVersions.add(r.method_version);else errors.push(`${context} has no method_version.`);
 };

 const eventVolatilityIds=ids("event_volatility_state.jsonl","event_id");
 for(const id of eventVolatilityIds)if(!eventIds.has(id))errors.push(`Event volatility state ${String(id)} has a broken event foreign key.`);
 // A partially populated table would read as full coverage downstream. Either
 // the pipeline ran for every event or the table is absent.
 if(eventVolatilityRows.length)for(const id of eventIds)if(!eventVolatilityIds.has(id))
  errors.push(`Event ${String(id)} has no volatility state, but the table is populated; partial coverage is not exportable.`);
 for(const r of eventVolatilityRows){
  const context=`Event volatility state ${String(r.event_id)}`;
  seriesIdentity(r,context);
  if(r.method_version!==EVENT_VOLATILITY_STATE_METHOD_VERSION)errors.push(`${context} has an unexpected method version ${String(r.method_version)}.`);
  const tenors=arr(r.reference_iv),byTenor=new Map(tenors.map(t=>[String(t.nominal_tenor),t]));
  for(const nominal of ["7d","14d","30d"])if(!byTenor.has(nominal))errors.push(`${context} omits the ${nominal} reference tenor.`);
  for(const t of tenors){
   const tenorContext=`${context} tenor ${String(t.nominal_tenor)}`;
   nullWhenUnavailable(t,["iv_decimal","iv_units"],tenorContext);
   // An out-of-tolerance or stale observation may never be reported available:
   // a 39-day expiry is not a 30-day reference, however real its print was.
   if(t.status==="available"&&t.tenor_tolerance_passed!==true)errors.push(`${tenorContext} is available with a failed tenor tolerance.`);
   if(t.status==="available"&&t.passes_market_state_rule!==true)errors.push(`${tenorContext} is available without passing the market-state rule.`);
   if(t.status==="available"&&t.observation_class==="unavailable")errors.push(`${tenorContext} is available with no observation class.`);
  }
  for(const slope of arr(r.term_structure)){
   const slopeContext=`${context} ${String(slope.slope)}`;
   nullWhenUnavailable(slope,["value_per_day"],slopeContext);
   const from=byTenor.get(String(slope.from_tenor)),to=byTenor.get(String(slope.to_tenor));
   // The decisive rule: a slope is a statement about two independently
   // available endpoints, not an extrapolation from the one that survived.
   if(slope.status==="available"&&(from?.status!=="available"||to?.status!=="available"))
    errors.push(`${slopeContext} is available while an endpoint tenor is not.`);
  }
  const horizons=new Set<string>();
  for(const rv of arr(r.realized_volatility)){
   const rvContext=`${context} RV ${String(rv.horizon)}`;
   horizons.add(String(rv.horizon));
   nullWhenUnavailable(rv,["rv_decimal"],rvContext);
   const coverage=num(rv.coverage_ratio);
   if(coverage!==null&&(coverage<0||coverage>1))errors.push(`${rvContext} has a coverage ratio outside [0,1]: ${coverage}.`);
   if(rv.status==="available"&&num(rv.annualization_factor)!==8760)errors.push(`${rvContext} is available with a non-canonical annualization factor.`);
  }
  for(const horizon of ["1d","3d","7d","14d","30d"])if(!horizons.has(horizon))errors.push(`${context} omits the ${horizon} realized-volatility horizon.`);
  for(const p of arr(r.reference_iv_percentile)){
   const percentileContext=`${context} percentile ${String(p.nominal_tenor)}`;
   nullWhenUnavailable(p,["percentile"],percentileContext);
   const value=num(p.percentile);
   if(value!==null&&(value<0||value>1))errors.push(`${percentileContext} is outside [0,1]: ${value}.`);
   const prior=num(p.prior_observation_count),minimum=num(p.minimum_prior_observations);
   if(p.status==="available"&&prior!==null&&minimum!==null&&prior<minimum)
    errors.push(`${percentileContext} is available on ${prior} prior observations, below the ${minimum} minimum.`);
   if(p.other_tenor_observations_excluded===undefined)errors.push(`${percentileContext} does not record how many other-tenor observations it excluded.`);
  }
  for(const d of arr(r.iv_minus_rv))nullWhenUnavailable(d,["value"],`${context} iv_minus_rv ${String(d.nominal_tenor)}/${String(d.horizon)}`);
  // DVOL is broad context. It can never fill a same-expiry reference, so the
  // serialized row states that permanently rather than relying on a convention.
  const broad=obj(r.broad_volatility_index);
  if(broad.substitution_permitted!==false)errors.push(`${context} broad volatility index does not refuse substitution.`);
  nullWhenUnavailable(broad,["value_decimal"],`${context} broad volatility index`);
 }

 const structureVolatilityIds=ids("structure_volatility_state.jsonl","candidate_id");
 for(const id of structureVolatilityIds)if(!candidateIds.has(id))errors.push(`Structure volatility state ${String(id)} has a broken candidate foreign key.`);
 if(structureVolatilityRows.length)for(const id of candidateIds)if(!structureVolatilityIds.has(id))
  errors.push(`Candidate ${String(id)} has no volatility state, but the table is populated; partial coverage is not exportable.`);
 for(const r of structureVolatilityRows){
  const context=`Structure volatility state ${String(r.candidate_id)}`;
  seriesIdentity(r,context);
  if(r.method_version!==STRUCTURE_VOLATILITY_STATE_METHOD_VERSION)errors.push(`${context} has an unexpected method version ${String(r.method_version)}.`);
  if(!eventIds.has(r.event_id))errors.push(`${context} has a broken event foreign key.`);
  // A vertical has no single implied volatility. The contract says so.
  if(r.synthesized_spread_iv!==null)errors.push(`${context} reports a synthesized spread IV, which does not exist for a vertical.`);
  const legs=arr(r.legs),named=new Set(legs.map(l=>String(l.leg)));
  for(const leg of ["short","long"])if(!named.has(leg))errors.push(`${context} omits its ${leg} leg volatility.`);
  for(const leg of legs){
   const legContext=`${context} ${String(leg.leg)} leg`;
   nullWhenUnavailable(leg,["iv_decimal","iv_api_percentage","iv_units"],legContext);
   // The circularity rule, enforced at the serialized contract: only a real
   // market observation may be reported as available market evidence.
   if(leg.status==="available"&&leg.observation!=="observed")
    errors.push(`${legContext} is available on observation "${String(leg.observation)}", which is a pricing state rather than market evidence.`);
   if(leg.status==="available"&&leg.passes_market_state_rule!==true)
    errors.push(`${legContext} is available without passing the market-state rule.`);
  }
  const reference=obj(r.same_expiry_reference);
  nullWhenUnavailable(reference,["iv_decimal"],`${context} same-expiry reference`);
  if(reference.status==="available"&&reference.passes_market_state_rule!==true)
   errors.push(`${context} same-expiry reference is available without passing the market-state rule.`);
  const legByName=new Map(legs.map(l=>[String(l.leg),l]));
  for(const d of arr(r.differentials)){
   const kind=String(d.differential),differentialContext=`${context} ${kind}`;
   nullWhenUnavailable(d,["value"],differentialContext);
   if(d.status!=="available")continue;
   const against=kind==="short_minus_reference_iv"?["short"]:kind==="long_minus_reference_iv"?["long"]:["short","long"];
   for(const leg of against)if(legByName.get(leg)?.status!=="available")
    errors.push(`${differentialContext} is available while its ${leg} leg is not.`);
   if(kind!=="short_minus_long_iv"){
    if(reference.status!=="available")errors.push(`${differentialContext} is available while its reference is not.`);
    // Differencing a leg against a reference that included that same leg
    // measures the structure against itself.
    if(reference.excluded_own_legs!==true)errors.push(`${differentialContext} is available against a reference that did not exclude the structure's own legs.`);
   }
  }
 }
 void volatilityMethodVersions;
 return{ok:!errors.length,errors};
}
