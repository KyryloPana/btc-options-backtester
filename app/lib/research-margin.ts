import { payoffExtrema } from "./expiry-payoff.ts";
import { reconstructStandardVerticalMargin, type MarginPointInput } from "./margin.ts";
import { canonicalJson, type JsonValue, type SelectedStructure } from "./research-selections.ts";

export const LEGACY_MARGIN_NOT_COMPUTED_REASON="No margin result was produced." as const;
export type CanonicalMarginReasonCode="verified_historical_margin_model_unavailable"|"margin_no_canonical_valuation_path"|"margin_missing_index"|"margin_missing_short_mark"|"margin_missing_long_mark"|"margin_historical_rule_unverified"|"margin_deployment_unsupported"|"margin_not_recomputed";
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const number=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:undefined;
const legMark=(estimate:Record<string,unknown>,leg:"sold"|"bought")=>number(object(estimate[leg]).priceBtcPerContract);

/** Converts only the execution-independent reference DTO into canonical margin points. */
export function referenceMarginPoints(reference:SelectedStructure["referenceValuation"]):MarginPointInput[]{
 if(!reference||reference.status!=="valued")return[];
 const entry=object(reference.entrySnapshot),entryTimestamp=number(entry.valuationTimestamp)??number(entry.targetTimestamp),points:MarginPointInput[]=[];
 if(entryTimestamp!==undefined)points.push({timestamp:entryTimestamp,indexPrice:number(entry.entryTargetIndex),shortMarkPriceBtc:legMark(entry,"sold"),longMarkPriceBtc:legMark(entry,"bought")});
 for(const raw of reference.valuationPathSnapshot){const point=object(raw),timestamp=number(point.timestamp);if(timestamp===undefined)continue;const estimate=object(point.modelEstimate??point.ivNormalizedEstimate);points.push({timestamp,indexPrice:number(point.targetIndex),shortMarkPriceBtc:legMark(estimate,"sold")??number(point.shortModelPriceBtc),longMarkPriceBtc:legMark(estimate,"bought")??number(point.longModelPriceBtc)});}
 return [...new Map(points.sort((a,b)=>a.timestamp-b.timestamp).map(point=>[point.timestamp,point])).values()];
}

export function canonicalMarginReason(reason:unknown):CanonicalMarginReasonCode{
 const text=String(reason??"");
 if(text===LEGACY_MARGIN_NOT_COMPUTED_REASON)return "margin_not_recomputed";
 if(/No canonical valuation points/i.test(text))return "margin_no_canonical_valuation_path";
 if(/index price/i.test(text))return "margin_missing_index";
 if(/protective-long mark/i.test(text))return "margin_missing_long_mark";
 if(/option mark/i.test(text))return "margin_missing_short_mark";
 if(/historical.*rule period.*not verified/i.test(text))return "margin_historical_rule_unverified";
 if(/unsupported|Cross-account/i.test(text))return "margin_deployment_unsupported";
 return "verified_historical_margin_model_unavailable";
}

const unavailable=(reason:string,reasonCode:CanonicalMarginReasonCode)=>canonicalJson({status:"unavailable",reason,reasonCode,engineVersion:"deribit-standard-margin-v2"});
/** Canonical PRIMARY margin: reference economics, independent of Maker/Taker fills. */
export function buildResearchMarginSnapshot(structure:Pick<SelectedStructure,"candidateSnapshot"|"quantity"|"referenceValuation">):JsonValue{
 const candidate=object(structure.candidateSnapshot),reference=structure.referenceValuation,entry=object(reference?.entrySnapshot);
 if(!reference||reference.status!=="valued")return unavailable("An execution-independent canonical reference valuation is required.","margin_no_canonical_valuation_path");
 const optionType=candidate.optionType,shortStrike=number(candidate.shortStrike)??number(object(candidate.actualStrikes).short),longStrike=number(candidate.longStrike)??number(object(candidate.actualStrikes).long),expiryTimestamp=number(candidate.expiryTimestamp),entryTimestamp=number(entry.valuationTimestamp)??number(entry.targetTimestamp),entryIndex=number(entry.entryTargetIndex),shortPremium=legMark(entry,"sold"),longPremium=legMark(entry,"bought"),openingFees=number(entry.openingFeesBtc);
 if(optionType!=="C"&&optionType!=="P"||shortStrike===undefined||longStrike===undefined||expiryTimestamp===undefined||entryTimestamp===undefined||entryIndex===undefined||shortPremium===undefined||longPremium===undefined||openingFees===undefined)return unavailable("Canonical reference entry economics are incomplete for maximum-loss and margin reconstruction.","verified_historical_margin_model_unavailable");
 // Maximum economic loss is taken in USD, then represented in BTC at the
 // stated reference index.
 //
 // The btc-settlement extremum is NOT usable here: an inverse option's
 // intrinsic value is (K-S)/S, which diverges as the settlement index
 // approaches zero, so the BTC extremum is a mathematical artifact of the tail
 // sample rather than a terminal loss (it evaluates to ~1.8e8 BTC on a routine
 // 60k/55k put spread). The USD cash-flow extremum is exact and bounded, so it
 // is the primary figure and the BTC number is explicitly a conversion at one
 // stated index -- never an unconditional terminal loss.
 let maximumLossUsd:number,maximumLossBtcAtReferenceIndex:number;
 try{
  maximumLossUsd=Math.abs(payoffExtrema({optionType,shortStrike,longStrike,shortEntryPremiumBtc:shortPremium,longEntryPremiumBtc:longPremium,entryIndex,amount:structure.quantity,openingFeesBtc:openingFees,expiryTimestamp},"usd-cash-flow").maximumLoss);
  maximumLossBtcAtReferenceIndex=maximumLossUsd/entryIndex;
 }catch(error){return unavailable(error instanceof Error?error.message:String(error),"verified_historical_margin_model_unavailable");}
 const maximumLoss=maximumLossBtcAtReferenceIndex;
 const lossMetadata={
  maximumEconomicLossUsd:maximumLossUsd,
  maximumEconomicLossBtcAtReferenceIndex:maximumLossBtcAtReferenceIndex,
  referenceIndex:entryIndex,
  maximumLossMethod:"exact inverse vertical expiry payoff (usd-cash-flow extremum over strike and tail settlement indices, including per-leg delivery fees)",
  maximumLossAssumption:"USD is the primary, bounded figure. The BTC number is that USD loss converted at the stated reference index; it is a representation at one index, not an unconditional terminal BTC loss, because inverse intrinsic value diverges as the settlement index approaches zero.",
 };
 const result=reconstructStandardVerticalMargin({optionType,amount:structure.quantity,shortStrike,longStrike,expiryTimestamp,theoreticalMaximumSpreadLossBtc:maximumLoss,points:referenceMarginPoints(reference),entryTimestamp,terminalTimestamp:expiryTimestamp});
 if(result.status==="unavailable")return canonicalJson({...result,theoreticalMaximumSpreadLossBtc:maximumLoss,...lossMetadata,reasonCode:canonicalMarginReason(result.reason)});
 return canonicalJson({...result,theoreticalMaximumSpreadLossBtc:maximumLoss,...lossMetadata});
}
