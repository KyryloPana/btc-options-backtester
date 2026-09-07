import type {AnalysisDataset} from "../research-analysis.ts";
import {adversePath,referenceAdversePath,type AdversePathObservation} from "../adverse-path.ts";
import {challengeOf,type ChallengeObservation} from "../strike-challenge.ts";
import {calculateDeliveryFee,calculateOptionFee,STANDARD_INVERSE_BTC_OPTION_FEE} from "../accounting.ts";
import {breakEven,intrinsicBtc,payoffExtrema,type ExpiryPayoffInput} from "../expiry-payoff.ts";
import {indexByCandidate,readCanonicalStructuralLoss,type StructuralLossReading,type StructuralLossSettlementFees,type StructuralLossSource} from "../canonical-structural-loss.ts";
import type {OptionType} from "../backtester.ts";
import {normalizeExecutionScenarioStatus,type ExecutionScenarioStatus} from "../execution-scenario.ts";

/**
 * Canonical research bundle -> normalized spread-width structures.
 *
 * SCOPE. This module analyses HOW MUCH PROTECTIVE WIDTH the structure carries
 * and nothing else. The short strike is held constant inside every comparison
 * rather than re-optimized here: the short strike decides where risk begins,
 * width decides how much tail exposure is retained and how much protection is
 * purchased. Short-strike placement is a separate report.
 *
 * ACTUAL WIDTH IS THE ECONOMIC VARIABLE. Historical strike availability often
 * forces the protective long onto a strike other than the one requested, so
 * every payoff, credit ratio and capital figure is computed from the ACTUAL
 * contracts. The requested width is retained beside it purely for audit, and
 * is never substituted into an economic calculation.
 *
 * STRUCTURAL RISK IS CONSUMED, NOT RECOMPUTED. The report's canonical risk
 * figure is the BOUNDED MAXIMUM STRUCTURAL LOSS already exported by the research
 * bundle, read through the single canonical adapter. This module previously
 * derived its own fee-inclusive "maximum economic loss" from payoffExtrema and a
 * Number.MAX_SAFE_INTEGER tail sample; for a bear call that turned a fixed BTC
 * delivery fee into an unbounded USD figure. It no longer defines risk at all.
 *
 * SETTLEMENT FEES REMAIN REAL AND REMAIN SEPARATE. Delivery fees are reported at
 * an explicitly named settlement scenario, and whether a finite GLOBAL
 * fee-inclusive maximum exists at all is stated rather than assumed.
 *
 * THE PAYOFF PRIMITIVES ARE STILL USED for what they legitimately answer:
 * scenario payoff, breakeven, maximum profit and the protective-long
 * counterfactual. They no longer define the report's canonical structural risk.
 */

export type ExecutionScenario="maker"|"taker";
export const WIDTH_EXIT_POLICY="thesis_exit_v1" as const;
export type {ExecutionScenarioStatus} from "../execution-scenario.ts";
export type UnavailableReason=string;

/** A figure plus, when it is missing, the reason it is missing. */
export interface Availability<T> {readonly value:T|null;readonly reason:UnavailableReason|null}
const has=<T,>(value:T):Availability<T>=>({value,reason:null});
const missing=<T,>(reason:UnavailableReason):Availability<T>=>({value:null,reason});

export interface WidthIdentity {
 /** The width originally asked for. Audit only -- never used in an economic calculation. */
 readonly requestedWidthUsd:number|null;
 /** The width the historical strikes actually produced. Drives every economic figure. */
 readonly actualWidthUsd:number|null;
 /** True when strike availability forced the protective long away from the requested strike. */
 readonly widthSubstituted:boolean;
 readonly shortStrike:number|null;
 readonly longStrike:number|null;
 readonly requestedLongStrike:number|null;
}

