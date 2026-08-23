import type {FuturesMarketSnapshot,JsonValue,ResearchSelectionEvent} from "./research-selections.ts";
import {resolveEventTiming} from "./event-timing.ts";

export const FUTURES_ENGINE_VERSION="deribit-btc-perpetual-baseline-v1" as const;
/** Commission is read from the venue's own instrument metadata, never assumed. */
export const FUTURES_FEE_MODEL_VERSION="deribit-perpetual-instrument-commission-v1" as const;
/** Stated, not hidden: the reference baseline books zero slippage and says so. */
export const FUTURES_SLIPPAGE_MODEL_VERSION="futures-zero-slippage-reference-v1" as const;
export const FUTURES_FUNDING_MODEL_VERSION="deribit-hourly-interest-1h-v1" as const;
export const CANONICAL_BTC_PERPETUAL="BTC-PERPETUAL" as const;
export const DEFAULT_FUTURES_SLIPPAGE_BPS=0;
const HOUR_MS=3_600_000,DAY_MS=86_400_000;

export type FuturesPolicy="vpoc"|"invalidation"|"fixed_3d"|"fixed_5d"|"fixed_7d";
export const FUTURES_POLICIES:readonly FuturesPolicy[]=["vpoc","invalidation","fixed_3d","fixed_5d","fixed_7d"];

export interface FuturesPathRow {
 event_id:string;comparison_id:string;instrument:string;timestamp_utc:string;futures_price:number;
 open:number|null;high:number|null;low:number|null;close:number|null;volume:number|null;
 index_price:number|null;source:"deribit";series_kind:"futures";observation_kind:"reference";verified:true;
 price_basis:string;funding_rate:number|null;funding_rate_status:"observed"|"unavailable";
 unrealized_pnl_usd_per_unit:number|null;unrealized_pnl_usd:number|null;
}
export type FuturesComparisonRow=Record<string,JsonValue>;

const obj=(x:unknown)=>x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const num=(x:unknown)=>typeof x==="number"&&Number.isFinite(x)?x:null;
const iso=(t:number|null)=>t===null?null:new Date(t).toISOString();

type Point={timestamp:number;price:number;open:number|null;high:number|null;low:number|null;close:number|null;volume:number|null;indexPrice:number|null};

/** Smallest positive spacing actually present, so a legacy snapshot without recorded coverage is still read honestly. */
function seriesResolutionMs(market:FuturesMarketSnapshot,points:readonly Point[]):number{
 const recorded=num(obj(market.referenceCoverage).resolutionMs);
 if(recorded!==null&&recorded>0)return recorded;
 let smallest=Infinity;
 for(let i=1;i<points.length;i+=1){const gap=points[i].timestamp-points[i-1].timestamp;if(gap>0&&gap<smallest)smallest=gap}
 return Number.isFinite(smallest)?smallest:HOUR_MS;
}
/**
 * The first observation at or after a decision. Nothing is carried forward: if
 * the venue has no bar within one interval of the decision, the observation is
 * unavailable rather than borrowed from an earlier bar.
 */
function observeAtOrAfter(points:readonly Point[],decision:number,resolutionMs:number){
 const point=points.find(p=>p.timestamp>=decision);
 if(!point)return{point:null,lagMs:null,reason:"futures_exit_observation_unavailable" as const};
 const lagMs=point.timestamp-decision;
 return lagMs>=resolutionMs?{point:null,lagMs,reason:"futures_series_gap_at_decision" as const}:{point,lagMs,reason:null};
}
const fillPrice=(point:Point)=>point.open??point.price;
const fillBasis=(point:Point)=>point.open!==null?"bar_open_at_or_after_decision":"bar_close_legacy_snapshot";

/**
 * `outcome` separates the two states the research explicitly needs to study
 * apart: a target that exists and was never reached during observation, versus
 * a target the event never configured. Neither is a reason to discard the rest
 * of the benchmark.
 */
