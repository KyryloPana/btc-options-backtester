import test from "node:test";
import assert from "node:assert/strict";
import { buildEstimatedPath, buildResearchExport, buildResearchOutcomes, estimateModelSpread, estimateResearchSpread, MODEL_IV_ANCHOR_MAX_AGE_MINUTES, evaluateResearchEntryLayers, expiryWeekday, isFridayExpiry, resolveUnderlyingIndex, openingUsdEquivalent, scaleResearchEstimate, scaleResearchPath, validateResearchAmount } from "../app/lib/research-valuation.ts";
import { buildInventory, executionClock, parseContractText, retrieveSpread, simulateTakerSpread, type ContractSeries, type ContractTrade, type RetrievedSpread } from "../app/lib/backtester.ts";
import { parseOhlcCandles } from "../app/lib/candle-pipeline.ts";
const T=Date.UTC(2024,0,1,12), expiry=T+7*864e5;
function trade(name:string,offsetMin:number,price:number,direction:"buy"|"sell",amount=1,iv=60):ContractTrade{return{instrumentName:name,timestamp:T+offsetMin*60000,price,indexPrice:40000,direction,amount,iv,ivApiPercent:iv,ivDecimal:iv/100};}
function series(name:string,strike:number,trades:ContractTrade[]):ContractSeries{return{instrumentName:name,strike,optionType:"P",expiryTimestamp:expiry,expiryLabel:"08JAN24",trades,firstTradeTimestamp:trades[0]?.timestamp??T,lastTradeTimestamp:trades.at(-1)?.timestamp??T,sourceFiles:[]};}
function spread(sold:ContractTrade[],bought:ContractTrade[]):RetrievedSpread{return{id:"x",targetDte:7,targetWidth:1000,anchorStrike:40000,soldStrike:39000,boughtStrike:38000,optionType:"P",spreadKind:"credit",structure:"39000/38000 P",buffered:false,soldContract:series("BTC-8JAN24-39000-P",39000,sold),boughtContract:series("BTC-8JAN24-38000-P",38000,bought),soldExistedAtEntry:true,boughtExistedAtEntry:true,retrievalStatus:"ready",retrievalNote:"ok",expiryTimestamp:expiry,expiryLabel:"08JAN24",actualWidth:1000};}
// The sold leg has a "buy" print and the bought leg has a "sell" print --
// exactly the tape a passive maker order would have been crossed against,
// not the tape our own taker action would produce. Maker opportunity prices
// cleanly from this evidence; the strict taker-only backtester correctly
// finds no fill, since it never crosses this direction.
test("opposite-direction tape supports a maker opportunity estimate but cannot fill strict taker tape",()=>{const s=spread([trade("BTC-8JAN24-39000-P",1,.08,"buy")],[trade("BTC-8JAN24-38000-P",5,.03,"sell")]);const maker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:1,slippageBps:10,executionMode:"maker"});assert.equal(maker.status,"priced");if(maker.status==="priced"){assert.equal(maker.estimateQuality,"green");assert.equal(maker.executionMode,"maker");}
 // The identical tape is NOT taker-consistent: our own taker action would need
 // the same-direction print, which this fixture does not have, so the taker
 // scenario must independently fall back to the model (never borrow maker's
 // direct evidence, and never silently substitute a confident number).
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:1,slippageBps:10,executionMode:"taker"});assert.equal(taker.status,"unavailable","the only long-leg IV is in the future and cannot be borrowed");
 const strict=simulateTakerSpread(s,executionClock({signalTimestamp:T,signalSourceTimestamp:T,signalTimePrecision:"second",configuredLatencyMs:0,maxFillWaitMs:30*60000}),1,0,60000);assert.equal(strict.status,"no-trade");
});
test("smallest common direct window wins and 2h direct beats IV fallback",()=>{const s=spread([trade("BTC-8JAN24-39000-P",20,.08,"sell"),trade("BTC-8JAN24-39000-P",90,.5,"sell")],[trade("BTC-8JAN24-38000-P",25,.03,"buy")]);const e=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});assert.equal(e.status,"priced");if(e.status==="priced"){assert.equal(e.evidenceWindowMinutes,30);assert.equal(e.sold.unslippedPriceBtcPerContract,.08);assert.equal(e.priceSource,"direct-vwap");}});
test("IV normalization is bounded and missing path points remain gaps",()=>{const valid=spread([trade("BTC-8JAN24-39000-P",-600,.08,"sell")],[trade("BTC-8JAN24-38000-P",-590,.03,"buy")]);const entry=estimateResearchSpread({spread:valid,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});assert.equal(entry.status,"priced");if(entry.status==="priced"){assert.equal(entry.priceSource,"model-reconstructed");assert.equal(entry.estimateQuality,"red");const path=buildEstimatedPath({spread:valid,timestamps:[T,T+2*864e5],indexAt:()=>40000,entry,slippageBps:0});assert.equal(path[1].status,"priced");assert.equal(path[1].ivSource,"constant-entry-IV");}const stale=spread([trade("BTC-8JAN24-39000-P",721,.08,"sell")],[trade("BTC-8JAN24-38000-P",721,.03,"buy")]);assert.equal(estimateResearchSpread({spread:stale,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"}).status,"unavailable");});
test("model valuation enforces the canonical IV-anchor maximum age",()=>{
 assert.equal(MODEL_IV_ANCHOR_MAX_AGE_MINUTES,720);
 const atBoundary=spread([trade("BTC-8JAN24-39000-P",-MODEL_IV_ANCHOR_MAX_AGE_MINUTES,.08,"buy")],[trade("BTC-8JAN24-38000-P",-MODEL_IV_ANCHOR_MAX_AGE_MINUTES,.03,"sell")]);
 const beyondBoundary=spread([trade("BTC-8JAN24-39000-P",-MODEL_IV_ANCHOR_MAX_AGE_MINUTES-1,.08,"buy")],[trade("BTC-8JAN24-38000-P",-MODEL_IV_ANCHOR_MAX_AGE_MINUTES-1,.03,"sell")]);
 const priced=estimateModelSpread({spread:atBoundary,targetTimestamp:T,targetIndex:40000,slippageBps:0});
 assert.equal(priced.status,"priced");if(priced.status==="priced")assert.equal(priced.evidenceWindowMinutes,MODEL_IV_ANCHOR_MAX_AGE_MINUTES);
 assert.equal(estimateModelSpread({spread:beyondBoundary,targetTimestamp:T,targetIndex:40000,slippageBps:0}).status,"unavailable");
});
test("insufficient historical amount is unavailable rather than a priced warning",()=>{const s=spread([trade("BTC-8JAN24-39000-P",0,.08,"sell",1)],[trade("BTC-8JAN24-38000-P",0,.03,"buy",1)]);const one=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:1,slippageBps:0,executionMode:"taker"});const ten=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:10,slippageBps:0,executionMode:"taker"});assert.equal(one.status,"priced");assert.equal(ten.status,"unavailable");});
test("research calculator and every independent outcome remain estimate-based",()=>{const s={...spread([trade("BTC-8JAN24-39000-P",0,.08,"sell",.5)],[trade("BTC-8JAN24-38000-P",0,.03,"buy",.5)]),deliveryPrice:37000};const entry=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:.5,slippageBps:5,executionMode:"taker"});assert.equal(entry.status,"priced");if(entry.status!=="priced")return;const timestamps=Array.from({length:43},(_,i)=>T+i*4*36e5);const path=buildEstimatedPath({spread:s,timestamps,indexAt:()=>40000,entry,slippageBps:5});const event={id:"e",label:"e",direction:"long" as const,entryDate:"2024-01-01",entryTimestamp:T,entryPrice:40000,vpocTimestamp:T+864e5,invalidationPrice:39000};const candles=[{openTime:T+2*864e5,closeTime:T+2*864e5+36e5,open:40000,high:40100,low:38000,close:38000,volume:1}];const outcomes=buildResearchOutcomes({event,spread:s,entry,path,candles});assert.deepEqual(outcomes.map(outcome=>outcome.label),["VPOC","25% credit","50% credit","70% credit","3D","5D","7D","Invalidation","Settlement"]);assert.ok(outcomes.every(outcome=>outcome.status==="estimated"||outcome.evidenceReason));const two=scaleResearchEstimate(entry,2);const fractional=scaleResearchEstimate(entry,.25);assert.equal(two.grossSpreadBtc,entry.grossSpreadBtc*4);assert.ok(two.openingFeesBtc>entry.openingFeesBtc);assert.ok(fractional.netOpeningCashFlowBtc>0);const scaledPath=scaleResearchPath(path,entry,2);assert.equal(scaledPath.length,path.length);const exported=buildResearchExport({event,spread:s,entry:two,path:scaledPath,outcomes});assert.equal(JSON.stringify(exported).includes("executedNetPnl"),false);assert.equal(exported.estimatedOutcomes.length,9);});


