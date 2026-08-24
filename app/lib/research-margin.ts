import { canonicalStructuralLoss } from "./maximum-economic-loss.ts";
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
 // Bounded STRUCTURAL loss from the ONE canonical helper shared with
 // structure_economics, so the two canonical tables cannot disagree. Delivery
 // fees are excluded there because their USD value is unbounded; they travel
 // alongside as a named settlement scenario.
 const loss=canonicalStructuralLoss({optionType,shortStrike,longStrike,shortEntryPremiumBtc:shortPremium,longEntryPremiumBtc:longPremium,entryIndex,amount:structure.quantity,openingFeesBtc:openingFees,expiryTimestamp});
 if(loss.status!=="available")return unavailable(loss.reason??"The bounded structural loss could not be evaluated.","verified_historical_margin_model_unavailable");
 const maximumLoss=loss.btcAtReferenceIndex!;
 const lossMetadata={
  maximumStructuralLossUsd:loss.usd,
  maximumStructuralLossBtcAtReferenceIndex:loss.btcAtReferenceIndex,
  referenceIndex:loss.referenceIndex,
  worstStructuralSettlementIndex:loss.worstStructuralIndex,
  maximumLossMethod:loss.method,
  maximumLossMethodVersion:loss.methodVersion,
  maximumLossAssumption:loss.assumption,
  maximumLossSignConvention:loss.signConvention,
  settlementFeeTreatment:{
   included_in_structural_loss:loss.settlementFees.includedInStructuralLoss,
   global_fee_inclusive_maximum:loss.settlementFees.globalFeeInclusiveMaximum,
   global_fee_inclusive_maximum_reason:loss.settlementFees.globalFeeInclusiveMaximumReason,
   scenario_index:loss.settlementFees.scenarioIndex,
   scenario_label:loss.settlementFees.scenarioLabel,
   scenario_delivery_fees_btc:loss.settlementFees.scenarioDeliveryFeesBtc,
   scenario_delivery_fees_usd:loss.settlementFees.scenarioDeliveryFeesUsd,
  },
 };
 const result=reconstructStandardVerticalMargin({optionType,amount:structure.quantity,shortStrike,longStrike,expiryTimestamp,theoreticalMaximumSpreadLossBtc:maximumLoss,points:referenceMarginPoints(reference),entryTimestamp,terminalTimestamp:expiryTimestamp});
 if(result.status==="unavailable")return canonicalJson({...result,theoreticalMaximumSpreadLossBtc:maximumLoss,...lossMetadata,reasonCode:canonicalMarginReason(result.reason)});
 return canonicalJson({...result,theoreticalMaximumSpreadLossBtc:maximumLoss,...lossMetadata});
}