export interface EntryEconomics {
 readonly grossCreditBtc:number|null;
 readonly openingFeesBtc:number|null;
 readonly netCreditBtc:number|null;
 readonly grossCreditUsd:number|null;
 readonly netCreditUsd:number|null;
 readonly shortPremiumBtc:number|null;
 readonly longPremiumBtc:number|null;
 /** Protective-long cost as a share of the premium the short leg brought in. */
 readonly longLegCostShareOfShortPremium:number|null;
 readonly creditPerRequestedWidth:number|null;
 readonly creditPerActualWidth:number|null;
 /** Net credit divided by the canonical bounded structural loss, not by width. */
 readonly creditPerStructuralLoss:number|null;
 /** Opening plus an estimated closing round trip, from the same canonical fee schedule. */
 readonly estimatedRoundTripFeesBtc:number|null;
 readonly feeDragOnOpening:number|null;
 readonly feeDragRoundTrip:number|null;
}

export interface PayoffFacts {
 /**
  * The CANONICAL bounded maximum structural loss, in USD, as a positive
  * magnitude. Consumed from the exported research bundle; never recomputed here
  * and never fee-inclusive.
  */
 readonly maximumStructuralLossUsd:Availability<number>;
 /** The same loss in BTC at the canonical reference index. Not a tail extremum. */
 readonly maximumStructuralLossBtc:Availability<number>;
 /** Which canonical source the structural loss came from. */
 readonly structuralLossSource:StructuralLossSource|null;
 readonly structuralLossMethodVersion:string|null;
 /** True when structure_economics and margin_scenarios both carried it and agreed. */
 readonly structuralLossReconciled:boolean;
 /** Settlement index at which the bounded structural maximum is attained. */
 readonly structuralLossSettlementIndex:number|null;
 /**
  * Delivery fees are real and are kept separate: scenario-specific, plus an
  * explicit statement of whether a finite GLOBAL fee-inclusive maximum exists.
  */
 readonly settlementFees:StructuralLossSettlementFees|null;
 /** Scenario-specific settlement fees at the structural-loss settlement index. */
 readonly settlementFeesAtStructuralLossBtc:number|null;
 /** Scenario quantities from the payoff primitives, which remain legitimate. */
 readonly maxProfitUsd:Availability<number>;
 readonly breakEvenIndex:Availability<number>;
}

/**
 * The protective long evaluated as insurance: the identical short option, entry
 * timing, execution scenario and settlement index, with ONLY the long-leg
 * contribution removed. It is not a separate naked backtest with its own
 * assumptions -- the same canonical premiums, fee schedule and payoff
 * primitives produce both sides.
 */
export interface ProtectionFacts {
 readonly longLegPremiumBtc:number|null;
 readonly longLegPremiumUsd:number|null;
 /** Extra opening fee incurred purely by carrying the second leg. */
 readonly extraOpeningFeeBtc:number|null;
 readonly totalProtectionCostUsd:number|null;
 /** Audit-only activation boundary: gross intrinsic contribution is zero at K_long. */
 readonly benefitAtLongStrikeUsd:Availability<number>;
 /** The same comparison at a stated deep-tail reference index. */
 readonly benefitAtDeepTailUsd:Availability<number>;
 readonly deepTailIndex:number|null;
 /** Whether the naked short's terminal loss is unbounded in the USD basis used by this report. */
 readonly nakedUsdTailUnbounded:boolean|null;
 readonly netProtectionValueUsd:number|null;
}

/**
 * Three capital concepts that are never collapsed into one number.
 *
 * Maximum STRUCTURAL loss is an ECONOMIC property of the structure and is
 * consumed from the canonical export. Incremental initial margin and peak margin
 * are properties of the ACCOUNT -- they depend on Deribit's margin model,
 * standard versus portfolio margin and segregated versus cross collateral. When
 * the canonical margin scenario does not report them they stay Unavailable; the
 * protective-leg cost, the width and the structural loss are never substituted
 * for a margin figure. Structural loss is not IM and not MM.
 */
