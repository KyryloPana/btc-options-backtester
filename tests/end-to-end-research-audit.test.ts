import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildInventory, DuplicateTradeIntegrityError, parseContractText, parseContractTextWithDiagnostics, valuationTimestamps, type RetrievedSpread } from "../app/lib/backtester.ts";
import { buildResearchExport, buildEstimatedPath, estimateResearchSpread } from "../app/lib/research-valuation.ts";
import { priceInverseOption } from "../app/lib/inverse-option-pricing.ts";

const entry = Date.UTC(2025, 9, 1, 8);
const expiry = Date.UTC(2025, 9, 8, 8);
const row = (instrument_name:string,timestamp:number,iv:number,trade_seq:number) => ({instrument_name,timestamp,price:.02,index_price:100_000,direction:trade_seq%2?"sell":"buy",amount:1,iv,trade_seq});
const soldName="BTC-8OCT25-95000-P", boughtName="BTC-8OCT25-90000-P";
const parsed=parseContractText(JSON.stringify({result:{trades:[row(soldName,entry,71,2),row(soldName,entry-1,70,1),row(soldName,entry,71,2),row(boughtName,entry,49,4)]}}));
const inventory=buildInventory([{name:"live-shaped.json",trades:parsed}]);
const sold=inventory.find(x=>x.instrumentName===soldName)!, bought=inventory.find(x=>x.instrumentName===boughtName)!;
const spread:RetrievedSpread={id:"audit",targetDte:7,targetWidth:5000,anchorStrike:100000,soldStrike:95000,boughtStrike:90000,optionType:"P",spreadKind:"credit",structure:"95000/90000 P",buffered:false,expiryTimestamp:expiry,expiryLabel:"08OCT25",actualDte:7,actualWidth:5000,soldContract:sold,boughtContract:bought,soldExistedAtEntry:true,boughtExistedAtEntry:true,retrievalStatus:"ready",retrievalNote:"fixture",dataStatus:"available"};

test("duplicate sequence identities are normalized and removed before research calculations",()=>{
  assert.equal(parsed.length,3,"the parser deduplicates a response before inventory construction");
  assert.equal(sold.trades.length,2);
  assert.deepEqual(sold.trades.map(t=>t.tradeSeq),["1","2"]);
  assert.equal(sold.trades[0].ivApiPercent,70); assert.equal(sold.trades[0].ivDecimal,.70);
  assert.equal(bought.trades[0].ivApiPercent,49); assert.equal(bought.trades[0].ivDecimal,.49);
  assert.notEqual(sold.trades[0].ivDecimal,bought.trades[0].ivDecimal);
});

test("4-hour grid is expiry-bounded and exact expiry is intrinsic",()=>{
  const grid=valuationTimestamps(entry,expiry);
  assert.equal(grid.at(-1),expiry); assert.ok(grid.every(t=>t<=expiry));
  const intrinsic=priceInverseOption({optionType:"put",indexPrice:80_000,strike:95_000,valuationTimestamp:expiry,expiryTimestamp:expiry,ivDecimal:0});
  assert.equal(intrinsic.status,"priced"); if(intrinsic.status==="priced") assert.equal(intrinsic.priceBtc,15_000/80_000);
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
  const exported=buildResearchExport({event:{id:"e",label:"e",direction:"long",entryDate:"2025-10-01",entryPrice:100000,entryTimestamp:entry},spread,entry:estimate});
  for(const required of ["schemaVersion","runId","configurationHash","codeCommit","dataProvenance","qualityState"]) assert.equal((exported as unknown as Record<string, unknown>)[required],undefined,`${required} is currently absent and is a P1 reproducibility finding`);
  assert.equal(exported.mode,"research-estimate"); assert.equal(exported.eventId,"e");
});