test("direct Green basis retains distinct anchors and the bounded candle resolver restores the path",()=>{
 const s=spread([trade("BTC-8JAN24-39000-P",1,.08,"sell",1,55),trade("BTC-8JAN24-39000-P",300,.07,"sell",1,58)],[trade("BTC-8JAN24-38000-P",5,.03,"buy",1,65)]);
 const entry=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});assert.equal(entry.status,"priced");if(entry.status!=="priced")return;
 assert.equal(entry.priceSource,"direct-vwap");assert.equal(entry.sold.unslippedPriceBtcPerContract,.08);assert.equal(entry.bought.unslippedPriceBtcPerContract,.03);
 assert.equal(entry.sold.model,undefined);assert.equal(entry.bought.model,undefined,"post-decision prints are execution evidence, not IV anchors");
 const hour=Date.UTC(2024,0,1,10),target=hour+59*60000,candles=[{openTime:hour,closeTime:hour+3600000,open:40000,high:40100,low:39900,close:40050,volume:1}];
 const resolved=resolveUnderlyingIndex(candles,target);assert.equal(resolved?.index,40050);assert.equal(resolved?.lookupMethod,"containing-candle");
 const path=buildEstimatedPath({spread:s,timestamps:[T,T+24*3600000,expiry,expiry+4*3600000],indexAt:()=>40000,entry,slippageBps:0});
 assert.equal(path.length,3);assert.equal(path[0].status,"missing","an entry without a causal paired IV basis is honestly missing from the model path");assert.ok(path.slice(1).every(point=>point.status==="missing"));assert.equal(path.at(-1)?.timestamp,expiry);
 const missing=buildEstimatedPath({spread:s,timestamps:[T],indexAt:()=>undefined,entry,slippageBps:0})[0];assert.equal(missing.unavailableReason,"missing-target-index");
});