export interface CapitalFacts {
 readonly maximumStructuralLossUsd:Availability<number>;
 readonly incrementalInitialMarginUsd:Availability<number>;
 readonly peakMarginUsd:Availability<number>;
 readonly marginModel:string|null;
 readonly accountConfiguration:string|null;
 readonly returnOnStructuralLoss:Availability<number>;
 readonly returnOnOpeningMargin:Availability<number>;
 readonly returnOnPeakCapital:Availability<number>;
}

export interface WidthStructure {
 readonly eventId:string;
 readonly candidateId:string;
 readonly structureExecutionId:string;
 readonly executionScenario:ExecutionScenario|null;
 readonly analyticsTrack:"reference"|"immediate_maker"|"immediate_taker"|null;
 readonly executionScenarioStatus:ExecutionScenarioStatus|null;
 readonly executionScenarioReason:string|null;
 readonly executionScenarioLegacyUndifferentiated:boolean;
 readonly direction:"long"|"short"|null;
 readonly optionType:OptionType|null;
 readonly structureType:string|null;
 readonly expiryTimestampMs:number|null;
 readonly actualDteDays:number|null;
 readonly structureEntryMs:number|null;
 readonly quantity:number|null;
 readonly entryIndex:number|null;
 /** Event, expiry, DTE, SHORT STRIKE, option/structure and exit policy. Only width differs. */
 readonly matchKey:string;

 readonly identity:WidthIdentity;
 readonly entry:EntryEconomics;
 readonly payoff:PayoffFacts;
 readonly protection:ProtectionFacts;
 readonly capital:CapitalFacts;
 readonly challenge:ChallengeObservation;
 readonly adverse:AdversePathObservation;

 readonly pnlAtVpocUsd:number|null;
 readonly pnlAtInvalidationUsd:number|null;
 readonly pnlAtSettlementUsd:number|null;
 readonly realizedPnlUsd:number|null;
 readonly resolution:"vpoc"|"invalidation"|"settlement"|"ambiguous_resolution_order"|"unresolved";
 readonly resolutionReason:string|null;
 readonly worstAdverseUsd:number|null;
 readonly maeUsd:number|null;
 /** Time from event entry to first resolution, for the slow-resolution cohorts. */
 readonly timeToResolutionDays:number|null;
}

const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const ms=(v:unknown):number|null=>{const s=str(v);if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null};
const nested=(v:unknown,...keys:string[]):unknown=>keys.reduce<unknown>((acc,key)=>acc&&typeof acc==="object"&&!Array.isArray(acc)?(acc as Record<string,unknown>)[key]:undefined,v);
const scenarioOf=(v:unknown):ExecutionScenario|null=>{const s=str(v);return s==="maker"||s==="taker"?s:null};
const scenarioStatusOf=normalizeExecutionScenarioStatus;
const optionTypeOf=(v:unknown):OptionType|null=>{const s=str(v);return s==="C"||s==="P"?s:null};
const DAY=864e5;
// calculateOptionFee retains an execution-mode parameter for ledger provenance,
// but the standard option schedule is mode-invariant. This local constant is a
// calculator adapter only and is never written into analytical-track identity.
const CANONICAL_FEE_CALCULATION_MODE:ExecutionScenario="maker";

const MARGIN_UNAVAILABLE="The canonical margin scenario does not report this figure. Deribit's requirement depends on the account model -- standard versus portfolio margin, segregated versus cross collateral -- so it is left Unavailable rather than approximated from the protective-leg cost, the width or the maximum structural loss.";

/** The exact payoff input, or null when a canonical field the payoff needs is absent. */
function payoffInputOf(s:{optionType:OptionType|null;shortStrike:number|null;longStrike:number|null;
 shortPremiumBtc:number|null;longPremiumBtc:number|null;entryIndex:number|null;quantity:number|null;
 openingFeesBtc:number|null;expiryTimestampMs:number|null}):ExpiryPayoffInput|null{
 if(s.optionType===null||s.shortStrike===null||s.longStrike===null)return null;
 if(s.shortPremiumBtc===null||s.longPremiumBtc===null)return null;
 if(s.entryIndex===null||s.entryIndex<=0||s.quantity===null||s.quantity<=0)return null;
 if(s.openingFeesBtc===null||s.openingFeesBtc<0||s.expiryTimestampMs===null)return null;
 return {optionType:s.optionType,shortStrike:s.shortStrike,longStrike:s.longStrike,
  shortEntryPremiumBtc:s.shortPremiumBtc,longEntryPremiumBtc:s.longPremiumBtc,
  entryIndex:s.entryIndex,amount:s.quantity,openingFeesBtc:s.openingFeesBtc,expiryTimestamp:s.expiryTimestampMs};
}

