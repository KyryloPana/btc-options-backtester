import test from "node:test";
import assert from "node:assert/strict";
import { EXECUTION_TIMING_METADATA, GREEN_SYNCHRONIZATION_MS, synchronizationQuality } from "../app/lib/execution-policy.ts";
import { createEntryTimingPolicy } from "../app/lib/delayed-execution.ts";
import { validateOfficialDeliveryPrice, SETTLEMENT_ACCOUNTING_VERSION } from "../app/lib/settlement-provenance.ts";
import type { RetrievedSpread, ContractSeries } from "../app/lib/backtester.ts";

const expiry=Date.parse("2026-08-28T08:00:00Z");
const leg=(name:string,strike:number):ContractSeries=>({instrumentName:name,strike,optionType:"C",expiryTimestamp:expiry,trades:[]});
const spread=(extra:Partial<RetrievedSpread>={}):RetrievedSpread=>({id:"settlement",targetDte:7,targetWidth:1000,anchorStrike:50_000,soldStrike:50_000,boughtStrike:51_000,optionType:"C",spreadKind:"credit",structure:"call spread",buffered:false,expiryTimestamp:expiry,expiryLabel:"28AUG26",soldContract:leg("BTC-28AUG26-50000-C",50_000),boughtContract:leg("BTC-28AUG26-51000-C",51_000),soldExistedAtEntry:true,boughtExistedAtEntry:true,retrievalStatus:"ready",retrievalNote:"fixture",dataStatus:"available",priceIndex:"btc_usd",deliveryPrice:52_000,deliveryPriceDate:"2026-08-28",deliveryPriceSource:"deribit-get_delivery_prices",...extra});

test("search horizon, delayed ladder, synchronization gate, and quality bands are independent",()=>{
  const policy=createEntryTimingPolicy();
  assert.deepEqual(EXECUTION_TIMING_METADATA.immediateFillSearchWindowsMs,[1_800_000,3_600_000,7_200_000]);
  assert.equal(policy.windows[0].endMs,7_200_000);
  assert.equal(policy.maximumLegSynchronizationMs,3_600_000);
  assert.equal(synchronizationQuality(GREEN_SYNCHRONIZATION_MS),"green");
  assert.equal(synchronizationQuality(GREEN_SYNCHRONIZATION_MS+1),"yellow");
  assert.equal(synchronizationQuality(policy.maximumLegSynchronizationMs+1),"red");
  assert.notEqual(policy.maximumDelayMs,policy.maximumLegSynchronizationMs);
});

test("official delivery identity is exact and provenance is versioned",()=>{
  assert.deepEqual(validateOfficialDeliveryPrice(spread()),{ok:true,deliveryPrice:52_000,expiryTimestamp:expiry,priceIndex:"btc_usd"});
  assert.match((validateOfficialDeliveryPrice(spread({deliveryPriceDate:"2026-08-29"})) as {reason:string}).reason,/does not match/);
  assert.match((validateOfficialDeliveryPrice(spread({priceIndex:"eth_usd"})) as {reason:string}).reason,/mismatched/);
  assert.match((validateOfficialDeliveryPrice(spread({deliveryPrice:undefined})) as {reason:string}).reason,/unavailable/);
  assert.equal(SETTLEMENT_ACCOUNTING_VERSION,"inverse-settlement-v2");
});
