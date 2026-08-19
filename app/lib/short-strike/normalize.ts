import type {AnalysisDataset} from "../research-analysis.ts";
import {adversePath,type AdversePathObservation} from "../adverse-path.ts";

/**
 * Canonical research bundle -> normalized short-strike structures.
 *
 * SCOPE. This module analyses WHERE THE SHORT STRIKE IS PLACED and nothing
 * else. Spread width is held constant inside every comparison rather than
 * studied here: strike placement decides where risk begins, width decides how
 * much tail risk is retained, and answering both at once would confound them.
 * Width analysis is a separate report.
 *
 * The canonical generator produces at most two placements per (event, expiry,
 * width): `anchor`, rounded from the failed-breakout extreme toward the thesis
 * direction, and `buffered`, one strike step further away. This module reads
 * `strike_method` verbatim and calls them TECHNICAL and BUFFERED; it never
 * infers a placement from the strike value itself.
 *
 * DIRECTION SIGN. Every distance is expressed so that POSITIVE MEANS FARTHER
 * OUT OF THE MONEY, i.e. safer, for both directions. A bullish MR sells a put
 * below spot, so a lower strike is safer; a bearish MR sells a call above
 * spot, so a higher strike is safer. Collapsing that into one sign is what
 * lets technical and buffered be compared with a single number regardless of
 * which way the trade faces.
 */

export type StrikeMethod="technical"|"buffered";
export type ExecutionScenario="maker"|"taker";
export type ExecutionScenarioStatus="evaluated"|"not_evaluated";

/** Why a geometric or economic figure has no value. Never collapsed into a zero. */
export type UnavailableReason=string;

export interface StrikeGeometry {
 readonly shortStrike:number|null;
 readonly longStrike:number|null;
 /** Spot at structure entry: the candidate's own entry index, else the event's entry price. */
 readonly entrySpot:number|null;
 readonly entrySpotSource:"entry_index_price"|"event_entry_price"|null;
 /** Positive = farther out of the money than spot. */
 readonly distanceFromEntrySpotUsd:number|null;
 /** Positive = beyond the failed-breakout extreme, on the safe side. */
 readonly distanceFromExtremeUsd:number|null;
 /** Positive = beyond the invalidation level, i.e. the thesis stops out before the strike is breached. */
 readonly distanceFromInvalidationUsd:number|null;
 readonly distanceAsPctOfSpot:number|null;
 readonly distanceAsPctOfRange:number|null;
 /**
  * Entry delta. The canonical bundle records implied volatility per leg but no
  * delta on any table, so this is Unavailable rather than reconstructed: a
  * delta derived here from an IV anchor would be a model output presented as a
  * canonical observation.
  */
 readonly entryDelta:number|null;
 readonly entryDeltaReason:UnavailableReason|null;
}

/**
 * How the underlying challenged the short strike while the structure existed.
 *
 * TOUCH and BREACH are defined from the canonical hourly underlying path and
 * nothing else:
 *  - TOUCH: the candle's extreme reached the strike (low <= K for a short put,
 *    high >= K for a short call). The strike was tested intrabar.
 *  - BREACH: the candle CLOSED beyond the strike. A completed hourly close is
 *    the finest settled evidence the path provides.
 *
 * Ordering is only ever asserted at the precision the path actually has. The
 * path is stamped at candle OPEN, so two events inside one hourly candle
 * cannot be ordered; that case is reported as ambiguous rather than resolved
 * by assumption.
 */
export interface ChallengeObservation {
 readonly touched:boolean|null;
 readonly breached:boolean|null;
 readonly firstTouchMs:number|null;
 readonly firstBreachMs:number|null;
 readonly invalidationMs:number|null;
 readonly invalidatedInWindow:boolean|null;
 /** Null when both happened but within one candle, so their order is genuinely unknown. */
 readonly breachBeforeInvalidation:boolean|null;
 readonly ambiguousOrdering:boolean;
 readonly invalidatedWithoutBreach:boolean|null;
 readonly candlesInWindow:number;
 readonly reason:UnavailableReason|null;
}