test("Friday metadata is UTC-only and does not mutate candidate data",()=>{
 const friday=Date.UTC(2025,9,17,8),wednesday=Date.UTC(2025,9,15,8);assert.equal(expiryWeekday(friday),"Friday");assert.equal(isFridayExpiry(friday),true);assert.equal(isFridayExpiry(wednesday),false);
 const s={...spread([trade("BTC-8JAN24-39000-P",0,.08,"sell")],[trade("BTC-8JAN24-38000-P",0,.03,"buy")]),expiryTimestamp:friday};const before=s.id;const entry=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});const exported=buildResearchExport({event:{id:"e",label:"e",direction:"long",entryDate:"2024-01-01",entryPrice:40000},spread:s,entry});assert.equal(exported.expiryWeekday,"Friday");assert.equal(exported.isFridayExpiry,true);assert.equal(s.id,before);
});

test("live-shaped October Deribit rows retain independent IV anchors through direct entry and path pricing",()=>{
 const entry=Date.parse("2025-10-08T08:00:00Z"),expiration=Date.parse("2025-10-17T08:00:00Z");
 const raw=[
  {timestamp:entry,instrument_name:"BTC-17OCT25-127000-C",price:.031,iv:54.25,index_price:122490,amount:1,direction:"sell",trade_id:"short-live"},
  {timestamp:entry,instrument_name:"BTC-17OCT25-128000-C",price:.026,iv:58.75,index_price:122520,amount:1,direction:"buy",trade_id:"long-live"},
 ];
 const trades=parseContractText(JSON.stringify({result:{trades:raw}}));
 assert.deepEqual(trades.map(t=>t.ivApiPercent),[54.25,58.75]);assert.deepEqual(trades.map(t=>t.ivDecimal),[.5425,.5875]);
 const inventory=buildInventory([{name:"live.json",trades}]);
 const resolved=retrieveSpread({id:"oct-green",targetDte:7,targetWidth:1000,anchorStrike:127000,soldStrike:127000,boughtStrike:128000,optionType:"C",spreadKind:"credit",structure:"127000/128000 C",buffered:false},entry,inventory);
 assert.equal(resolved.soldContract?.instrumentName,"BTC-17OCT25-127000-C");assert.equal(resolved.boughtContract?.instrumentName,"BTC-17OCT25-128000-C");
 const direct=estimateResearchSpread({spread:resolved,targetTimestamp:entry,targetIndex:122490,amount:1,slippageBps:0,executionMode:"taker"});assert.equal(direct.status,"priced");if(direct.status!=="priced")return;
 assert.equal(direct.priceSource,"direct-vwap");assert.equal(direct.estimateQuality,"green");assert.equal(direct.sold.model?.anchorIvDecimal,.5425);assert.equal(direct.bought.model?.anchorIvDecimal,.5875);
 const rows=Array.from({length:218},(_,i)=>({openTime:entry-3600000+i*3600000,closeTime:entry-1+i*3600000,open:122000+i*5,high:123000,low:121000,close:122100+i*7,volume:1}));
 const candles=parseOhlcCandles({candles:rows},entry-3600000,expiration+3600000);
 const path=buildEstimatedPath({spread:resolved,timestamps:[entry,entry+2*864e5],candles,entry:direct,slippageBps:0});
 assert.ok(path.every(p=>p.status==="priced"));
 const one=scaleResearchPath(path,direct,1);assert.deepEqual(one.map(p=>p.estimatedNetPnlBtc),path.map(p=>p.estimatedNetPnlBtc));
});