type EndpointOutcome="reached"|"not_reached"|"not_configured";
interface Endpoint {policy:FuturesPolicy;trigger:number|null;decision:number|null;outcome:EndpointOutcome;reason:string|null}
function endpoints(timing:ReturnType<typeof resolveEventTiming>,order:number|null):Endpoint[]{
 const fixed=(days:number)=>order===null?null:order+days*DAY_MS;
 const vpocOutcome:EndpointOutcome=timing.vpocDecisionTimestamp!==null?"reached":timing.vpocTargetStatus==="not_reached"?"not_reached":"not_configured";
 const invalidationOutcome:EndpointOutcome=timing.invalidationDecisionTimestamp!==null?"reached":timing.invalidationPrice!==null?"not_reached":"not_configured";
 return [
  {policy:"vpoc",trigger:timing.vpocTriggerTimestamp,decision:timing.vpocDecisionTimestamp,outcome:vpocOutcome,
   reason:vpocOutcome==="reached"?null:vpocOutcome==="not_reached"?"futures_vpoc_target_not_reached":"futures_event_vpoc_not_configured"},
  {policy:"invalidation",trigger:timing.invalidationTriggerTimestamp,decision:timing.invalidationDecisionTimestamp,outcome:invalidationOutcome,
   reason:invalidationOutcome==="reached"?null:invalidationOutcome==="not_reached"?"futures_invalidation_not_reached":"futures_event_invalidation_not_configured"},
  ...([["fixed_3d",3],["fixed_5d",5],["fixed_7d",7]] as const).map(([policy,days])=>({policy,trigger:fixed(days),decision:fixed(days),
   outcome:"reached" as EndpointOutcome,reason:order===null?"futures_entry_observation_unavailable":null})),
 ];
}

/**
 * One canonical, event-level Deribit perpetual baseline. It never reads option
 * legs, spot/index candles, or option margin, and it produces per-unit
 * economics so downstream analysis can scale the position itself; the derived
 * equal-risk quantity is a convenience, never the strategy result.
 */