export interface ShortStrikeStructure {
 readonly eventId:string;
 readonly candidateId:string;
 readonly structureExecutionId:string;
 readonly executionScenario:ExecutionScenario|null;
 readonly executionScenarioStatus:ExecutionScenarioStatus|null;
 readonly executionScenarioReason:string|null;
 readonly strikeMethod:StrikeMethod|null;
 readonly rawStrikeMethod:string|null;
 readonly direction:"long"|"short"|null;
 readonly optionType:string|null;
 readonly structureType:string|null;
 readonly widthUsd:number|null;
 readonly expiryTimestampMs:number|null;
 readonly actualDteDays:number|null;
 readonly structureEntryMs:number|null;
 /**
  * Everything held constant in a matched comparison: event, actual expiry,
  * width, structure/option type, execution scenario and exit policy. Two rows
  * sharing this key differ ONLY in short-strike placement.
  */
 readonly matchKey:string;

 readonly geometry:StrikeGeometry;
 readonly challenge:ChallengeObservation;

 /* ---- execution-dependent economics ---- */
 readonly grossCreditNative:number|null;
 readonly netCreditNative:number|null;
 readonly grossCreditUsd:number|null;
 readonly netCreditUsd:number|null;
 readonly pnlAtInvalidationUsd:number|null;
 readonly pnlAtSettlementUsd:number|null;
 /** The outcome that actually occurred while the structure existed. */
 readonly realizedPnlUsd:number|null;
 readonly adverse:AdversePathObservation;
 readonly worstAdverseUsd:number|null;
 readonly maeUsd:number|null;
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const nested=(v:unknown,key:string):unknown=>v&&typeof v==="object"&&!Array.isArray(v)?(v as Record<string,unknown>)[key]:undefined;
const scenarioOf=(v:unknown):ExecutionScenario|null=>{const s=str(v);return s==="maker"||s==="taker"?s:null};
const scenarioStatusOf=(v:unknown):ExecutionScenarioStatus|null=>{const s=str(v);return s==="evaluated"||s==="not_evaluated"?s:null};

const DELTA_UNAVAILABLE="The canonical bundle records per-leg implied volatility but no delta on any table. Deriving one from an IV anchor would present a model output as a canonical observation, so entry delta is left Unavailable.";

/** `anchor` is the technical placement rounded from the failed-breakout extreme. */
export function strikeMethodOf(raw:string|null):StrikeMethod|null{
 if(raw==="buffered")return "buffered";
 if(raw==="anchor"||raw==="technical")return "technical";
 return null;
}

/** Positive is farther out of the money, whichever way the thesis faces. */
function safeSign(direction:"long"|"short"|null):number|null{
 return direction==="long"?-1:direction==="short"?1:null;
}

function geometryOf(row:Readonly<Record<string,unknown>>,event:Readonly<Record<string,unknown>>|undefined,direction:"long"|"short"|null):StrikeGeometry{
 const shortStrike=num(nested(row.actual_strikes,"short")),longStrike=num(nested(row.actual_strikes,"long"));
 const entryIndex=num(row.entry_index_price),eventEntry=num(event?.entry_price);
 const entrySpot=entryIndex??eventEntry;
 const entrySpotSource=entryIndex!==null?"entry_index_price" as const:eventEntry!==null?"event_entry_price" as const:null;
 const sign=safeSign(direction);
 const extreme=num(event?.extreme_price),invalidation=num(event?.invalidation_price);
 const rangeLow=num(event?.range_low),rangeHigh=num(event?.range_high);
 const rangeWidth=rangeLow!==null&&rangeHigh!==null&&rangeHigh>rangeLow?rangeHigh-rangeLow:null;
 const away=(reference:number|null)=>shortStrike===null||reference===null||sign===null?null:sign*(shortStrike-reference);
 const fromSpot=away(entrySpot);
 return {
  shortStrike,longStrike,entrySpot,entrySpotSource,
  distanceFromEntrySpotUsd:fromSpot,
  distanceFromExtremeUsd:away(extreme),
  distanceFromInvalidationUsd:away(invalidation),
  distanceAsPctOfSpot:fromSpot!==null&&entrySpot!==null&&entrySpot>0?fromSpot/entrySpot:null,
  distanceAsPctOfRange:fromSpot!==null&&rangeWidth!==null?fromSpot/rangeWidth:null,
  entryDelta:null,entryDeltaReason:DELTA_UNAVAILABLE,
 };
}

/**
 * Touch/breach from the canonical hourly path, bounded to the structure's own
 * life. The path is stamped at candle OPEN, so a candle is only counted when
 * it OPENS at or after structure entry: a candle straddling entry is partly
 * pre-entry, and counting it would let price action from before the position
 * existed challenge it. Candles opening after expiry are excluded for the
 * mirror-image reason.
 */
function challengeOf(
 path:readonly Readonly<Record<string,unknown>>[],
 shortStrike:number|null,direction:"long"|"short"|null,
 entryMs:number|null,expiryMs:number|null,invalidationMs:number|null,
):ChallengeObservation{
 const empty={touched:null,breached:null,firstTouchMs:null,firstBreachMs:null,invalidationMs,
  invalidatedInWindow:null,breachBeforeInvalidation:null,ambiguousOrdering:false,
  invalidatedWithoutBreach:null,candlesInWindow:0} as const;
 if(shortStrike===null||direction===null)return {...empty,reason:"The structure has no canonical short strike or the event has no direction, so the strike cannot be challenged."};
 if(entryMs===null||expiryMs===null)return {...empty,reason:"Structure entry or expiry is unknown, so no causal observation window can be bounded."};
 if(!path.length)return {...empty,reason:"The canonical bundle exports no underlying path for this event."};

 const bullish=direction==="long";
 let firstTouchMs:number|null=null,firstBreachMs:number|null=null,candlesInWindow=0,breachCandleOpen:number|null=null;
 const ordered=[...path].map(row=>({t:ms(row.timestamp_utc),high:num(row.high),low:num(row.low),close:num(row.close)}))
  .filter(c=>c.t!==null).sort((a,b)=>a.t!-b.t!);
 for(const candle of ordered){
  const t=candle.t!;
  if(t<entryMs||t>expiryMs)continue;
  candlesInWindow++;
  const touched=bullish?candle.low!==null&&candle.low<=shortStrike:candle.high!==null&&candle.high>=shortStrike;
  if(touched&&firstTouchMs===null)firstTouchMs=t;
  const breached=candle.close!==null&&(bullish?candle.close<shortStrike:candle.close>shortStrike);
  if(breached&&firstBreachMs===null){firstBreachMs=t;breachCandleOpen=t}
 }
 if(!candlesInWindow)return {...empty,reason:"The canonical path has no candle opening inside this structure's life, so touch and breach are unobservable."};

 const invalidatedInWindow=invalidationMs===null?false:invalidationMs>=entryMs&&invalidationMs<=expiryMs;
 // Two events inside one hourly candle cannot be ordered from candle-open
 // stamps, so the sequence is preserved as unknown rather than invented.
 const candleOf=(t:number)=>{let open:number|null=null;for(const c of ordered){if(c.t!<=t)open=c.t!;else break}return open};
 const ambiguousOrdering=firstBreachMs!==null&&invalidationMs!==null&&invalidatedInWindow
  &&breachCandleOpen!==null&&candleOf(invalidationMs)===breachCandleOpen;
 const breachBeforeInvalidation=firstBreachMs===null||invalidationMs===null||!invalidatedInWindow?null
  :ambiguousOrdering?null
  :firstBreachMs<invalidationMs;
 return {
  touched:firstTouchMs!==null,breached:firstBreachMs!==null,firstTouchMs,firstBreachMs,invalidationMs,
  invalidatedInWindow,breachBeforeInvalidation,ambiguousOrdering,
  invalidatedWithoutBreach:invalidatedInWindow?firstBreachMs===null:false,
  candlesInWindow,reason:null,
 };
}

function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,kind:"invalidation"|"settlement"):number|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===kind);
 if(!row||row.status!=="priced")return null;
 return num(row.net_pnl_usd)??num(row.net_pnl_native);
}

