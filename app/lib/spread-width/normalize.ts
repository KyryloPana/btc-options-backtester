import type {AnalysisDataset} from "../research-analysis.ts";
import {adversePath,type AdversePathObservation} from "../adverse-path.ts";
import {challengeOf,type ChallengeObservation} from "../strike-challenge.ts";
import {calculateDeliveryFee,calculateOptionFee,STANDARD_INVERSE_BTC_OPTION_FEE} from "../accounting.ts";
import {breakEven,expiryPayoff,intrinsicBtc,payoffExtrema,type ExpiryPayoffInput} from "../expiry-payoff.ts";
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
 * PAYOFF. Maximum economic loss is NOT modelled as width minus credit. These
 * are inverse BTC options: the payoff is non-linear in the settlement index,
 * settlement fees apply per leg, and the USD result depends on the settlement
 * price as well as the entry index. Every payoff figure therefore comes from
 * the application's authoritative expiry-payoff utility rather than a
 * competing formula written here.
 */

export type ExecutionScenario="maker"|"taker";
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
 /** Net credit divided by the exact maximum economic loss, not by width. */
 readonly creditPerMaxEconomicLoss:number|null;
 /** Opening plus an estimated closing round trip, from the same canonical fee schedule. */
 readonly estimatedRoundTripFeesBtc:number|null;
 readonly feeDragOnOpening:number|null;
 readonly feeDragRoundTrip:number|null;
}

export interface PayoffFacts {
 /** Exact maximum economic loss from the authoritative inverse payoff, in USD cash-flow terms. */
 readonly maxEconomicLossUsd:Availability<number>;
 readonly maxEconomicLossBtc:Availability<number>;
 readonly maxProfitUsd:Availability<number>;
 readonly breakEvenIndex:Availability<number>;
 /** The settlement index at which the maximum loss is realised. */
 readonly maxLossIndex:number|null;
 readonly settlementFeesAtMaxLossBtc:number|null;
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
 /** Spread PnL minus naked-short PnL at the long strike, where protection first bites. */
 readonly benefitAtLongStrikeUsd:Availability<number>;
 /** The same comparison at a stated deep-tail reference index. */
 readonly benefitAtDeepTailUsd:Availability<number>;
 readonly deepTailIndex:number|null;
 /** An unprotected inverse short has no finite worst case; the long leg is what bounds it. */
 readonly nakedTailUnbounded:boolean;
 readonly netProtectionValueUsd:number|null;
}

/**
 * Three capital concepts that are never collapsed into one number.
 *
 * Maximum economic loss is a property of the PAYOFF and is computable here.
 * Incremental initial margin and peak margin are properties of the ACCOUNT --
 * they depend on Deribit's margin model, standard versus portfolio margin and
 * segregated versus cross collateral. When the canonical margin scenario does
 * not report them they stay Unavailable; the protective-leg cost, the width and
 * the maximum loss are never substituted for a margin figure.
 */
export interface CapitalFacts {
 readonly maxEconomicLossUsd:Availability<number>;
 readonly incrementalInitialMarginUsd:Availability<number>;
 readonly peakMarginUsd:Availability<number>;
 readonly marginModel:string|null;
 readonly accountConfiguration:string|null;
 readonly returnOnMaxLoss:Availability<number>;
 readonly returnOnOpeningMargin:Availability<number>;
 readonly returnOnPeakCapital:Availability<number>;
}

