import { assessCandidateAnalyticalTracks, canonicalJson, migrateResearchSelectionStore, type JsonValue } from "./research-selections.ts";
import { reconcileCandidateSpread } from "./semantic-spread.ts";
import { buildEventFuturesBaseline, FUTURES_ENGINE_VERSION } from "./futures-baseline.ts";
import { canonicalMarginReason } from "./research-margin.ts";
import { CANONICAL_TRACKS, describeCanonicalTracks, legVolatility } from "./research-tracks.ts";
import { breakEven, payoffExtrema, type ExpiryPayoffInput } from "./expiry-payoff.ts";

export const RESEARCH_BUNDLE_SCHEMA_VERSION="3.3.0" as const;
/** Bundle schema versions this app can still import (see importResearchBundle). */
export const LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS=["1.0.0","2.0.0","2.1.0","2.2.0","2.3.0","3.0.0","3.1.0","3.2.0"] as const;
export const RESEARCH_BUNDLE_FILES=["run.json","events.jsonl","underlying_path.jsonl","structure_economics.jsonl","candidates.jsonl","valuations.jsonl","outcomes.jsonl","availability.jsonl","margin_scenarios.jsonl","evidence_trades.jsonl","futures_comparisons.jsonl","futures_path.jsonl"] as const;
export const REQUIRED_OUTCOMES=["vpoc","invalidation","credit_capture_25","credit_capture_50","credit_capture_70","fixed_3d","fixed_5d","fixed_7d","settlement"] as const;
export const RESEARCH_REASON_CODES=["entry_priced","entry_unavailable","direct_vwap","model_reconstructed","quality_green","quality_yellow","quality_red","quality_unavailable","valuation_priced","pricing_track_unavailable","outside_executable_window","raw_source_evidence","executable_evidence","missing_target_index","missing_pricing_track","outcome_priced","outcome_not_reached","outcome_after_expiry","outcome_ambiguous_sequence","outcome_reached_but_unpriced","candidate_priced","candidate_unavailable","verified_historical_margin_model_unavailable","margin_no_canonical_valuation_path","margin_missing_index","margin_missing_short_mark","margin_missing_long_mark","margin_historical_rule_unverified","margin_deployment_unsupported","margin_not_recomputed","futures_instrument_unavailable","unsupported_futures_instrument","futures_reference_series_unavailable","matched_endpoint_unavailable","observed_futures_execution_unavailable","funding_unavailable","futures_margin_unavailable"] as const;
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
const outcomeKey=(label:string)=>label.toLowerCase().replace(/%/g,"").replace(/\s+/g,"_").replace(/^50_credit$/,"credit_capture_50").replace(/^70_credit$/,"credit_capture_70").replace(/^25_credit$/,"credit_capture_25");
const triggerStatus=(snapshot:Row|undefined)=>{if(!snapshot)return "unavailable";if(snapshot.status==="not-hit")return "not_reached";if(snapshot.evidenceReason==="Target occurs after contract expiry.")return "after_expiry";if(snapshot.trigger==="ambiguous")return "ambiguous";return snapshot.decisionTimestamp==null?"unavailable":"reached"};
const qualityCode=(quality:JsonValue):ResearchReasonCode=>quality==="green"?"quality_green":quality==="yellow"?"quality_yellow":quality==="red"?"quality_red":"quality_unavailable";
const missingFieldCode=(field:JsonValue):ResearchReasonCode=>field==="targetIndex"?"missing_target_index":"missing_pricing_track";

export function summarizeResearchBundleErrors(errors:readonly string[],limit=3){const counts=new Map<string,number>();for(const error of errors)counts.set(error,(counts.get(error)??0)+1);const unique=[...counts].map(([message,count])=>({message,count}));const shown=unique.slice(0,limit).map(({message,count})=>`${message}${count>1?` (${count} rows)`:""}`);return{summary:`Research bundle validation failed: ${shown.join(" ")}${unique.length>limit?` ${unique.length-limit} more unique errors.`:""}`,unique,total:errors.length};}