export function buildEventFuturesBaseline(event:ResearchSelectionEvent,policy:FuturesPolicy="vpoc"):{comparison:FuturesComparisonRow;path:FuturesPathRow[]}{
 const market=event.generationSnapshot.futuresMarket;
 const timing=resolveEventTiming({sourceRun:event.sourceRun,underlyingHourlyPath:event.generationSnapshot.underlyingHourlyPath});
 const signal=timing.entryTimestamp;
 const latency=num(obj(event.generationSnapshot.configuration.modelAssumptions).executionLatencyMs)??0;
 const order=signal===null?null:signal+latency;
 const id=`deribit~futures~${event.eventId}~${policy}`;
 const base={event_id:event.eventId,comparison_id:id,engine_version:FUTURES_ENGINE_VERSION,benchmark:"Deribit BTC perpetual",policy,
  direction:timing.direction,sequence_status:timing.sequenceStatus,
  signal_timestamp_utc:iso(signal),decision_available_timestamp_utc:iso(signal),order_available_timestamp_utc:iso(order),
  execution_latency_ms:latency,
  futures_margin_status:"unavailable",futures_margin_reason:"Account-level futures margin, leverage and liquidation are deliberately out of scope for this benchmark; no verified historical futures margin state exists in the canonical data.",
  equal_capital_status:"unavailable",equal_capital_reason:"Equal-capital normalization requires a futures capital commitment, which depends on the account-level margin state this benchmark does not model.",
  forward_filled:false};
 const fail=(codes:string[],extra:Record<string,JsonValue>={})=>({comparison:{...base,availability:"unavailable",reference_status:"unavailable",...extra,reason_codes:[...codes,"futures_margin_unavailable"]} as FuturesComparisonRow,path:[] as FuturesPathRow[]});

 if(!market)return fail(["futures_instrument_unavailable"]);
 const instrumentIdentity={instrument:market.instrument,instrument_kind:market.instrumentKind,
  reference_price_basis:market.priceBasis??"unrecorded",retrieval_version:market.retrievalVersion??null,retrieved_at_utc:market.retrievedAtUtc??null,
  retrieval_errors:(market.retrievalErrors??[]) as unknown as JsonValue};
 if(market.source!=="deribit"||market.instrumentKind!=="perpetual"||market.instrument!==CANONICAL_BTC_PERPETUAL)
  return fail(["unsupported_futures_instrument"],instrumentIdentity);

 const points:Point[]=[...market.reference].map(p=>({timestamp:p.timestamp,price:p.price,open:num(p.open),high:num(p.high),low:num(p.low),close:num(p.close)??num(p.price),volume:num(p.volume),indexPrice:num(p.indexPrice)}))
  .filter(p=>Number.isFinite(p.timestamp)&&Number.isFinite(p.price)&&p.price>0).sort((a,b)=>a.timestamp-b.timestamp);
 const coverage=obj(market.referenceCoverage);
 const resolutionMs=seriesResolutionMs(market,points);
 const seriesFacts={...base,...instrumentIdentity,
  reference_series_source:String(coverage.source??"persisted-futures-snapshot"),
  reference_resolution_ms:resolutionMs,
  reference_series_status:String(coverage.status??(points.length?"unrecorded":"unavailable")),
  reference_expected_points:num(coverage.expectedPoints),
  reference_received_points:points.length,
  reference_missing_points:num(coverage.missingPoints),
  contract_size_usd:num(obj(market.instrumentMetadata).contractSizeUsd),
  min_trade_amount_usd:num(obj(market.instrumentMetadata).minTradeAmountUsd),
  quantity_convention:{unit:"btc_equivalent_at_reference_entry",amount_denomination:"usd",note:"Deribit BTC-PERPETUAL is quoted in USD and traded in USD amounts stepped by contract size. One BTC-equivalent unit at price P is P USD of notional."} as unknown as JsonValue};
 if(!points.length||order===null)return fail([order===null?"futures_entry_observation_unavailable":"futures_reference_series_unavailable"],seriesFacts);
 if(timing.direction===null)return fail(["futures_direction_unavailable"],seriesFacts);
 const sign=timing.direction==="long"?1:-1;

 const entryObservation=observeAtOrAfter(points,order,resolutionMs);
 if(!entryObservation.point)return fail([entryObservation.reason==="futures_series_gap_at_decision"?"futures_series_gap_at_entry_decision":"futures_entry_observation_unavailable"],seriesFacts);
 const entry=entryObservation.point,entryPrice=fillPrice(entry);

 // Every endpoint is evaluated independently. One unavailable policy endpoint
 // never erases the entry, the path, the other endpoints, or the per-unit
 // economics that do not depend on an exit -- that is exactly the "VPOC never
 // reached" population this research needs to keep.
 const resolved=endpoints(timing,order).map(endpoint=>{
  if(endpoint.decision===null||endpoint.decision<entry.timestamp)
   return{...endpoint,point:null,lagMs:null,code:endpoint.reason??"matched_endpoint_unavailable"};
  const observed=observeAtOrAfter(points,endpoint.decision,resolutionMs);
  return{...endpoint,point:observed.point,lagMs:observed.lagMs,code:observed.point?null:observed.reason};
 });
 const chosen=resolved.find(e=>e.policy===policy)!;
 const endpointRows=resolved.map(e=>({policy:e.policy,trigger_timestamp_utc:iso(e.trigger),decision_timestamp_utc:iso(e.decision),
  observation_timestamp_utc:e.point?iso(e.point.timestamp):null,observation_price:e.point?fillPrice(e.point):null,
  outcome:e.outcome,status:e.point?"available":e.outcome==="not_reached"?"not_reached":e.outcome==="not_configured"?"not_configured":"unavailable",
  reason_code:e.code??null})) as unknown as JsonValue;
 const exit=chosen.point,exitPrice=exit?fillPrice(exit):null;
 const exitStatus=exit?"available":chosen.outcome==="not_reached"?"not_reached":chosen.outcome==="not_configured"?"not_configured":"unavailable";
 const exitCode=exit?null:chosen.code??"futures_exit_endpoint_unavailable";
 // With no resolved exit the causal path still runs to the end of the retrieved
 // series, so the never-resolved population stays analysable.
 const terminus=exit??points[points.length-1];
 const endpointFacts={...seriesFacts,endpoints:endpointRows,
  vpoc_target_status:timing.vpocTargetStatus,vpoc_target_price:timing.vpocTargetPrice,
  exit_policy:policy,exit_trigger_timestamp_utc:iso(chosen.trigger),exit_decision_timestamp_utc:iso(chosen.decision)};

 // Fees and slippage are applied exactly once per side and carry their own versions.
 const metadata=obj(market.instrumentMetadata);
 const feeRate=num(metadata.takerCommission)??num(market.feeRate);
 const feesPerUnit=feeRate===null||exitPrice===null?null:(entryPrice+exitPrice)*feeRate;
 const slippageBps=DEFAULT_FUTURES_SLIPPAGE_BPS,slippagePerUnit=exitPrice===null?null:(entryPrice+exitPrice)*slippageBps/10_000;
 const grossPerUnit=exitPrice===null?null:sign*(exitPrice-entryPrice);
 const netBeforeFundingPerUnit=feesPerUnit===null||grossPerUnit===null||slippagePerUnit===null?null:grossPerUnit-feesPerUnit-slippagePerUnit;
 const riskPerUnit=timing.invalidationPrice===null?null:Math.abs(entryPrice-timing.invalidationPrice);

 // Funding is summed over the hours actually held, priced at the contemporaneous
 // perpetual bar. A single missing hour or missing price leaves funding unknown.
 const fundingByHour=new Map((market.funding??[]).map(f=>[f.timestamp,f]));
 const priceByTimestamp=new Map(points.map(p=>[p.timestamp,p]));
 const expectedFundingHours:number[]=[];
 if(exit)for(let hour=Math.floor(entry.timestamp/HOUR_MS)*HOUR_MS+HOUR_MS;hour<=exit.timestamp;hour+=HOUR_MS)expectedFundingHours.push(hour);
 let fundingPerUnit:number|null=0,observedFundingHours=0;
 for(const hour of expectedFundingHours){
  const rate=fundingByHour.get(hour),bar=priceByTimestamp.get(hour);
  if(!rate||!bar||!Number.isFinite(rate.rate)){fundingPerUnit=null;continue}
  observedFundingHours+=1;
  if(fundingPerUnit!==null)fundingPerUnit-=sign*fillPrice(bar)*rate.rate;
 }
 const fundingCoverage=obj(market.fundingCoverage);
 // Funding is a property of a holding period, so with no resolved exit it is
 // not_evaluated -- distinct from a funding outage.
 const fundingStatus=!exit?"not_evaluated"
  :market.funding===undefined?"unavailable"
  :expectedFundingHours.length===0?"available"
  :fundingPerUnit===null?(observedFundingHours?"partial":"unavailable"):"available";
 if(fundingStatus!=="available")fundingPerUnit=null;
 const netAfterFundingPerUnit=fundingStatus==="available"&&netBeforeFundingPerUnit!==null&&fundingPerUnit!==null?netBeforeFundingPerUnit+fundingPerUnit:null;

 // Derived reference sizing. Per-unit values above stay authoritative; this is a
 // convenience so an equal-dollar-risk comparison is reproducible, and it names
 // the structure it was scaled against.
 const lossBasis=event.selectedStructures.map(s=>{const m=obj(s.marginSnapshot);return{candidateId:s.candidateId,usd:num(m.maximumEconomicLossUsd)??(num(m.theoreticalMaximumSpreadLossBtc)!==null?num(m.theoreticalMaximumSpreadLossBtc)!*entryPrice:null)}}).filter(x=>x.usd!==null&&x.usd>0) as Array<{candidateId:string;usd:number}>;
 const largest=lossBasis.sort((a,b)=>b.usd-a.usd)[0];
 const riskBudgetUsd=largest?.usd??null;
 const quantity=riskBudgetUsd!==null&&riskPerUnit!==null&&riskPerUnit>0?riskBudgetUsd/riskPerUnit:null;

 const observedTrade=(market.trades??[]).slice().sort((a,b)=>a.timestamp-b.timestamp)
  .find(t=>t.timestamp>=order&&t.direction===(timing.direction==="long"?"buy":"sell"));

 const path:FuturesPathRow[]=points.filter(p=>p.timestamp>=entry.timestamp&&p.timestamp<=terminus.timestamp).map(p=>{
  const rate=fundingByHour.get(p.timestamp);
  const perUnit=sign*(fillPrice(p)-entryPrice);
  return{event_id:event.eventId,comparison_id:id,instrument:market.instrument,timestamp_utc:new Date(p.timestamp).toISOString(),
   futures_price:p.price,open:p.open,high:p.high,low:p.low,close:p.close,volume:p.volume,index_price:p.indexPrice,
   source:"deribit" as const,series_kind:"futures" as const,observation_kind:"reference" as const,verified:true as const,
   price_basis:market.priceBasis??"unrecorded",
   funding_rate:rate?rate.rate:null,funding_rate_status:rate?"observed" as const:"unavailable" as const,
   unrealized_pnl_usd_per_unit:perUnit,unrealized_pnl_usd:quantity===null?null:perUnit*quantity};
 });

 const reasonCodes=[
  ...(exitCode?[exitCode]:[]),
  ...(observedTrade?[]:["observed_futures_execution_unavailable"]),
  ...(fundingStatus==="available"?(expectedFundingHours.length?[]:["futures_no_funding_interval_elapsed"])
   :fundingStatus==="not_evaluated"?["funding_not_evaluated"]
   :[fundingStatus==="partial"?"funding_partial":"funding_unavailable"]),
  ...(feeRate===null?["futures_fee_schedule_unavailable"]:[]),
  ...(String(coverage.status??"")==="partial"?["futures_reference_series_incomplete"]:[]),
  ...(entryObservation.lagMs?["futures_entry_bar_resolution_lag"]:[]),
  ...(timing.sequenceStatus==="ambiguous"?["futures_event_resolution_ambiguous"]:[]),
  ...(riskPerUnit===null||riskPerUnit===0?["futures_invalidation_distance_unavailable"]:[]),
  "futures_margin_unavailable",
 ];

 return{comparison:{...endpointFacts,availability:"available",reference_status:"available",
  reference_entry_timestamp_utc:iso(entry.timestamp),reference_entry_price:entryPrice,reference_entry_basis:fillBasis(entry),entry_lag_ms:entryObservation.lagMs,
  observed_execution_status:observedTrade?"available":"unavailable",observed_entry_price:observedTrade?.price??null,
  observed_entry_timestamp_utc:observedTrade?new Date(observedTrade.timestamp).toISOString():null,
  observed_evidence_ids:observedTrade?[observedTrade.tradeId]:[],
  exit_timestamp_utc:exit?iso(exit.timestamp):null,exit_price:exitPrice,exit_basis:exit?fillBasis(exit):null,exit_lag_ms:chosen.lagMs,
  exit_status:exitStatus,exit_unavailable_reason_code:exitCode,
  path_terminus_timestamp_utc:iso(terminus.timestamp),path_terminus_basis:exit?"exit_endpoint":"retrieved_series_end_no_resolved_exit",
  // Ambiguity is reported, never resolved by assumption: when VPOC and
  // invalidation fall in the same candle the ordering claim is withheld.
  exit_ordering_status:timing.sequenceStatus==="ambiguous"?"ambiguous":"ordered",
  holding_hours:exit?(exit.timestamp-entry.timestamp)/HOUR_MS:null,
  observed_hours_to_path_terminus:(terminus.timestamp-entry.timestamp)/HOUR_MS,
  invalidation_price:timing.invalidationPrice,
  unit_convention:"per 1 BTC-equivalent of perpetual notional, quoted in USD",
  gross_pnl_usd_per_unit:grossPerUnit,
  risk_to_invalidation_usd_per_unit:riskPerUnit,
  fee_rate:feeRate,fee_side:"taker",fee_model_version:FUTURES_FEE_MODEL_VERSION,
  fee_source:num(metadata.takerCommission)!==null?String(metadata.source??"deribit-get_instrument"):market.feeRate!==undefined?"persisted-snapshot-fee-rate":"unavailable",
  fees_usd_per_unit:feesPerUnit,
  slippage_bps:slippageBps,slippage_model_version:FUTURES_SLIPPAGE_MODEL_VERSION,
  slippage_assumption:"Zero slippage against the observed bar price; the reference baseline states the assumption rather than embedding an unverified cost.",
  slippage_usd_per_unit:slippagePerUnit,
  net_pnl_usd_per_unit_before_funding:netBeforeFundingPerUnit,
  funding_status:fundingStatus,funding_model_version:FUTURES_FUNDING_MODEL_VERSION,
  funding_rate_field:String(fundingCoverage.rateField??"interest_1h"),
  funding_source:fundingCoverage.source===undefined?null:String(fundingCoverage.source),
  funding_intervals_expected:expectedFundingHours.length,funding_intervals_observed:observedFundingHours,
  funding_usd_per_unit:fundingPerUnit,
  net_pnl_usd_per_unit_after_funding:netAfterFundingPerUnit,
  equal_risk_sizing_method:"option_max_economic_loss_usd / abs(futures_entry - structural_invalidation)",
  equal_risk_sizing_status:quantity===null?"downstream_derivable":"derived",
  quantity,quantity_basis:largest?.candidateId??null,risk_budget_usd:riskBudgetUsd,
  gross_trading_pnl_usd:quantity===null||grossPerUnit===null?null:grossPerUnit*quantity,
  entry_exit_fees_usd:quantity===null||feesPerUnit===null?null:feesPerUnit*quantity,
  funding_usd:quantity===null||fundingPerUnit===null?null:fundingPerUnit*quantity,
  net_pnl_usd_before_funding:quantity===null||netBeforeFundingPerUnit===null?null:netBeforeFundingPerUnit*quantity,
  net_pnl_usd:quantity===null||netAfterFundingPerUnit===null?null:netAfterFundingPerUnit*quantity,
  reason_codes:reasonCodes} as FuturesComparisonRow,path};
}