/**
 * Structural risk comes from the canonical reading. Maximum profit and breakeven
 * are scenario quantities and still come from the payoff primitives, which is a
 * legitimate use of them: neither is a risk definition.
 */
function payoffFactsOf(input:ExpiryPayoffInput|null,loss:StructuralLossReading):PayoffFacts{
 const structural={
  maximumStructuralLossUsd:loss.status==="available"&&loss.usd!==null?has(loss.usd):missing<number>(loss.reason??"The canonical maximum structural loss is unavailable for this structure."),
  maximumStructuralLossBtc:loss.status==="available"&&loss.btc!==null?has(loss.btc):missing<number>(loss.reason??"The canonical maximum structural loss is unavailable for this structure."),
  structuralLossSource:loss.source,structuralLossMethodVersion:loss.methodVersion,
  structuralLossReconciled:loss.reconciled,structuralLossSettlementIndex:loss.settlementIndex,
  settlementFees:loss.settlementFees,
  settlementFeesAtStructuralLossBtc:loss.settlementFees?.scenarioDeliveryFeesBtc??null,
 } as const;
 if(!input)return {...structural,
  maxProfitUsd:missing("A canonical premium, strike, entry index, quantity or opening-fee field is absent, so the exact inverse payoff cannot be evaluated."),
  breakEvenIndex:missing("Same missing canonical payoff inputs.")};
 try{
  const usd=payoffExtrema(input,"usd-cash-flow");
  const be=breakEven(input,"usd-cash-flow");
  return {...structural,
   maxProfitUsd:has(usd.maximumProfit),
   breakEvenIndex:be?has(be.index):missing("The canonical net payoff does not cross zero inside the sampled settlement range."),
  };
 }catch(error){
  const reason=`The canonical strikes and premiums do not form a valid credit spread: ${error instanceof Error?error.message:String(error)}`;
  return {...structural,maxProfitUsd:missing(reason),breakEvenIndex:missing(reason)};
 }
}

