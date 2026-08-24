import {canonicalStructuralLoss,type CanonicalStructuralLoss} from "./maximum-economic-loss.ts";
import type {ExpiryPayoffInput} from "./expiry-payoff.ts";

/**
 * ONE reader for the canonical bounded structural loss.
 *
 * Research Analytics must not recreate structural risk. Before this adapter the
 * Spread Width normalizer independently derived its own "maximum economic loss"
 * from payoffExtrema(..., "usd-cash-flow") and payoffExtrema(..., "btc-settlement"),
 * sampling the tail at Number.MAX_SAFE_INTEGER. For a bear call both legs finish
 * deep in the money as the settlement index grows, so a fixed BTC delivery fee
 * converted at that index produced the observed trillion-dollar figure. The
 * canonical exporter had already been corrected; this report had not.
 *
 * SOURCE HIERARCHY.
 *   1. structure_economics -- the canonical structural-loss row.
 *   2. margin_scenarios    -- the same quantity, carried as reconciliation.
 *   3. the canonical helper -- for datasets that predate the canonical tables.
 *
 * When both canonical tables carry a value and they MATERIALLY disagree, the
 * reading is Unavailable with an integrity reason. Silently preferring one of
 * two disagreeing canonical sources would hide an export defect.
 *
 * This adapter never invents a competing definition. Case 3 calls
 * canonicalStructuralLoss -- the identical function the exporter calls -- so an
 * older bundle is evaluated by the canonical method rather than by the
 * fee-inclusive extremum this module exists to remove.
 *
 * SIGN. Positive magnitude, matching the canonical export contract.
 * DELIVERY FEES. Never folded in; carried separately and scenario-specific.
 */

export type StructuralLossSource="structure_economics"|"margin_scenarios"|"canonical_helper";

export interface StructuralLossSettlementFees {
 readonly includedInStructuralLoss:false;
 readonly globalFeeInclusiveMaximum:"bounded"|"unbounded";
 readonly globalFeeInclusiveMaximumReason:string|null;
 readonly scenarioIndex:number|null;
 readonly scenarioLabel:string|null;
 readonly scenarioDeliveryFeesBtc:number|null;
 readonly scenarioDeliveryFeesUsd:number|null;
}

export interface StructuralLossReading {
 readonly status:"available"|"unavailable";
 /** Bounded structural loss magnitude in USD. Positive when available. */
 readonly usd:number|null;
 /** The same loss in BTC at referenceIndex. Never a tail extremum. */
 readonly btc:number|null;
 readonly referenceIndex:number|null;
 /** Settlement index at which the bounded structural maximum is attained. */
 readonly settlementIndex:number|null;
 readonly breakevenIndex:number|null;
 readonly method:string|null;
 readonly methodVersion:string|null;
 readonly source:StructuralLossSource|null;
 /** True when a second canonical table carried the same value and agreed. */
 readonly reconciled:boolean;
 readonly settlementFees:StructuralLossSettlementFees|null;
 readonly reason:string|null;
}

type Row=Readonly<Record<string,unknown>>;
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const obj=(v:unknown):Row=>v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};

/** Relative agreement, so a large loss is not failed by floating-point noise. */
const RECONCILIATION_TOLERANCE=1e-6;
export function structuralLossAgrees(a:number,b:number):boolean{
 return Math.abs(a-b)<=RECONCILIATION_TOLERANCE*Math.max(1,Math.abs(a),Math.abs(b));
}

const unavailable=(reason:string):StructuralLossReading=>({
 status:"unavailable",usd:null,btc:null,referenceIndex:null,settlementIndex:null,breakevenIndex:null,
 method:null,methodVersion:null,source:null,reconciled:false,settlementFees:null,reason,
});

const feesFromRow=(row:Row):StructuralLossSettlementFees|null=>{
 const treatment=obj(row.settlement_fee_treatment);
 if(!Object.keys(treatment).length)return null;
 return {
  includedInStructuralLoss:false,
  globalFeeInclusiveMaximum:treatment.global_fee_inclusive_maximum==="bounded"?"bounded":"unbounded",
  globalFeeInclusiveMaximumReason:str(treatment.global_fee_inclusive_maximum_reason),
  scenarioIndex:num(treatment.scenario_index),scenarioLabel:str(treatment.scenario_label),
  scenarioDeliveryFeesBtc:num(treatment.scenario_delivery_fees_btc),
  scenarioDeliveryFeesUsd:num(treatment.scenario_delivery_fees_usd),
 };
};