test("invalid amount is rejected before constructing a research path",()=>{assert.match(validateResearchAmount(0)??"",/greater than zero/);});

test("scheduled raw-VWAP marks use fresh causal closing tape and their own path accounting",()=>{
 const closeAt=T+4*36e5,s=spread(
  [trade("BTC-8JAN24-39000-P",0,.08,"sell",2),trade("BTC-8JAN24-39000-P",241,.04,"buy",2)],
  [trade("BTC-8JAN24-38000-P",0,.03,"buy",2),trade("BTC-8JAN24-38000-P",242,.01,"sell",2)],
 );
 const entry=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,amount:2,slippageBps:0,executionMode:"taker"});
 assert.equal(entry.status,"priced");if(entry.status!=="priced")return;
 const [point]=buildEstimatedPath({spread:s,timestamps:[closeAt],indexAt:()=>41000,entry,slippageBps:0});
 assert.equal(point.status,"priced");assert.equal(point.rawEstimate?.intent,"close");
 assert.deepEqual(point.rawEstimate?.sold.supportingTrades.map(t=>t.direction),["buy"]);
 assert.deepEqual(point.rawEstimate?.bought.supportingTrades.map(t=>t.direction),["sell"]);
 assert.ok(point.rawEstimate!.sold.supportingTimestamps.every(t=>t>=closeAt));
 assert.equal(point.rawEstimate?.observedAmount,2);
 assert.equal(point.rawClosingSpreadValueBtc,-.06);
 assert.equal(point.rawEstimatedNetPnlBtc,entry.netOpeningCashFlowBtc+point.rawClosingSpreadValueBtc!-point.rawClosingFeesBtc!);
});

test("opening USD equivalents retain the canonical synchronized entry index",()=>{
 const direct=estimateResearchSpread({spread:spread([trade("BTC-8JAN24-39000-P",0,.08,"sell",2)],[trade("BTC-8JAN24-38000-P",0,.03,"buy",2)]),targetTimestamp:T,targetIndex:41_234.5,amount:2,slippageBps:0,executionMode:"taker"});
 assert.equal(direct.status,"priced"); if(direct.status!=="priced")return;
 assert.equal(direct.entryTargetIndex,41_234.5);
 assert.equal(openingUsdEquivalent(direct.grossSpreadBtc,direct.entryTargetIndex),direct.grossSpreadBtc*41_234.5);
 assert.equal(openingUsdEquivalent(.001,undefined),undefined); assert.equal(openingUsdEquivalent(.001,0),undefined);
 const exported=buildResearchExport({event:{id:"e",label:"e",direction:"long",entryDate:"2024-01-01",entryPrice:99_999},spread:spread([trade("BTC-8JAN24-39000-P",0,.08,"sell",2)],[trade("BTC-8JAN24-38000-P",0,.03,"buy",2)]),entry:direct});
 assert.equal(exported.openingCurrencyConversion?.method,"btc-times-entry-target-index");
 assert.equal(exported.openingCurrencyConversion?.index,41_234.5);
 assert.equal(exported.openingUsdEquivalent?.soldPremium,direct.sold.priceBtcPerContract*direct.amount*41_234.5);
 assert.equal(exported.openingUsdEquivalent?.boughtPremium,direct.bought.priceBtcPerContract*direct.amount*41_234.5);
 assert.equal(exported.openingUsdEquivalent?.openingFees,direct.openingFeesBtc*41_234.5);
 assert.equal(exported.openingUsdEquivalent?.grossEntry,direct.grossSpreadBtc*41_234.5);
 assert.equal(exported.openingUsdEquivalent?.netOpening,direct.netOpeningCashFlowBtc*41_234.5);
 assert.equal(exported.estimatedEntry.grossSpreadBtc,direct.grossSpreadBtc);
});