export interface WidthStructure {
 readonly eventId:string;
 readonly candidateId:string;
 readonly structureExecutionId:string;
 readonly executionScenario:ExecutionScenario|null;
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

const MARGIN_UNAVAILABLE="The canonical margin scenario does not report this figure. Deribit's requirement depends on the account model -- standard versus portfolio margin, segregated versus cross collateral -- so it is left Unavailable rather than approximated from the protective-leg cost, the width or the maximum economic loss.";

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
 * The same position with the protective long removed, priced through the same
 * primitives the spread uses: canonical short premium, the canonical fee
 * schedule for a single opening leg, inverse intrinsic at settlement and the
 * canonical delivery fee. Nothing else about the position changes.
 */
function nakedShortPnlUsd(input:ExpiryPayoffInput,scenario:ExecutionScenario,settlementIndex:number):number{
 const amount=Math.abs(input.amount);
 const openingFee=calculateOptionFee(input.shortEntryPremiumBtc,amount,scenario,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee;
 const netEntryBtc=input.shortEntryPremiumBtc*amount-openingFee;
 const shortIntrinsic=intrinsicBtc(input.optionType,input.shortStrike,settlementIndex);
 const settlementFee=calculateDeliveryFee(shortIntrinsic,amount,input.dailyOption??false).finalFeeBtc;
 const netPositionBtc=-shortIntrinsic*amount-settlementFee;
 return netEntryBtc*input.entryIndex+netPositionBtc*settlementIndex;
}

function payoffFactsOf(input:ExpiryPayoffInput|null):PayoffFacts{
 if(!input)return {
  maxEconomicLossUsd:missing("A canonical premium, strike, entry index, quantity or opening-fee field is absent, so the exact inverse payoff cannot be evaluated."),
  maxEconomicLossBtc:missing("Same missing canonical payoff inputs."),
  maxProfitUsd:missing("Same missing canonical payoff inputs."),
  breakEvenIndex:missing("Same missing canonical payoff inputs."),
  maxLossIndex:null,settlementFeesAtMaxLossBtc:null,
 };
 try{
  const usd=payoffExtrema(input,"usd-cash-flow"),btc=payoffExtrema(input,"btc-settlement");
  // The loss extreme is realised at whichever tested settlement index produces
  // it; the payoff utility samples the strikes and both tails.
  const epsilon=Math.min(input.shortStrike,input.longStrike)*1e-9;
  const candidateIndices=[epsilon,input.shortStrike,input.longStrike,Number.MAX_SAFE_INTEGER];
  let maxLossIndex=candidateIndices[0]!,worst=Infinity;
  for(const index of candidateIndices){const pnl=expiryPayoff(input,index,"usd-cash-flow").pnl;if(pnl<worst){worst=pnl;maxLossIndex=index}}
  const at=expiryPayoff(input,maxLossIndex,"usd-cash-flow");
  const be=breakEven(input,"usd-cash-flow");
  return {
   maxEconomicLossUsd:has(usd.maximumLoss),maxEconomicLossBtc:has(btc.maximumLoss),
   maxProfitUsd:has(usd.maximumProfit),
   breakEvenIndex:be?has(be.index):missing("The canonical net payoff does not cross zero inside the sampled settlement range."),
   maxLossIndex,settlementFeesAtMaxLossBtc:at.settlementFeesBtc,
  };
 }catch(error){
  const reason=`The canonical strikes and premiums do not form a valid credit spread: ${error instanceof Error?error.message:String(error)}`;
  return {maxEconomicLossUsd:missing(reason),maxEconomicLossBtc:missing(reason),maxProfitUsd:missing(reason),
   breakEvenIndex:missing(reason),maxLossIndex:null,settlementFeesAtMaxLossBtc:null};
 }
}

function protectionFactsOf(input:ExpiryPayoffInput|null,scenario:ExecutionScenario|null):ProtectionFacts{
 const empty={longLegPremiumBtc:null,longLegPremiumUsd:null,extraOpeningFeeBtc:null,totalProtectionCostUsd:null,
  deepTailIndex:null,nakedTailUnbounded:true,netProtectionValueUsd:null} as const;
 if(!input||scenario===null)return {...empty,
  benefitAtLongStrikeUsd:missing("The exact payoff inputs or the execution scenario are absent, so the unprotected counterfactual cannot be priced with the same primitives."),
  benefitAtDeepTailUsd:missing("Same missing payoff inputs.")};
 const amount=Math.abs(input.amount);
 const longLegPremiumBtc=input.longEntryPremiumBtc*amount;
 const bothLegFees=input.openingFeesBtc;
 const shortOnlyFee=calculateOptionFee(input.shortEntryPremiumBtc,amount,scenario,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee;
 // A short put spread's tail lies below the strikes; a call spread's above.
 const deepTailIndex=input.optionType==="P"?Math.max(1,input.longStrike*.5):input.longStrike*2;
 const benefit=(index:number)=>expiryPayoff(input,index,"usd-cash-flow").pnl-nakedShortPnlUsd(input,scenario,index);
 const atLongStrike=benefit(input.longStrike),atDeepTail=benefit(deepTailIndex);
 const totalProtectionCostUsd=(longLegPremiumBtc+Math.max(0,bothLegFees-shortOnlyFee))*input.entryIndex;
 return {
  longLegPremiumBtc,longLegPremiumUsd:longLegPremiumBtc*input.entryIndex,
  extraOpeningFeeBtc:Math.max(0,bothLegFees-shortOnlyFee),
  totalProtectionCostUsd,
  benefitAtLongStrikeUsd:has(atLongStrike),benefitAtDeepTailUsd:has(atDeepTail),
  deepTailIndex,nakedTailUnbounded:true,
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
  maxEconomicLossUsd:payoff.maxEconomicLossUsd,
  incrementalInitialMarginUsd:incrementalUsd===null?missing(MARGIN_UNAVAILABLE):has(incrementalUsd),
  peakMarginUsd:peakUsd===null?missing(MARGIN_UNAVAILABLE):has(peakUsd),
  marginModel:str(marginRow?.margin_model),accountConfiguration:str(marginRow?.account_configuration),
  returnOnMaxLoss:ratio(payoff.maxEconomicLossUsd.value,payoff.maxEconomicLossUsd.reason??MARGIN_UNAVAILABLE),
  returnOnOpeningMargin:ratio(incrementalUsd,MARGIN_UNAVAILABLE),
  returnOnPeakCapital:ratio(peakUsd,MARGIN_UNAVAILABLE),
 };
}

function pnlAt(outcomes:readonly Readonly<Record<string,unknown>>[],candidateId:string,scenario:ExecutionScenario|null,kind:"vpoc"|"invalidation"|"settlement"):number|null{
 if(scenario===null)return null;
 const row=outcomes.find(o=>o.candidate_id===candidateId&&o.execution_scenario===scenario&&o.outcome_type===kind);
 if(!row||row.status!=="priced")return null;
 return num(row.net_pnl_usd)??num(row.net_pnl_native);
}

export function normalizeWidthStructures(dataset:AnalysisDataset):readonly WidthStructure[]{
 const candidates=dataset.tables.candidates??[],outcomes=dataset.tables.outcomes??[],
  valuations=dataset.tables.valuations??[],events=dataset.tables.events??[],
  paths=dataset.tables.underlying_path??[],margins=dataset.tables.margin_scenarios??[];
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
  const payoff=payoffFactsOf(input);
  const protection=protectionFactsOf(input,scenario);

  const toUsd=(v:number|null)=>v!==null&&entryIndex!==null?v*entryIndex:null;
  // A round trip is four legs: two opened and two closed. The closing pair is
  // estimated with the SAME canonical fee schedule applied to the entry
  // premiums -- an explicit estimate, never presented as a recorded fee.
  const estimatedClosingFeesBtc=input&&scenario
   ?calculateOptionFee(input.shortEntryPremiumBtc,Math.abs(input.amount),scenario,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee
    +calculateOptionFee(input.longEntryPremiumBtc,Math.abs(input.amount),scenario,STANDARD_INVERSE_BTC_OPTION_FEE).finalFee
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
   creditPerMaxEconomicLoss:netCreditBtc!==null&&payoff.maxEconomicLossUsd.value!==null&&payoff.maxEconomicLossUsd.value!==0&&entryIndex!==null
    ?netCreditBtc*entryIndex/Math.abs(payoff.maxEconomicLossUsd.value):null,
   estimatedRoundTripFeesBtc,
   feeDragOnOpening:openingFeesBtc!==null&&grossCreditBtc!==null&&grossCreditBtc>0?openingFeesBtc/grossCreditBtc:null,
   feeDragRoundTrip:estimatedRoundTripFeesBtc!==null&&grossCreditBtc!==null&&grossCreditBtc>0?estimatedRoundTripFeesBtc/grossCreditBtc:null,
  };

  const invalidationMs=ms(event?.invalidation_decision_timestamp_utc);
  const challenge=challengeOf(pathByEvent.get(eventId)??[],shortStrike,direction,structureEntryMs,expiryTimestampMs,invalidationMs);

  const pnlAtVpocUsd=pnlAt(outcomes,candidateId,scenario,"vpoc");
  const pnlAtInvalidationUsd=challenge.invalidatedInWindow===true?pnlAt(outcomes,candidateId,scenario,"invalidation"):null;
  const pnlAtSettlementUsd=pnlAt(outcomes,candidateId,scenario,"settlement");
  const realizedPnlUsd=challenge.invalidatedInWindow===true?pnlAtInvalidationUsd:pnlAtSettlementUsd;

  const boundaryMs=challenge.invalidatedInWindow===true&&invalidationMs!==null
   ?Math.min(invalidationMs,expiryTimestampMs??invalidationMs):expiryTimestampMs;
  const adverse=adversePath(valuations,candidateId,scenario,evaluated,structureEntryMs,boundaryMs);

  const marginRow=margins.find(m=>m.candidate_id===candidateId);
  const capital=capitalFactsOf(payoff,marginRow,realizedPnlUsd,entryIndex);

  // First-resolution time, for the canonical slow-resolution cohorts.
  const eventEntry=ms(event?.entry_timestamp_utc);
  const vpocMs=ms(event?.vpoc_trigger_timestamp_utc);
  const resolutionMs=[vpocMs,invalidationMs].filter((t):t is number=>t!==null).sort((a,b)=>a-b)[0]??null;
  const timeToResolutionDays=resolutionMs===null||eventEntry===null?null:(resolutionMs-eventEntry)/DAY;

  // The short strike is part of the key: comparing widths across different
  // short strikes would attribute a placement difference to width.
  const matchKey=[eventId,expiryTimestampMs??"unknown-expiry",actualDteDays??"unknown-dte",shortStrike??"unknown-short",
   str(row.structure_type)??"unknown-structure",optionType??"unknown-type","canonical-exit-policy"].join("|");

  return {
   eventId,candidateId,structureExecutionId:str(row.structure_execution_id)??`${candidateId}~${scenario??"unknown"}`,
   executionScenario:scenario,executionScenarioStatus:scenarioStatus,executionScenarioReason:str(row.execution_scenario_reason),
   executionScenarioLegacyUndifferentiated:row.execution_scenario_legacy_undifferentiated===true,
   direction,optionType,structureType:str(row.structure_type),
   expiryTimestampMs,actualDteDays,structureEntryMs,quantity,entryIndex,matchKey,
   identity,entry,payoff,protection,capital,challenge,adverse,
   pnlAtVpocUsd,pnlAtInvalidationUsd,pnlAtSettlementUsd,realizedPnlUsd,
   worstAdverseUsd:adverse.worstAdverseUsd,maeUsd:adverse.maeBeforeProfitUsd,
   timeToResolutionDays,
  } satisfies WidthStructure;
 });
}