function protectionFactsOf(input:ExpiryPayoffInput|null):ProtectionFacts{
 const empty={longLegPremiumBtc:null,longLegPremiumUsd:null,extraOpeningFeeBtc:null,totalProtectionCostUsd:null,
  deepTailIndex:null,nakedUsdTailUnbounded:null,netProtectionValueUsd:null} as const;
 if(!input)return {...empty,
  benefitAtLongStrikeUsd:missing("The exact canonical payoff inputs are absent, so gross protection cannot be priced."),
  benefitAtDeepTailUsd:missing("Same missing payoff inputs.")};
 const amount=Math.abs(input.amount);
 const longLegPremiumBtc=input.longEntryPremiumBtc*amount;
 const bothLegFees=input.openingFeesBtc;
 // Fee rates are side/scenario invariant under the canonical schedule.  For
 // Reference this invocation is only a fee calculation, never fill evidence.
 const shortOnlyFee=calculateOptionFee(input.shortEntryPremiumBtc,amount,CANONICAL_FEE_CALCULATION_MODE,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee;
 // A short put spread's tail lies below the strikes; a call spread's above.
 const deepTailIndex=input.optionType==="P"?Math.max(1,input.longStrike*.5):input.longStrike*2;
 // Gross benefit is the terminal loss reduction supplied by the long before
 // its purchase cash flow.  Do not subtract two lifetime PnLs: that would
 // already include premium/fees and make Net subtract the cost twice.
 const benefit=(index:number)=>{
  const intrinsic=intrinsicBtc(input.optionType,input.longStrike,index);
  const deliveryFee=calculateDeliveryFee(intrinsic,amount,input.dailyOption??false).finalFeeBtc;
  return (intrinsic*amount-deliveryFee)*index;
 };
 const atLongStrike=benefit(input.longStrike),atDeepTail=benefit(deepTailIndex);
 const totalProtectionCostUsd=(longLegPremiumBtc+Math.max(0,bothLegFees-shortOnlyFee))*input.entryIndex;
 return {
  longLegPremiumBtc,longLegPremiumUsd:longLegPremiumBtc*input.entryIndex,
  extraOpeningFeeBtc:Math.max(0,bothLegFees-shortOnlyFee),
  totalProtectionCostUsd,
  benefitAtLongStrikeUsd:has(atLongStrike),benefitAtDeepTailUsd:has(atDeepTail),
  deepTailIndex,nakedUsdTailUnbounded:input.optionType==="C",
  netProtectionValueUsd:atDeepTail-totalProtectionCostUsd,
 };
}

function capitalFactsOf(payoff:PayoffFacts,marginRow:Readonly<Record<string,unknown>>|undefined,realizedPnlUsd:number|null,entryIndex:number|null):CapitalFacts{
 const available=marginRow?.margin_status==="available";
 const toUsd=(v:number|null)=>v===null?null:entryIndex===null?null:v*entryIndex;
 const incremental=available?num(marginRow?.incremental_initial_margin):null;
 const peak=available?num(marginRow?.peak_initial_margin)??num(marginRow?.peak_maintenance_margin):null;
 const incrementalUsd=incremental===null?null:toUsd(incremental);
 const peakUsd=peak===null?null:toUsd(peak);
 const ratio=(denominator:number|null,reason:UnavailableReason):Availability<number>=>{
  if(realizedPnlUsd===null)return missing("No realized PnL was priced for this structure and scenario, so no return can be formed.");
  if(denominator===null)return missing(reason);
  if(denominator===0)return missing("The denominator is zero, so the ratio is undefined.");
  return has(realizedPnlUsd/Math.abs(denominator));
 };
 return {
  maximumStructuralLossUsd:payoff.maximumStructuralLossUsd,
  incrementalInitialMarginUsd:incrementalUsd===null?missing(MARGIN_UNAVAILABLE):has(incrementalUsd),
  peakMarginUsd:peakUsd===null?missing(MARGIN_UNAVAILABLE):has(peakUsd),
  marginModel:str(marginRow?.margin_model),accountConfiguration:str(marginRow?.account_configuration),
  returnOnStructuralLoss:ratio(payoff.maximumStructuralLossUsd.value,payoff.maximumStructuralLossUsd.reason??MARGIN_UNAVAILABLE),
  returnOnOpeningMargin:ratio(incrementalUsd,MARGIN_UNAVAILABLE),
  returnOnPeakCapital:ratio(peakUsd,MARGIN_UNAVAILABLE),
 };
}

function outcomeOf(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,reference:boolean,kind:"vpoc"|"invalidation"|"settlement"){
 return outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===kind&&
  (reference?(o.analytics_track===undefined||o.analytics_track==="reference"):o.analytics_track!=="reference"));
}
function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,reference:boolean,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 const row=outcomeOf(outcomes,candidateId,scenario,reference,kind);
 if(!row||row.status!=="priced")return null;
 const usd=num(row.net_pnl_usd);if(usd!==null)return usd;
 const native=num(row.net_pnl_native),index=num(row.conversion_index)??num(row.target_index);
 return native!==null&&index!==null&&index>0?native*index:null;
}

function outcomeTimestamp(row:Readonly<Record<string,unknown>>|undefined):number|null{
 return ms(row?.trigger_timestamp_utc)??ms(row?.decision_available_timestamp_utc)??ms(row?.decision_timestamp_utc)??ms(row?.valuation_timestamp_utc);
}