test("2025-07-10 12:00 UTC cliff cannot see future IV or use an unsynchronized leg pair",()=>{
 const cliff=Date.parse("2025-07-10T12:00:00Z"),future=cliff+60_000;
 const put=(name:string,strike:number,rows:ContractTrade[]):ContractSeries=>({instrumentName:name,strike,optionType:"P",expiryTimestamp:cliff+7*864e5,expiryLabel:"17JUL25",trades:rows,firstTradeTimestamp:rows[0].timestamp,lastTradeTimestamp:rows.at(-1)!.timestamp,sourceFiles:[]});
 const row=(name:string,timestamp:number,price:number,direction:"buy"|"sell",id:string):ContractTrade=>({instrumentName:name,timestamp,price,indexPrice:118000,direction,amount:1,iv:60,ivApiPercent:60,ivDecimal:.6,tradeId:id});
 const shortName="BTC-17JUL25-110000-P",longName="BTC-17JUL25-108000-P",s:RetrievedSpread={...spread([],[]),soldContract:put(shortName,110000,[row(shortName,cliff-2*3600000,.04,"sell","short-old"),row(shortName,future,.20,"buy","short-future")]),boughtContract:put(longName,108000,[row(longName,cliff-250*60_000,.02,"buy","long-unsynced"),row(longName,future,.10,"sell","long-future")]),expiryTimestamp:cliff+7*864e5};
 const value=estimateResearchSpread({spread:s,targetTimestamp:cliff,targetIndex:118000,slippageBps:0,executionMode:"taker"});assert.equal(value.status,"unavailable");if(value.status==="unavailable")assert.match(value.reason,/causal IV-anchor pair synchronized within 60 minutes/);
});

test("nine-variant discontinuity keeps model valuation independent from raw execution",()=>{
 const resolved=Array.from({length:5},(_,i)=>{const shortName="BTC-8JAN24-39000-P",longName="BTC-8JAN24-38000-P";return{...spread(
  [trade(shortName,-10,.08,"sell",.2,60),trade(shortName,1,.08,"sell",.1,60),trade(shortName,2,.08,"buy",.1,60)],
  [trade(longName,-9,.03,"buy",.2,55),trade(longName,1,.03,"buy",.1,55),trade(longName,2,.03,"sell",.1,55)]),id:`resolved-${i}`};});
 const unresolved=Array.from({length:4},(_,i)=>({...spread([],[]),id:`unresolved-${i}`,soldContract:undefined,boughtContract:undefined,retrievalStatus:"partial" as const,retrievalNote:"API retrieval failed for both exact instruments"}));
 const layers=[...resolved,...unresolved].map(s=>evaluateResearchEntryLayers({spread:s,targetTimestamp:T,targetIndex:40000,amount:1,slippageBps:0,fillWindowMinutes:30}));
 assert.equal(layers.length,9);assert.equal(layers.filter(x=>x.structural.status==="resolved").length,5);assert.equal(layers.filter(x=>x.structural.status==="unresolved").length,4);
 assert.equal(layers.filter(x=>x.model.status==="priced").length,5,"causal model values survive the size shortfall");
 assert.equal(layers.filter(x=>x.maker.status==="available").length,0);assert.equal(layers.filter(x=>x.taker.status==="available").length,0);
 for(const x of layers.slice(0,5)){assert.equal(x.maker.reasonCode,"insufficient-compatible-amount");assert.equal(x.taker.reasonCode,"insufficient-compatible-amount");assert.equal(x.maker.requestedAmount,1);assert.equal(x.maker.shortQualifyingAmount,.1);assert.equal(x.maker.rawVwapStatus,"unavailable");}
 for(const x of layers.slice(5)){assert.equal(x.model.status,"unavailable");assert.equal(x.maker.entry.status,"unavailable");assert.equal(x.taker.entry.status,"unavailable");}
});