const feesFromHelper=(loss:CanonicalStructuralLoss):StructuralLossSettlementFees=>({
 includedInStructuralLoss:false,
 globalFeeInclusiveMaximum:loss.settlementFees.globalFeeInclusiveMaximum,
 globalFeeInclusiveMaximumReason:loss.settlementFees.globalFeeInclusiveMaximumReason,
 scenarioIndex:loss.settlementFees.scenarioIndex,scenarioLabel:loss.settlementFees.scenarioLabel,
 scenarioDeliveryFeesBtc:loss.settlementFees.scenarioDeliveryFeesBtc,
 scenarioDeliveryFeesUsd:loss.settlementFees.scenarioDeliveryFeesUsd,
});

export interface StructuralLossInput {
 /** The canonical structure_economics row for this candidate, when exported. */
 readonly economics?:Row|undefined;
 /** The canonical margin_scenarios row for this candidate, when exported. */
 readonly margin?:Row|undefined;
 /**
  * Used ONLY when neither canonical table carries the value, and only through
  * the canonical helper. Never used to override a canonical row.
  */
 readonly fallback?:ExpiryPayoffInput|null|undefined;
}

export function readCanonicalStructuralLoss(input:StructuralLossInput):StructuralLossReading{
 const economics=input.economics,margin=input.margin;
 const economicsUsd=economics?.maximum_structural_loss_status==="available"?num(economics.maximum_structural_loss_usd):null;
 const marginUsd=num(margin?.maximum_structural_loss_usd);

 // Both canonical sources present: they must agree, or this is an export
 // integrity failure and no figure may be reported.
 if(economicsUsd!==null&&marginUsd!==null&&!structuralLossAgrees(economicsUsd,marginUsd))
  return unavailable(`The two canonical economic tables disagree on the maximum structural loss (structure_economics ${economicsUsd}, margin_scenarios ${marginUsd}). One canonical figure cannot be chosen over the other, so this is reported as an integrity failure rather than resolved silently.`);

 if(economicsUsd!==null){
  const referenceIndex=num(economics!.maximum_structural_loss_reference_index);
  return {
   status:"available",usd:Math.abs(economicsUsd),
   btc:num(economics!.maximum_structural_loss_native),referenceIndex,
   settlementIndex:num(economics!.maximum_structural_loss_settlement_index),
   breakevenIndex:num(economics!.breakeven_index),
   method:str(economics!.maximum_structural_loss_method),
   methodVersion:str(economics!.maximum_structural_loss_method_version),
   source:"structure_economics",reconciled:marginUsd!==null,
   settlementFees:feesFromRow(economics!),reason:null,
  };
 }
 if(marginUsd!==null){
  return {
   status:"available",usd:Math.abs(marginUsd),
   btc:num(margin!.maximum_structural_loss_native),referenceIndex:num(margin!.reference_index),
   settlementIndex:num(margin!.maximum_structural_loss_settlement_index),breakevenIndex:null,
   method:str(margin!.maximum_structural_loss_method),
   methodVersion:str(margin!.maximum_structural_loss_method_version),
   source:"margin_scenarios",reconciled:false,
   settlementFees:feesFromRow(margin!),reason:null,
  };
 }
 if(economics&&economics.maximum_structural_loss_status!=="available")
  return unavailable(str(economics.maximum_structural_loss_unavailable_reason)
   ??"The canonical structure_economics row reports no available maximum structural loss.");

 const fallback=input.fallback;
 if(!fallback)return unavailable("Neither structure_economics nor margin_scenarios carries a canonical maximum structural loss for this structure, and the canonical payoff inputs needed to evaluate it are absent.");
 const loss=canonicalStructuralLoss(fallback);
 if(loss.status!=="available")return unavailable(loss.reason??"The canonical structural-loss method reported no bounded loss.");
 return {
  status:"available",usd:loss.usd,btc:loss.btcAtReferenceIndex,referenceIndex:loss.referenceIndex,
  settlementIndex:loss.worstStructuralIndex,breakevenIndex:loss.breakevenIndex,
  method:loss.method,methodVersion:loss.methodVersion,
  source:"canonical_helper",reconciled:false,settlementFees:feesFromHelper(loss),reason:null,
 };
}

/** Index canonical rows by candidate id, for report normalizers. */
export function indexByCandidate(rows:readonly Row[]|undefined):ReadonlyMap<string,Row>{
 const map=new Map<string,Row>();
 for(const row of rows??[]){const id=str(row.candidate_id);if(id&&!map.has(id))map.set(id,row)}
 return map;
}