export function normalizeWidthStructures(dataset:AnalysisDataset):readonly WidthStructure[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],
  valuations=dataset.tables.valuations??[],events=dataset.tables.events??[],
  paths=dataset.tables.underlying_path??[],margins=dataset.tables.margin_scenarios??[];
 // Canonical structural risk is READ, never recomputed. structure_economics is
 // primary; margin_scenarios is the reconciliation source.
 const economicsByCandidate=indexByCandidate(dataset.tables.structure_economics),
  marginByCandidate=indexByCandidate(margins);
 const eventById=new Map(events.map(e=>[str(e.event_id)??"",e]));
 const pathByEvent=new Map<string,Readonly<Record<string,unknown>>[]>();
 for(const row of paths){const id=str(row.event_id);if(!id)continue;const list=pathByEvent.get(id);if(list)list.push(row);else pathByEvent.set(id,[row])}

 return candidates.map(row=>{
  const eventId=str(row.event_id)??"unknown-event",candidateId=str(row.candidate_id)??"unknown-candidate";
  const scenario=scenarioOf(row.execution_scenario),scenarioStatus=scenarioStatusOf(row.execution_scenario_status);
  const reference=row.analytics_track==="reference";
  const evaluated=scenarioStatus==="evaluated";
  const event=eventById.get(eventId);
  const directionRaw=str(row.direction)??str(event?.direction);
  const direction=directionRaw==="long"||directionRaw==="short"?directionRaw:null;
  const optionType=optionTypeOf(row.option_type);

  const shortStrike=num(nested(row.actual_strikes,"short")),longStrike=num(nested(row.actual_strikes,"long"));
  const actualWidthUsd=num(nested(row.actual_strikes,"width"))
   ??(shortStrike!==null&&longStrike!==null?Math.abs(shortStrike-longStrike):null);
  const requestedWidthUsd=num(nested(row.requested_strikes,"width"));
  const requestedLongStrike=num(nested(row.requested_strikes,"long"));
  const identity:WidthIdentity={requestedWidthUsd,actualWidthUsd,
   widthSubstituted:requestedWidthUsd!==null&&actualWidthUsd!==null&&requestedWidthUsd!==actualWidthUsd,
   shortStrike,longStrike,requestedLongStrike};

  const expiryTimestampMs=ms(row.expiry_timestamp_utc);
  const structureEntryMs=ms(row.structure_entry_timestamp_utc)??ms(row.valuation_timestamp_utc);
  const actualDteDays=num(row.actual_dte)??num(row.actual_dte_days);
  const quantity=num(row.quantity);
  const entryIndex=num(row.entry_index_price)??num(event?.entry_price);
  const shortPremiumBtc=evaluated?num(nested(row.entry_legs,"short","price_native")):null;
  const longPremiumBtc=evaluated?num(nested(row.entry_legs,"long","price_native")):null;
  const openingFeesBtc=evaluated?num(row.opening_fees_native):null;
  const grossCreditBtc=evaluated?num(row.gross_credit_debit_native):null;
  const netCreditBtc=evaluated?num(row.net_opening_cash_flow_native):null;

  const input=payoffInputOf({optionType,shortStrike,longStrike,shortPremiumBtc,longPremiumBtc,entryIndex,quantity,openingFeesBtc,expiryTimestampMs});
  const structuralLoss=readCanonicalStructuralLoss({
   economics:economicsByCandidate.get(candidateId),
   margin:marginByCandidate.get(candidateId),
   fallback:input,
  });
  const payoff=payoffFactsOf(input,structuralLoss);
  const protection=protectionFactsOf(input);

  const toUsd=(v:number|null)=>v!==null&&entryIndex!==null?v*entryIndex:null;
  // A round trip is four legs: two opened and two closed. The closing pair is
  // estimated with the SAME canonical fee schedule applied to the entry
  // premiums -- an explicit estimate, never presented as a recorded fee.
  // The standard option fee schedule is execution-mode invariant. The local
  // adapter constant satisfies the calculator signature and remains separate from
  // this structure's evidence identity, so Reference remains null-scenario and
  // this entry-price closing pair remains an estimate rather than fill evidence.
  const estimatedClosingFeesBtc=input
   ?calculateOptionFee(input.shortEntryPremiumBtc,Math.abs(input.amount),CANONICAL_FEE_CALCULATION_MODE,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee
    +calculateOptionFee(input.longEntryPremiumBtc,Math.abs(input.amount),CANONICAL_FEE_CALCULATION_MODE,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee
   :null;
  const estimatedRoundTripFeesBtc=openingFeesBtc!==null&&estimatedClosingFeesBtc!==null?openingFeesBtc+estimatedClosingFeesBtc:null;
  const entry:EntryEconomics={
   grossCreditBtc,openingFeesBtc,netCreditBtc,
   grossCreditUsd:toUsd(grossCreditBtc),netCreditUsd:toUsd(netCreditBtc),
   shortPremiumBtc,longPremiumBtc,
   longLegCostShareOfShortPremium:shortPremiumBtc!==null&&longPremiumBtc!==null&&shortPremiumBtc>0?longPremiumBtc/shortPremiumBtc:null,
   creditPerRequestedWidth:netCreditBtc!==null&&requestedWidthUsd!==null&&requestedWidthUsd>0&&entryIndex!==null
    ?netCreditBtc*entryIndex/requestedWidthUsd:null,
   creditPerActualWidth:netCreditBtc!==null&&actualWidthUsd!==null&&actualWidthUsd>0&&entryIndex!==null
    ?netCreditBtc*entryIndex/actualWidthUsd:null,
   creditPerStructuralLoss:netCreditBtc!==null&&payoff.maximumStructuralLossUsd.value!==null&&payoff.maximumStructuralLossUsd.value!==0&&entryIndex!==null
    ?netCreditBtc*entryIndex/Math.abs(payoff.maximumStructuralLossUsd.value):null,
   estimatedRoundTripFeesBtc,
   feeDragOnOpening:openingFeesBtc!==null&&grossCreditBtc!==null&&grossCreditBtc>0?openingFeesBtc/grossCreditBtc:null,
   feeDragRoundTrip:estimatedRoundTripFeesBtc!==null&&grossCreditBtc!==null&&grossCreditBtc>0?estimatedRoundTripFeesBtc/grossCreditBtc:null,
  };

  const invalidationMs=ms(event?.invalidation_decision_timestamp_utc);
  const endpoint=(kind:"vpoc"|"invalidation")=>{
   const o=outcomeOf(outcomes,candidateId,scenario,reference,kind),trigger=str(o?.trigger_status);
   if(o&&trigger!==null&&trigger!=="reached")return {time:trigger==="ambiguous"?outcomeTimestamp(o):null,ambiguous:trigger==="ambiguous"};
   return {time:outcomeTimestamp(o)??(kind==="vpoc"?ms(event?.vpoc_decision_timestamp_utc)??ms(event?.vpoc_trigger_timestamp_utc):invalidationMs),ambiguous:false};
  };
  const vpoc=endpoint("vpoc"),invalidation=endpoint("invalidation");
  const inWindow=(t:number|null)=>t!==null&&structureEntryMs!==null&&t>=structureEntryMs&&(expiryTimestampMs===null||t<=expiryTimestampMs);
  const vpocInWindow=inWindow(vpoc.time),invalidationInWindow=inWindow(invalidation.time);
  const ambiguousResolution=vpoc.ambiguous||invalidation.ambiguous||(vpocInWindow&&invalidationInWindow&&vpoc.time===invalidation.time);
  const firstVpoc=vpocInWindow&&(!invalidationInWindow||vpoc.time!<invalidation.time!);
  const firstInvalidation=invalidationInWindow&&(!vpocInWindow||invalidation.time!<vpoc.time!);
  // Operational endpoint metrics are symmetric: only the first causal Thesis
  // Exit exists for the position. Later canonical outcomes remain in the
  // bundle but do not populate this operational report.
  const pnlAtVpocUsd=firstVpoc?pnlAt(outcomes,candidateId,scenario,reference,"vpoc"):null;
  // Operational Thesis Exit only: an invalidation after VPOC belongs to a
  // counterfactual post-exit path and must not enter this report's endpoint.
  const pnlAtInvalidationUsd=firstInvalidation?pnlAt(outcomes,candidateId,scenario,reference,"invalidation"):null;
  const pnlAtSettlementUsd=pnlAt(outcomes,candidateId,scenario,reference,"settlement");
  const realizedPnlUsd=ambiguousResolution?null:firstVpoc?pnlAtVpocUsd:firstInvalidation?pnlAtInvalidationUsd:(!vpocInWindow&&!invalidationInWindow?pnlAtSettlementUsd:null);
  const resolution=ambiguousResolution?"ambiguous_resolution_order" as const:firstVpoc?"vpoc" as const:firstInvalidation?"invalidation" as const:!vpocInWindow&&!invalidationInWindow?"settlement" as const:"unresolved" as const;
  const resolutionReason=ambiguousResolution?"VPOC and invalidation share the same available timestamp precision; causal order is ambiguous under thesis_exit_v1, so realized PnL is unavailable.":realizedPnlUsd===null?"The causal thesis_exit_v1 outcome was reached but has no priced canonical USD PnL.":null;
  const resolutionMs=firstVpoc?vpoc.time:firstInvalidation?invalidation.time:null;
  const ambiguousBoundaryMs=ambiguousResolution?[vpoc.time,invalidation.time].filter((x):x is number=>x!==null).sort((a,b)=>a-b)[0]??null:null;
  const firstResolutionMs=resolutionMs??ambiguousBoundaryMs;
  const boundaryMs=firstResolutionMs??expiryTimestampMs;
  const challenge=challengeOf(pathByEvent.get(eventId)??[],shortStrike,direction,structureEntryMs,boundaryMs,invalidationMs,firstResolutionMs);
  const adverse=reference?referenceAdversePath(valuations,candidateId,structureEntryMs,boundaryMs):adversePath(valuations,candidateId,scenario,evaluated,structureEntryMs,boundaryMs);

  const marginRow=margins.find(m=>m.candidate_id===candidateId);
  const capital=capitalFactsOf(payoff,marginRow,realizedPnlUsd,entryIndex);

  // First-resolution time, for the canonical slow-resolution cohorts.
  const eventEntry=ms(event?.entry_timestamp_utc);
  const timeToResolutionDays=firstResolutionMs===null||eventEntry===null?null:(firstResolutionMs-eventEntry)/DAY;

  // The short strike is part of the key: comparing widths across different
  // short strikes would attribute a placement difference to width.
  const matchKey=[eventId,expiryTimestampMs??"unknown-expiry",actualDteDays??"unknown-dte",shortStrike??"unknown-short",
   str(row.structure_type)??"unknown-structure",optionType??"unknown-type",WIDTH_EXIT_POLICY].join("|");

  return {
   eventId,candidateId,structureExecutionId:str(row.structure_execution_id)??`${candidateId}~${scenario??"unknown"}`,
   executionScenario:scenario,analyticsTrack:reference?"reference":scenario==="maker"?"immediate_maker":scenario==="taker"?"immediate_taker":null,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
   executionScenarioLegacyUndifferentiated:row.execution_scenario_legacy_undifferentiated===true,
   direction,optionType,structureType:str(row.structure_type),
   expiryTimestampMs,actualDteDays,structureEntryMs,quantity,entryIndex,matchKey,
   identity,entry,payoff,protection,capital,challenge,adverse,
   pnlAtVpocUsd,pnlAtInvalidationUsd,pnlAtSettlementUsd,realizedPnlUsd,resolution,resolutionReason,
   worstAdverseUsd:adverse.worstAdverseUsd,maeUsd:adverse.maeBeforeProfitUsd,
   timeToResolutionDays,
  } satisfies WidthStructure;
 });
}
