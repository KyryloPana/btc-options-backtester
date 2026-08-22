import type { RetrievedSpread } from "./backtester.ts";

export const SETTLEMENT_ACCOUNTING_VERSION = "inverse-settlement-v2" as const;
export const DELIVERY_FEE_SCHEDULE_VERSION = "deribit-historical-delivery/2026-08-01" as const;
export type SettlementInputValidation = {ok:true;deliveryPrice:number;expiryTimestamp:number;priceIndex:string}|{ok:false;reason:string};

/** Rejects accidental cross-expiry/index and non-official settlement inputs. */
export function validateOfficialDeliveryPrice(spread:RetrievedSpread):SettlementInputValidation {
  const expiry=spread.expiryTimestamp??spread.soldContract?.expiryTimestamp;
  if (!expiry || !spread.soldContract || !spread.boughtContract) return {ok:false,reason:"Exact resolved contracts are required."};
  if (spread.soldContract.expiryTimestamp!==expiry || spread.boughtContract.expiryTimestamp!==expiry) return {ok:false,reason:"Contract expiry does not match the selected expiry."};
  if (spread.deliveryPrice===undefined) return {ok:false,reason:"Official Deribit delivery price is unavailable."};
  if (spread.deliveryPriceSource!=="deribit-get_delivery_prices") return {ok:false,reason:"Delivery price source is not official Deribit delivery history."};
  const priceIndex=spread.priceIndex??"btc_usd";
  if (priceIndex!=="btc_usd") return {ok:false,reason:`Unsupported or mismatched delivery price index: ${priceIndex}.`};
  const expectedDate=new Date(expiry).toISOString().slice(0,10);
  if (spread.deliveryPriceDate!==expectedDate) return {ok:false,reason:`Delivery date ${spread.deliveryPriceDate??"missing"} does not match contract expiry ${expectedDate}.`};
  return {ok:true,deliveryPrice:spread.deliveryPrice,expiryTimestamp:expiry,priceIndex};
}

export function compactSettlementProvenance(spread:RetrievedSpread,retrievedAtUtc:string) {
  const validation=validateOfficialDeliveryPrice(spread);
  return validation.ok?{status:"official-delivery-price-available",deliveryPrice:validation.deliveryPrice,deliveryTimestamp:validation.expiryTimestamp,deliveryPriceDate:spread.deliveryPriceDate,source:spread.deliveryPriceSource,priceIndex:validation.priceIndex,retrievedAtUtc,feeScheduleVersion:DELIVERY_FEE_SCHEDULE_VERSION,settlementCalculationVersion:SETTLEMENT_ACCOUNTING_VERSION}:{status:"official-delivery-price-unavailable",reason:validation.reason,deliveryTimestamp:spread.expiryTimestamp??null,source:"deribit-get_delivery_prices",priceIndex:spread.priceIndex??"btc_usd",retrievedAtUtc,feeScheduleVersion:DELIVERY_FEE_SCHEDULE_VERSION,settlementCalculationVersion:SETTLEMENT_ACCOUNTING_VERSION};
}