export function buildResearchBundle(value:unknown,generatedAtUtc=new Date().toISOString(),datasetUpdatedAt?:string):ResearchBundle{
 // migrateResearchSelectionStore validates AND normalizes any known schema
 // version (including legacy ones) to the current SelectedStructure shape, so
 // buildResearchBundle never has to special-case an old, pre-scenario store.
 let store;try{store=migrateResearchSelectionStore(value)}catch(e){throw new Error(`Invalid persisted research selections: ${e instanceof Error?e.message:String(e)}`)}
 const selected=store.events.flatMap(e=>e.selectedStructures.map(s=>({e,s}))).sort((a,b)=>a.s.candidateId.localeCompare(b.s.candidateId));
 const runId=`bundle~${store.datasetId}~${generatedAtUtc.replace(/\D/g,"")}`;
 const sourceIds=new Map(store.events.map(e=>[e.eventId,`${e.selectedStructures[0]?.venue??"deribit"}~source~${hash(e.generationSnapshot.configuration)}`]));
 const events:Row[]=store.events.sort((a,b)=>a.eventId.localeCompare(b.eventId)).map(e=>{const source=obj(e.sourceRun),event=obj(source.event??source),entry=num(event.entryTimestamp)??(typeof event.entryDate==="string"?Date.parse(`${event.entryDate}T00:00:00Z`):null),vpoc=num(event.vpocTimestamp),path=e.generationSnapshot.underlyingHourlyPath,level=num(event.invalidationPrice);let invalid:null|number=null;if(entry!==null&&level!==null){const hit=path.find(c=>c.openTime>=entry&&(event.direction==="long"?c.low<=level:c.high>=level));invalid=hit?.closeTime??null}const observationEnd=path.length?Math.max(...path.map(c=>c.closeTime)):entry;const sequence=vpoc!==null&&invalid!==null?(vpoc===invalid?"ambiguous":vpoc<invalid?"vpoc_first":"invalidation_first"):vpoc!==null?"vpoc_first":invalid!==null?"invalidation_first":"unresolved";const venue=e.selectedStructures[0]?.venue??e.generationSnapshot.candidates[0]?.venue??"deribit";return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,venue,signal_timestamp_utc:typeof event.entryDate==="string"?isoMs(Date.parse(`${event.entryDate}T00:00:00Z`),`event ${e.eventId} entryDate`):null,entry_timestamp_utc:isoMs(entry,`event ${e.eventId} entryTimestamp`),entry_decision_available_timestamp_utc:isoMs(entry,`event ${e.eventId} entryTimestamp`),entry_precision:"hourly",direction:event.direction??null,entry_price:event.entryPrice??null,extreme_price:event.extremePrice??null,vpoc_price:event.vpocPrice??null,invalidation_price:level,range_low:event.rangeLow??null,range_high:event.rangeHigh??null,vpoc_trigger_timestamp_utc:iso(vpoc),vpoc_decision_timestamp_utc:iso(vpoc===null?null:vpoc+36e5),invalidation_trigger_timestamp_utc:iso(invalid===null?null:invalid-36e5),invalidation_decision_timestamp_utc:iso(invalid),observation_end_timestamp_utc:isoMs(observationEnd,`event ${e.eventId} observation end`),censoring_status:sequence==="unresolved"?"right_censored":"resolved",sequence_status:sequence,exit_timestamp_utc:iso(num(event.exitTimestamp)),exit_price:event.exitPrice??null,duration_hours:entry!==null&&observationEnd!==null?(observationEnd-entry)/36e5:null,vpoc_distance:event.vpocPrice!=null&&event.entryPrice!=null?Number(event.vpocPrice)-Number(event.entryPrice):null,invalidation_distance:level!==null&&event.entryPrice!=null?level-Number(event.entryPrice):null})});
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
  // The exact inverse payoff, or an explicit unavailability -- never width minus credit.
  let maxLoss:{btc:number|null;usd:number|null;breakeven:number|null;reason:string|null}={btc:null,usd:null,breakeven:null,reason:"Reference entry economics are incomplete, so the exact inverse payoff cannot be evaluated."};
  if(optionType&&(optionType==="C"||optionType==="P")&&shortStrike!==null&&longStrike!==null&&shortPremium!==null&&longPremium!==null&&index!==null&&index>0&&quantity!==null&&quantity>0&&feesReference!==null&&feesReference>=0&&expiry!==null){
   const input:ExpiryPayoffInput={optionType,shortStrike,longStrike,shortEntryPremiumBtc:shortPremium,longEntryPremiumBtc:longPremium,entryIndex:index,amount:quantity,openingFeesBtc:feesReference,expiryTimestamp:expiry};
   try{
    const usd=payoffExtrema(input,"usd-cash-flow"),btc=payoffExtrema(input,"btc-settlement"),be=breakEven(input,"usd-cash-flow");
    maxLoss={btc:btc.maximumLoss,usd:usd.maximumLoss,breakeven:be?be.index:null,reason:null};
   }catch(error){maxLoss={btc:null,usd:null,breakeven:null,reason:`The canonical strikes and premiums do not form a valid credit spread: ${error instanceof Error?error.message:String(error)}`}}
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
   breakeven_index:maxLoss.breakeven,
   breakeven_method:maxLoss.breakeven===null?null:"numerical bisection over the canonical inverse net payoff",
   maximum_economic_loss_native:maxLoss.btc,maximum_economic_loss_usd:maxLoss.usd,
   maximum_economic_loss_units:{native:"BTC",quote:"USD"},
   maximum_economic_loss_reference_index:index,
   maximum_economic_loss_method:maxLoss.btc===null?null:"exact inverse-option expiry payoff over strike and tail settlement indices, including per-leg delivery fees",
   maximum_economic_loss_assumption:maxLoss.btc===null?null:"USD figures convert the native BTC payoff at the stated reference index; the BTC maximum loss is not unconditional and varies with the settlement index.",
   maximum_economic_loss_unavailable_reason:maxLoss.reason,
   credit_per_actual_width:netReference!==null&&actualWidth!==null&&actualWidth>0&&index!==null?netReference*index/actualWidth:null,
   credit_per_maximum_economic_loss:netReference!==null&&maxLoss.usd!==null&&maxLoss.usd!==0&&index!==null?netReference*index/Math.abs(maxLoss.usd):null,
   // Every contracted track carries an explicit status here, so a consumer can
   // tell "unsupported for this structure, and why" from "absent from the file".
   tracks:describeCanonicalTracks(s as unknown as Record<string,unknown>).map(t=>({
    track:t.track,status:t.status,reason_code:t.reasonCode,reason:t.reason,
    entry_basis:t.entryBasis,entry_timestamp_utc:iso(t.entryTimestampMs),
    valuation_basis:t.valuationBasis,execution_evidence:t.executionEvidence,
    valuation_source:t.valuationSource,engine_version:t.engineVersion,
    execution_scenario:t.executionScenario,provenance:t.provenance,
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
 const outcomes:Row[]=selected.flatMap(({e,s})=>(["maker","taker"] as const).flatMap(mode=>{const scenario=s.executionScenarios[mode];if(scenario.status!=="evaluated"||invalidScenarioKeys.has(`${s.candidateId}~${mode}`))return[];const by=new Map(scenario.outcomeSnapshots.map(o=>[outcomeKey(String(obj(o).label??"")),obj(o)]));const entrySnapshot=obj(scenario.entrySnapshot);return REQUIRED_OUTCOMES.map(kind=>{const o=by.get(kind),trigger=triggerStatus(o),pnl=o?num(o.estimatedNetPnlBtc)??num(o.estimatedNetPnl):null,index=o?num(o.conversionIndex)??num(o.targetIndex):null;const oo=obj(o??null),decision=num(oo.decisionTimestamp),valuation=num(oo.valuationTimestamp),expiry=num(obj(s.candidateSnapshot).expiryTimestamp),entry=num(entrySnapshot.valuationTimestamp)??num(entrySnapshot.targetTimestamp),inWindow=valuation!==null&&entry!==null&&expiry!==null&&valuation>=entry&&valuation<=expiry;return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,execution_scenario:mode,analytics_track:mode==="maker"?"strict_maker":"strict_taker",outcome_id:`${s.venue}~outcome~${hash([s.candidateId,mode,kind])}`,venue:s.venue,outcome_type:kind,status:trigger==="reached"?"evaluated":"unavailable",trigger_status:trigger,outcome_target_timestamp_utc:o?isoMs(decision,`outcome target ${s.candidateId} ${mode}`):null,trigger_timestamp_utc:inWindow?isoMs(decision,`outcome trigger ${s.candidateId} ${mode}`):null,decision_available_timestamp_utc:inWindow?isoMs(decision,`outcome decision ${s.candidateId} ${mode}`):null,valuation_timestamp_utc:inWindow?isoMs(valuation,`outcome valuation ${s.candidateId} ${mode}`):null,window_role:inWindow?"executable_observation":"outside_executable_window",before_expiry:trigger!=="after_expiry",before_invalidation:null,holding_hours:null,raw_status:trigger!=="reached"?"not_applicable":o?.rawEstimate!=null||kind==="settlement"?"priced":"unavailable",iv_normalized_status:trigger!=="reached"?"not_applicable":o?.modelEstimate!=null||kind==="settlement"?"priced":"unavailable",raw_net_pnl_native:o?.rawEstimate!=null||kind==="settlement"?pnl:null,raw_net_pnl_usd:(o?.rawEstimate!=null||kind==="settlement")&&pnl!==null&&index!==null?pnl*index:null,iv_normalized_net_pnl_native:o?.modelEstimate!=null||kind==="settlement"?pnl:null,iv_normalized_net_pnl_usd:(o?.modelEstimate!=null||kind==="settlement")&&pnl!==null&&index!==null?pnl*index:null,net_pnl_native:null,net_pnl_usd:null,closing_fees_native:o?o.feesBtc??null:null,quality:o?.estimateQuality??"unavailable",reason_codes:[trigger==="reached"?(pnl===null?"outcome_reached_but_unpriced":"outcome_priced"):trigger==="not_reached"?"outcome_not_reached":trigger==="after_expiry"?"outcome_after_expiry":"outcome_ambiguous_sequence"],evidence_reason:o?.evidenceReason??null})});}));
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
    entry_basis:t.entryBasis,entry_timestamp_utc:iso(t.entryTimestampMs),valuation_basis:t.valuationBasis,
    execution_evidence:t.executionEvidence,valuation_source:t.valuationSource,
    provenance:t.provenance,engine_version:t.engineVersion};
   for(const [index,point0] of t.valuationPath.entries()){
    const p=obj(point0),timestamp=num(p.timestamp);
    // Causality: never before the track's own entry, never after expiry.
    if(timestamp!==null&&t.entryTimestampMs!==null&&timestamp<t.entryTimestampMs){omittedValuationsBeforeEntry++;continue}
    if(timestamp!==null&&expiry!==null&&timestamp>expiry){omittedValuationsAfterExpiry++;continue}
    const estimate=obj(p.rawEstimate??p.modelEstimate??p.ivNormalizedEstimate??null);
    const short=obj(estimate.sold),long=obj(estimate.bought),target=num(p.targetIndex);
    const pnl=num(p.estimatedNetPnlBtc);
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
   const by=new Map(t.outcomeSnapshots.map(o=>[outcomeKey(String(obj(o).label??"")),obj(o)]));
   for(const kind of REQUIRED_OUTCOMES){
    const o=by.get(kind),trigger=triggerStatus(o);
    const pnl=o?num(o.estimatedNetPnlBtc)??num(o.estimatedNetPnl):null;
    const index=o?num(o.conversionIndex)??num(o.targetIndex):null;
    const oo=obj(o??null),decision=num(oo.decisionTimestamp),valuation=num(oo.valuationTimestamp);
    const inWindow=valuation!==null&&t.entryTimestampMs!==null&&expiry!==null&&valuation>=t.entryTimestampMs&&valuation<=expiry;
    independentOutcomes.push(row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,
     candidate_id:s.candidateId,execution_scenario:t.executionScenario,...trackMeta,
     outcome_id:`${s.venue}~outcome~${hash([s.candidateId,t.track,kind])}`,venue:s.venue,outcome_type:kind,
     status:trigger==="reached"?"evaluated":"unavailable",trigger_status:trigger,
     outcome_target_timestamp_utc:o?isoMs(decision,`outcome target ${s.candidateId} ${t.track}`):null,
     trigger_timestamp_utc:inWindow?isoMs(decision,`outcome trigger ${s.candidateId} ${t.track}`):null,
     decision_available_timestamp_utc:inWindow?isoMs(decision,`outcome decision ${s.candidateId} ${t.track}`):null,
     valuation_timestamp_utc:inWindow?isoMs(valuation,`outcome valuation ${s.candidateId} ${t.track}`):null,
     window_role:inWindow?"executable_observation":"outside_executable_window",
     before_expiry:trigger!=="after_expiry",before_invalidation:null,holding_hours:null,
     net_pnl_native:trigger==="reached"?pnl:null,
     net_pnl_usd:trigger==="reached"&&pnl!==null&&index!==null?pnl*index:null,
     closing_fees_native:o?o.feesBtc??null:null,quality:o?.estimateQuality??"unavailable",
     reason_codes:[trigger==="reached"?(pnl===null?"outcome_reached_but_unpriced":"outcome_priced")
      :trigger==="not_reached"?"outcome_not_reached":trigger==="after_expiry"?"outcome_after_expiry":"outcome_ambiguous_sequence"],
     evidence_reason:o?.evidenceReason??null}));
   }
  }
 }

 const availability:Row[]=store.events.flatMap(e=>e.generationSnapshot.candidates.map(c=>{const selectedStructure=e.selectedStructures.find(s=>s.candidateId===c.candidateId);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,availability_id:`${c.candidateId}~generation~${hash([c.requestedStrikes,c.targetHorizon,c.strikeMethod])}`,candidate_id:c.candidateId,strategy_variant_id:selectedStructure?.strategyVariantId??c.candidateId,venue:c.venue,is_selected:Boolean(selectedStructure),contract_resolution:selectedStructure?.contractResolution??null,reference_valuation:selectedStructure?.referenceValuation??null,delayed_execution:selectedStructure?.delayedExecution??null,modeled_execution:selectedStructure?.modeledExecution??null,structure_type:c.structure,target_horizon_days:c.targetHorizon,strike_method:c.strikeMethod,width:c.actualStrikes.width??c.requestedStrikes.width,requested_strikes:c.requestedStrikes,actual_strikes:c.actualStrikes,actual_expiry_timestamp_utc:iso(c.actualExpiryTimestamp),requested_expiry_timestamp_utc:null,instruments:null,status:c.status,reason_codes:[c.status==="priced"?"candidate_priced":"candidate_unavailable"],availability_reasons:c.availabilityReasons,entry_quality:c.entryQuality,retrieval_status:selectedStructure?.contractResolution?.status??"metadata_unavailable",generation_configuration:e.generationSnapshot.configuration})})).sort((a,b)=>String(a.candidate_id).localeCompare(String(b.candidate_id))||String(a.availability_id).localeCompare(String(b.availability_id)));
 const margins=selected.map(({e,s})=>{const m=obj(s.marginSnapshot),available=m.status==="available"||m.state==="ok",deployment=obj(m.deployment),openingIm=num(m.openingInitialMarginBtc)??num(m.initialMarginBtc),openingMm=num(m.openingMaintenanceMarginBtc)??num(m.maintenanceMarginBtc),peakIm=num(m.peakInitialMarginBtc),peakMm=num(m.peakMaintenanceMarginBtc);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:s.candidateId,margin_scenario_id:`${s.venue}~margin~${hash(s.candidateId)}`,venue:s.venue,margin_status:available?"available":"unavailable",margin_model:deployment.model??null,method_version:m.engineVersion??m.ruleVersion??null,rule_version:m.ruleVersion??null,provenance:m.provenance??null,account_configuration:deployment.accountAssumption??null,collateral_currency:deployment.collateralCurrency??"BTC",settlement_currency:"BTC",incremental_initial_margin:available?openingIm:null,incremental_maintenance_margin:available?openingMm:null,peak_initial_margin:available?peakIm:null,peak_maintenance_margin:available?peakMm:null,peak_timestamp_utc:available?iso(num(m.peakInitialTimestamp)??num(m.observationTimestamp)):null,capital_days_margin:available?num(m.capitalDaysMarginBtc):null,maximum_loss_usd:null,maximum_loss_native:num(m.theoreticalMaximumSpreadLossBtc),reference_index:num(m.indexPrice),calculation_method:available?(m.method??m.evidenceModel??"historical Standard Margin reconstruction"):null,data_quality:available?"historical_formula_reconstruction":"unavailable",reason_codes:available?[]:[String(m.reasonCode??canonicalMarginReason(m.reason??m.unavailabilityReason))],unavailable_reason:available?null:String(m.reason??m.unavailabilityReason??"Verified historical margin reconstruction is unavailable."),margin_inputs:{path:m.path??null,mark_price_btc:m.markPriceBtc??null} });});
 /** Each usage reference now carries execution_scenario, so provenance shows exactly which scenario a given raw trade supported -- never left ambiguous between maker and taker. */
 const evidence=store.events.flatMap(e=>{const catalog=new Map((e.evidenceCatalog??[]).map(t=>[t.evidenceId,t]));const grouped=new Map<string,{t:Record<string,JsonValue>;usages:Row[]}>();for(const s of e.selectedStructures){if(s.evidenceUsages?.length){for(const u of s.evidenceUsages){const t0=catalog.get(u.evidenceId);if(!t0)continue;const t=t0 as unknown as Record<string,JsonValue>;const item=grouped.get(u.evidenceId)??{t,usages:[]};item.usages.push(row({candidate_id:s.candidateId,execution_scenario:u.executionScenario??null,role:u.role,valuation_timestamp_utc:iso(num(u.valuationTimestamp)),pricing_track:u.pricingTrack,leg:u.leg}));grouped.set(u.evidenceId,item)}}else for(const [i,t0] of (s.evidenceTradeSnapshots??[]).entries()){const t=obj(t0),id=`${s.venue}~evidence~${hash([s.candidateId,t.tradeId??i,t.timestamp])}`;grouped.set(id,{t:{...t,evidenceId:id,venue:s.venue} as Record<string,JsonValue>,usages:[row({candidate_id:s.candidateId,execution_scenario:null,role:"saved-source-trade",valuation_timestamp_utc:null,pricing_track:null,leg:null})]})}}return[...grouped].map(([id,{t,usages}])=>{const iv=num(t.ivDecimal),price=num(t.price),index=num(t.indexPrice);return row({run_id:runId,source_run_id:sourceIds.get(e.eventId),event_id:e.eventId,candidate_id:usages[0]?.candidate_id??null,valuation_id:null,evidence_id:`${id}~${hash(e.eventId)}`,venue:t.venue??"deribit",instrument:t.instrument??t.instrumentName??null,trade_id:t.tradeId??null,timestamp_utc:isoMs(num(t.timestamp),`evidence ${id}`),timestamp_semantics:"raw_market_trade_time",window_role:usages.some(u=>{const s=selected.find(x=>x.s.candidateId===u.candidate_id)?.s;const scenarioMode=u.execution_scenario==="maker"||u.execution_scenario==="taker"?u.execution_scenario:null;const entrySnapshot=s&&scenarioMode?obj(s.executionScenarios[scenarioMode].entrySnapshot):{};const et=num(entrySnapshot.valuationTimestamp)??num(entrySnapshot.targetTimestamp),ex=s?num(obj(s.candidateSnapshot).expiryTimestamp):null,vt=Date.parse(String(u.valuation_timestamp_utc));return et!==null&&ex!==null&&Number.isFinite(vt)&&vt>=et&&vt<=ex})?"executable_evidence":"raw_source_outside_executable_window",direction:t.direction??null,native_currency:"BTC",price_native:price,price_usd:price!==null&&index!==null?price*index:null,amount:t.amount??null,iv_api_percentage:t.ivApiPercent??(iv===null?null:iv*100),iv_decimal:iv,index_price:index,block_id:t.blockTradeId??null,rfq_id:t.rfqId??null,evidence_role:"catalog-trade",usage_references:usages,source_endpoint_file:"persisted-selection-evidence-catalog",pricing_track:null})})});
 const futuresBuilt=store.events.map(e=>buildEventFuturesBaseline(e,"vpoc"));
 const futures=futuresBuilt.map(({comparison},i)=>row({run_id:runId,source_run_id:sourceIds.get(store.events[i].eventId),venue:"deribit",...comparison}));
 const futuresPath=futuresBuilt.flatMap(({path},i)=>path.map(p=>row({run_id:runId,source_run_id:sourceIds.get(store.events[i].eventId),...p})));
 const sourceRuns=store.events.map(e=>({source_run_id:sourceIds.get(e.eventId),venue:e.selectedStructures[0]?.venue??e.generationSnapshot.candidates[0]?.venue??"deribit",event_id:e.eventId,configuration:e.generationSnapshot.configuration,generation_timestamp_utc:e.generationSnapshot.generatedAtUtc}));
 const migratedValuationWindowDiagnostics=selected.flatMap(({e,s})=>(["maker","taker"] as const).flatMap(executionScenario=>{const diagnostic=s.executionScenarios[executionScenario].valuationWindowMigration;return diagnostic?[{event_id:e.eventId,candidate_id:s.candidateId,execution_scenario:executionScenario,...diagnostic}]:[]}));
 const run=row({schema_version:RESEARCH_BUNDLE_SCHEMA_VERSION,futures_engine_version:FUTURES_ENGINE_VERSION,valuation_window_diagnostics:{migrated:migratedValuationWindowDiagnostics,builder_omitted_before_entry:omittedValuationsBeforeEntry,builder_omitted_after_expiry:omittedValuationsAfterExpiry},run_id:runId,generated_at_utc:generatedAtUtc,dataset_id:store.datasetId,dataset_version_updated_at:datasetUpdatedAt??store.updatedAtUtc,application_commit_build_id:[...new Set(sourceRuns.map(x=>x.configuration.applicationBuild).filter(Boolean))],pricing_engine_versions:[...new Set(sourceRuns.map(x=>x.configuration.pricingEngineVersion))],quality_rules_versions:[...new Set(sourceRuns.map(x=>x.configuration.qualityRulesVersion))],valuation_methodology_version:"simple-model-reconstruction/1.0.0",valuation_intervals:[...new Set(sourceRuns.map(x=>x.configuration.valuationInterval))],timezone:"UTC",included_pricing_tracks:["raw_vwap","iv_normalized"],included_execution_scenarios:["maker","taker"],dte_windows:sourceRuns.map(x=>x.configuration.dteWindows),expiry_selection_modes:[...new Set(sourceRuns.map(x=>x.configuration.expirySelectionMode))],evidence_windows:sourceRuns.map(x=>x.configuration.historicalEvidenceWindows),synchronization_thresholds:sourceRuns.map(x=>x.configuration.synchronizationThresholds),quality_thresholds:sourceRuns.map(x=>x.configuration.qualityThresholds),model_assumptions:sourceRuns.map(x=>x.configuration.modelAssumptions),fee_assumptions:sourceRuns.map(x=>x.configuration.feeAssumptions),settlement_rules:sourceRuns.map(x=>x.configuration.settlementRules),trade_dataset_mr_event_count:null,persisted_research_event_count:events.length,events_with_generated_candidates_count:new Set(availability.map(x=>x.event_id)).size,events_with_selected_candidates_count:new Set(candidates.map(x=>x.event_id)).size,events_with_stored_underlying_paths_count:new Set(paths.map(x=>x.event_id)).size,selected_structure_count:new Set(candidates.map(x=>x.candidate_id)).size,selected_structure_execution_row_count:candidates.length,generated_denominator_count:availability.length,venues:[...new Set(store.events.flatMap(e=>e.generationSnapshot.candidates.map(c=>c.venue))) ],venue_configuration:{deribit:economic,bybit:null,binance:null},source_runs:sourceRuns,table_availability:{underlying_path:paths.length?"available":"unavailable",margin_scenarios:margins.some(m=>m.margin_status==="available")?"available":"unavailable",evidence_trades:evidence.length?"available":"unavailable",futures_comparisons:futures.some(f=>f.availability==="available")?"available":"unavailable",futures_path:futuresPath.length?"available":"unavailable"}});
 const files=Object.fromEntries(RESEARCH_BUNDLE_FILES.map(name=>[name,name==="run.json"?JSON.stringify(run)+"\n":lines(({"events.jsonl":events,"underlying_path.jsonl":paths,"structure_economics.jsonl":structureEconomics,"candidates.jsonl":candidates,"valuations.jsonl":[...valuations,...independentValuations],"outcomes.jsonl":[...outcomes,...independentOutcomes],"availability.jsonl":availability,"margin_scenarios.jsonl":margins,"evidence_trades.jsonl":evidence,"futures_comparisons.jsonl":futures,"futures_path.jsonl":futuresPath})[name]??[])])) as ResearchBundle["files"];
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
 return{ok:!errors.length,errors};
}
