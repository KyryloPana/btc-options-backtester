import test from "node:test";
import assert from "node:assert/strict";
import {estimateResearchSpread} from "../app/lib/research-valuation.ts";
import type {ContractSeries, ContractTrade, RetrievedSpread} from "../app/lib/backtester.ts";

/**
 * Maker-opportunity and taker-execution scenarios for a single option
 * structure, verified independent: one scenario's direction-filtered
 * evidence must never leak into the other, and an absent scenario must
 * report status "unavailable" (Not evaluated), never a fabricated 0.
 */

const T=Date.UTC(2024,0,1,12), expiry=T+7*864e5;
function trade(name:string,offsetMin:number,price:number,direction:"buy"|"sell",amount=1,iv?:number):ContractTrade{
 return{instrumentName:name,timestamp:T+offsetMin*60000,price,indexPrice:40000,direction,amount,iv,ivApiPercent:iv,ivDecimal:iv===undefined?undefined:iv/100};
}
function series(name:string,strike:number,trades:ContractTrade[]):ContractSeries{return{instrumentName:name,strike,optionType:"P",expiryTimestamp:expiry,expiryLabel:"08JAN24",trades,firstTradeTimestamp:trades[0]?.timestamp??T,lastTradeTimestamp:trades.at(-1)?.timestamp??T,sourceFiles:[]};}
function spread(sold:ContractTrade[],bought:ContractTrade[]):RetrievedSpread{return{id:"x",targetDte:7,targetWidth:1000,anchorStrike:40000,soldStrike:39000,boughtStrike:38000,optionType:"P",spreadKind:"credit",structure:"39000/38000 P",buffered:false,soldContract:series("BTC-8JAN24-39000-P",39000,sold),boughtContract:series("BTC-8JAN24-38000-P",38000,bought),soldExistedAtEntry:true,boughtExistedAtEntry:true,retrievalStatus:"ready",retrievalNote:"ok",expiryTimestamp:expiry,expiryLabel:"08JAN24",actualWidth:1000};}

test("entry action: sell to open the sold/short leg, buy to open the bought/long leg -- for both scenarios",()=>{
 // Sold leg (short, opened by selling) has a taker-sell print; bought leg
 // (long, opened by buying) has a taker-buy print -- these are the taker's
 // OWN action prints, so this is taker-consistent tape for entry.
 const s=spread([trade("BTC-8JAN24-39000-P",0,.08,"sell")],[trade("BTC-8JAN24-38000-P",0,.03,"buy")]);
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});
 assert.equal(taker.status,"priced");
 if(taker.status==="priced"){assert.equal(taker.priceSource,"direct-vwap");assert.equal(taker.sold.unslippedPriceBtcPerContract,.08);assert.equal(taker.bought.unslippedPriceBtcPerContract,.03);}
});

test("maker and taker never share evidence: taker-only tape leaves maker genuinely unavailable, not 0",()=>{
 // Both legs carry ONLY taker-consistent entry prints, and no IV data at all
 // (iv left undefined), so there is no model fallback either -- maker must
 // come back structurally unavailable rather than borrowing taker's numbers
 // or reporting a price of zero.
 const s=spread([trade("BTC-8JAN24-39000-P",0,.08,"sell")],[trade("BTC-8JAN24-38000-P",0,.03,"buy")]);
 const maker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"maker"});
 assert.equal(maker.status,"unavailable","maker has no compatible-direction evidence and no IV anchor");
 assert.equal(maker.executionMode,"maker");
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});
 assert.equal(taker.status,"priced","taker evidence is untouched by maker's absence");
});

test("both scenarios can be genuinely evaluated from disjoint evidence for the same structure",()=>{
 // The sold leg carries BOTH a taker-sell print (taker evidence) and a
 // taker-buy print (maker evidence) at different prices; same for the bought
 // leg. Each scenario must pick only its own compatible-direction print.
 const s=spread(
  [trade("BTC-8JAN24-39000-P",0,.08,"sell"),trade("BTC-8JAN24-39000-P",1,.09,"buy")],
  [trade("BTC-8JAN24-38000-P",0,.03,"buy"),trade("BTC-8JAN24-38000-P",1,.02,"sell")],
 );
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});
 const maker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"maker"});
 assert.equal(taker.status,"priced");assert.equal(maker.status,"priced");
 if(taker.status!=="priced"||maker.status!=="priced")return;
 assert.equal(taker.sold.unslippedPriceBtcPerContract,.08,"taker sold leg uses the taker-sell print");
 assert.equal(taker.bought.unslippedPriceBtcPerContract,.03,"taker bought leg uses the taker-buy print");
 assert.equal(maker.sold.unslippedPriceBtcPerContract,.09,"maker sold leg uses the taker-buy print (opposite side)");
 assert.equal(maker.bought.unslippedPriceBtcPerContract,.02,"maker bought leg uses the taker-sell print (opposite side)");
 assert.notEqual(taker.sold.priceBtcPerContract,maker.sold.priceBtcPerContract,"scenarios must not converge on the same evidence");
});

test("every priced estimate is explicitly labelled with the scenario that produced it",()=>{
 const s=spread([trade("BTC-8JAN24-39000-P",0,.08,"sell")],[trade("BTC-8JAN24-38000-P",0,.03,"buy")]);
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});
 assert.equal(taker.status,"priced");
 if(taker.status==="priced")assert.equal(taker.executionMode,"taker");
});

test("neither scenario is silently assumed: both come back unavailable when no evidence supports either",()=>{
 const s=spread([],[]);
 const maker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"maker"});
 const taker=estimateResearchSpread({spread:s,targetTimestamp:T,targetIndex:40000,slippageBps:0,executionMode:"taker"});
 assert.equal(maker.status,"unavailable");
 assert.equal(taker.status,"unavailable");
 assert.equal(maker.executionMode,"maker");
 assert.equal(taker.executionMode,"taker");
});