export function normalizeShortStrikeStructures(dataset:AnalysisDataset):readonly ShortStrikeStructure[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],
  valuations=dataset.tables.valuations??[],events=dataset.tables.events??[],paths=dataset.tables.underlying_path??[];
 const eventById=new Map(events.map(e=>[str(e.event_id)??"",e]));
 const pathByEvent=new Map<string,Readonly<Record<string,unknown>>[]>();
 for(const row of paths){const id=str(row.event_id);if(!id)continue;const list=pathByEvent.get(id);if(list)list.push(row);else pathByEvent.set(id,[row])}

 return candidates.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",candidateId=str(row.candidate_id)??"unknown-candidate";
  const scenario=scenarioOf(row.execution_scenario),scenarioStatus=scenarioStatusOf(row.execution_scenario_status);
  const evaluated=scenarioStatus==="evaluated";
  const event=eventById.get(eventId);
  const directionRaw=str(row.direction)??str(event?.direction);
  const direction=directionRaw==="long"||directionRaw==="short"?directionRaw:null;
  const rawStrikeMethod=str(row.strike_method),strikeMethod=strikeMethodOf(rawStrikeMethod);
  const widthUsd=num(nested(row.actual_strikes,"width"));
  const expiryTimestampMs=ms(row.expiry_timestamp_utc);
  const structureEntryMs=ms(row.structure_entry_timestamp_utc)??ms(row.valuation_timestamp_utc);
  const actualDteDays=num(row.actual_dte)??num(row.actual_dte_days);
  const optionType=str(row.option_type),structureType=str(row.structure_type);
  const invalidationMs=ms(event?.invalidation_decision_timestamp_utc);

  const geometry=geometryOf(row,event,direction);
  const challenge=challengeOf(pathByEvent.get(eventId)??[],geometry.shortStrike,direction,structureEntryMs,expiryTimestampMs,invalidationMs);

  const entryIndex=geometry.entrySpot;
  const grossCreditNative=evaluated?num(row.gross_credit_debit_native):null;
  const netCreditNative=evaluated?num(row.net_opening_cash_flow_native):null;
  const toUsd=(v:number|null)=>v!==null&&entryIndex!==null?v*entryIndex:null;

  const pnlAtInvalidationRaw=pnlAt(outcomes,candidateId,scenario,"invalidation");
  // An invalidation outside the structure's life is not an outcome it lived
  // through, so it is never treated as one.
  const pnlAtInvalidationUsd=challenge.invalidatedInWindow===true?pnlAtInvalidationRaw:null;
  const pnlAtSettlementUsd=pnlAt(outcomes,candidateId,scenario,"settlement");
  const realizedPnlUsd=challenge.invalidatedInWindow===true?pnlAtInvalidationUsd:pnlAtSettlementUsd;

  const boundaryMs=challenge.invalidatedInWindow===true&&invalidationMs!==null
   ?Math.min(invalidationMs,expiryTimestampMs??invalidationMs)
   :expiryTimestampMs;
  const adverse=adversePath(valuations,candidateId,scenario,evaluated,structureEntryMs,boundaryMs);

  // Exit policy is uniform across a canonical bundle -- one outcome set is
  // exported for every structure -- so it is a constant in the key rather than
  // a dimension read from a field that does not exist.
  const matchKey=[eventId,expiryTimestampMs??"unknown-expiry",widthUsd??"unknown-width",
   structureType??"unknown-structure",optionType??"unknown-type",scenario??"unknown-scenario","canonical-exit-policy"].join("|");

  return {
   eventId,candidateId,structureExecutionId:str(row.structure_execution_id)??`${candidateId}~${scenario??"unknown"}`,
   executionScenario:scenario,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
   strikeMethod,rawStrikeMethod,direction,optionType,structureType,widthUsd,
   expiryTimestampMs,actualDteDays,structureEntryMs,matchKey,
   geometry,challenge,
   grossCreditNative,netCreditNative,
   grossCreditUsd:toUsd(grossCreditNative),netCreditUsd:toUsd(netCreditNative),
   pnlAtInvalidationUsd,pnlAtSettlementUsd,realizedPnlUsd,
   adverse,worstAdverseUsd:adverse.worstAdverseUsd,maeUsd:adverse.maeBeforeProfitUsd,
  } satisfies ShortStrikeStructure;
 });
}
