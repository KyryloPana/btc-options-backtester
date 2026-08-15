import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildInventory, parseContractText, valuationTimestamps } from "../app/lib/backtester.ts";
import { buildResearchExport, buildEstimatedPath, estimateResearchSpread } from "../app/lib/research-valuation.ts";
import { priceInverseOption } from "../app/lib/inverse-option-pricing.ts";

const entry = Date.UTC(2025, 9, 1, 8);
const expiry = Date.UTC(2025, 9, 8, 8);
const row = (instrument_name:string,timestamp:number,iv:number,trade_seq:number) => ({instrument_name,timestamp,price:.02,index_price:100_000,direction:trade_seq%2?"sell":"buy",amount:1,iv,trade_seq});
const soldName="BTC-8OCT25-95000-P", boughtName="BTC-8OCT25-90000-P";
const parsed=parseContractText(JSON.stringify({result:{trades:[row(soldName,entry,71,2),row(soldName,entry-1,70,1),row(soldName,entry,71,2),row(boughtName,entry,49,4)]}}));
const inventory=buildInventory([{name:"live-shaped.json",trades:parsed}]);
const sold=inventory.find(x=>x.instrumentName===soldName)!, bought=inventory.find(x=>x.instrumentName===boughtName)!;
const spread:any={id:"audit",targetDte:7,targetWidth:5000,anchorStrike:100000,soldStrike:95000,boughtStrike:90000,optionType:"P",spreadKind:"credit",structure:"95000/90000 P",buffered:false,expiryTimestamp:expiry,expiryLabel:"08OCT25",actualDte:7,actualWidth:5000,soldContract:sold,boughtContract:bought,soldExistedAtEntry:true,boughtExistedAtEntry:true,retrievalStatus:"ready",retrievalNote:"fixture",dataStatus:"available"};

test("audit counterexample: raw duplicate rows survive inventory and lose trade sequence identity",()=>{
  assert.equal(parsed.length,4,"the parser retains raw observations; inventory owns deterministic deduplication");
  assert.equal(sold.trades.length,3,"duplicate raw sequence 2 currently changes inventory");
  assert.ok(sold.trades.every(t=>t.tradeSeq===undefined),"shared parser currently discards trade_seq");
  assert.equal(sold.trades[0].ivApiPercent,70); assert.equal(sold.trades[0].ivDecimal,.70);
  assert.equal(bought.trades[0].ivApiPercent,49); assert.equal(bought.trades[0].ivDecimal,.49);
  assert.notEqual(sold.trades[0].ivDecimal,bought.trades[0].ivDecimal);
});

test("4-hour grid is expiry-bounded and exact expiry is intrinsic",()=>{
  const grid=valuationTimestamps(entry,expiry);
  assert.equal(grid.at(-1),expiry); assert.ok(grid.every(t=>t<=expiry));
  const intrinsic=priceInverseOption({optionType:"put",indexPrice:80_000,strike:95_000,valuationTimestamp:expiry,expiryTimestamp:expiry,ivDecimal:0});
  assert.equal(intrinsic.status,"unavailable","zero-IV expiry is rejected before intrinsic handling; recorded audit defect");
  for(const [indexPrice,strike,ivDecimal] of [[1,1_000_000,1e-12],[100_000,100_000,1e-12],[1e9,1,5]] as const){
    const result=priceInverseOption({optionType:"call",indexPrice,strike,valuationTimestamp:expiry-1,expiryTimestamp:expiry,ivDecimal});
    assert.equal(result.status,"priced"); if(result.status==="priced") assert.ok(Number.isFinite(result.priceBtc)&&result.priceBtc>=0);
  }
});

test("missing later tape uses independent entry IV and typed missing index",()=>{
  const estimate=estimateResearchSpread({spread,targetTimestamp:entry,targetIndex:100_000,amount:1,slippageBps:0});
  assert.equal(estimate.status,"priced"); if(estimate.status!=="priced")return;
  const candles=[{openTime:entry,closeTime:entry+4*3600_000,open:101000,high:101000,low:101000,close:101000,volume:1}];
  const path=buildEstimatedPath({spread,timestamps:[entry+16*3600_000,entry+24*3600_000],candles:[{...candles[0],openTime:entry+12*3600_000,closeTime:entry+16*3600_000}],entry:estimate,slippageBps:0});
  assert.equal(path[0].soldIvSource,"constant-entry-IV"); assert.equal(path[0].longIvSource,"constant-entry-IV");
  assert.equal(path[0].shortIvDecimal,.71); assert.equal(path[0].longIvDecimal,.49);
  assert.equal(path[1].status,"missing"); assert.equal(path[1].unavailableReason,"missing-target-index");
});

test("audit counterexample: Research export is selected-event shaped and lacks reproducibility envelope",()=>{
  const estimate=estimateResearchSpread({spread,targetTimestamp:entry,targetIndex:100_000,amount:1,slippageBps:0});
  const exported:any=buildResearchExport({event:{id:"e",label:"e",direction:"long",entryDate:"2025-10-01",entryPrice:100000,entryTimestamp:entry},spread,entry:estimate});
  for(const required of ["schemaVersion","runId","configurationHash","codeCommit","dataProvenance","qualityState"]) assert.equal(exported[required],undefined,`${required} is currently absent and is a P1 reproducibility finding`);
  assert.equal(exported.mode,"research-estimate"); assert.equal(exported.eventId,"e");
});

test("audit counterexample: outcome USD UI multiplies BTC PnL by event entry price",async()=>{
  const source=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
  assert.match(source,/outcome\.estimatedNetPnl\*result\.eventPrice/);
  assert.doesNotMatch(source,/outcome\.estimatedNetPnl\*outcome\.targetIndex/);
});