test("Research outcome USD persists the valuation-point index rather than entry index",async()=>{
  const estimate=estimateResearchSpread({spread,targetTimestamp:entry,targetIndex:100_000,amount:1,slippageBps:0});
  assert.equal(estimate.status,"priced"); if(estimate.status!=="priced")return;
  const outcomeTime=entry+4*3600_000;
  const path=buildEstimatedPath({spread,timestamps:[outcomeTime],indexAt:()=>80_000,entry:estimate,slippageBps:0});
  const { researchOutcomeAt }=await import("../app/lib/research-valuation.ts");
  const outcome=researchOutcomeAt("point","point",outcomeTime,path);
  assert.equal(outcome.conversionIndex,80_000);
  assert.equal(outcome.conversionIndexTimestamp,outcomeTime);
  assert.equal(outcome.estimatedNetPnlUsd,outcome.estimatedNetPnlBtc!*80_000);
  assert.notEqual(outcome.estimatedNetPnlUsd,outcome.estimatedNetPnlBtc!*100_000);
  const source=await readFile(new URL("../app/options-backtester.tsx",import.meta.url),"utf8");
  assert.doesNotMatch(source,/outcome\.estimatedNetPnl\*result\.eventPrice/);
  assert.match(source,/USD at outcome index/);
});

test("identity deduplication spans files, preserves economic twins, rejects conflicts, and reports malformed rows",()=>{
 const named=(seq:number,patch:Record<string,unknown>={})=>({...row(soldName,entry,70,seq),...patch});
 const pages=[{name:"page-2",trades:parseContractText(JSON.stringify([named(2),named(1)]))},{name:"page-1",trades:parseContractText(JSON.stringify([named(2),named(3)]))}];
 const series=buildInventory(pages)[0];
 assert.deepEqual(series.trades.map(t=>t.tradeSeq),["1","2","3"]);
 assert.equal(series.trades.length,3,"distinct IDs with identical economic fields remain distinct");
 assert.throws(()=>buildInventory([{name:"a",trades:parseContractText(JSON.stringify([named(9),named(9,{price:.03})]))}]),(error:unknown)=>error instanceof DuplicateTradeIntegrityError&&error.instrument===soldName&&error.identity==="trade_seq:9"&&error.conflictingFields.includes("price"));
 const parsedResult=parseContractTextWithDiagnostics(`${JSON.stringify(named(10))}\nnot-json\n${JSON.stringify({bad:true})}`);
 assert.equal(parsedResult.diagnostics.totalRows,3); assert.equal(parsedResult.diagnostics.acceptedRows,1); assert.equal(parsedResult.diagnostics.malformedRows,2);
 assert.ok(parsedResult.diagnostics.rejections.some(reason=>reason.code==="malformed-json"));
});

test("duplicate rows cannot change VWAP, IV anchor, amount, or quality",()=>{
 const make=(duplicates:boolean)=>{const soldRows=[{...row(soldName,entry-1000,65,20),price:.03,amount:2},{...row(soldName,entry+1000,75,21),price:.01,amount:1}];if(duplicates)soldRows.push({...soldRows[1]});const inv=buildInventory([{name:"pages",trades:parseContractText(JSON.stringify([...soldRows,row(boughtName,entry,55,30)]))}]);const localSpread={...spread,soldContract:inv.find(x=>x.instrumentName===soldName),boughtContract:inv.find(x=>x.instrumentName===boughtName)};return estimateResearchSpread({spread:localSpread,targetTimestamp:entry,targetIndex:100_000,amount:1,slippageBps:0});};
 const baseline=make(false), duplicated=make(true);assert.equal(baseline.status,"priced");assert.equal(duplicated.status,"priced");if(baseline.status!=="priced"||duplicated.status!=="priced")return;
 assert.equal(duplicated.sold.unslippedPriceBtcPerContract,baseline.sold.unslippedPriceBtcPerContract);
 assert.equal(duplicated.sold.model?.anchorIvDecimal,baseline.sold.model?.anchorIvDecimal);
 assert.equal(duplicated.observedAmount,baseline.observedAmount);
 assert.equal(duplicated.estimateQuality,baseline.estimateQuality);
});
