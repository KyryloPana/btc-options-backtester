import assert from "node:assert/strict";
import test from "node:test";
import { buildExpiryCandidates, executionClock, simulateTakerSpread, type ContractCandidateManifest, type ContractSeries, type DesiredSpread } from "../app/lib/backtester.ts";
import { displayedProfit, entryEvidenceExplanation, observationStatus, spreadIdentity } from "../app/lib/observation-presentation.ts";
import { runEventBacktest, type StrategyObservation, type StrategyVariantConfig } from "../app/lib/observation-ledger.ts";

const metadata = { minimumTradeAmount: .1, amountStep: .1, amountPrecision: 1, source: "deribit-instrument-metadata" as const };
const series = (name:string,strike:number,trades:Array<[number,"buy"|"sell",number]>):ContractSeries => ({instrumentName:name,strike,optionType:"P",expiryTimestamp:10_000,expiryLabel:"fixture",sourceFiles:[`api:${name}`],creationTimestamp:1,amountMetadata:metadata,firstTradeTimestamp:trades[0]?.[0]??0,lastTradeTimestamp:trades.at(-1)?.[0]??0,trades:trades.map(([timestamp,direction,amount],i)=>({timestamp,direction,amount,price:.01+i*.001,indexPrice:50_000,instrumentName:name}))});
const desired:DesiredSpread={id:"aug-2024-7-1000",targetDte:7,targetWidth:1000,anchorStrike:50_000,soldStrike:50_000,boughtStrike:49_000,optionType:"P",spreadKind:"credit",structure:"put credit spread",buffered:false};
const manifest:ContractCandidateManifest={requestId:desired.id,targetDte:7,minDte:5,maxDte:10,desiredSoldStrike:50_000,desiredBoughtStrike:49_000,expiryTimestamp:10_000,expiryLabel:"fixture",actualDte:7,soldInstrumentName:"BTC-X-50000-P",boughtInstrumentName:"BTC-X-49000-P",soldStrike:50_000,boughtStrike:49_000,soldCreationTimestamp:1,boughtCreationTimestamp:1,strikeResolutionSensible:true,strikeResolutionNote:"exact"};
const config:StrategyVariantConfig={targetExpiryHorizonDays:7,widthUsd:1000,spreadKind:"credit",expirySelectionPolicy:"liquidity-aware",candidateRankPolicy:"rank-1-only",amount:1,primaryExecutionScenario:"taker-tape-proxy",latencyMs:0,fillWaitMs:100,synchronizationThresholdMs:20,slippageBps:0,exitPolicy:{rule:"none"},requestedPackaging:"legs",executionRoute:"synchronized-leg-proxy",feeTier:"standard",marginModel:"segregated_sm"};

test("yellow resolved contracts retain identity, tapes and amount metadata through candidate and observation adapter",()=>{
 const sold=series(manifest.soldInstrumentName!,50_000,[[90,"sell",1],[110,"sell",1]]), bought=series(manifest.boughtInstrumentName!,49_000,[[80,"buy",1],[115,"buy",1]]);
 const [candidate]=buildExpiryCandidates([desired],[manifest],100,50_000,[sold,bought],"taker","liquidity-aware");
 assert.equal(candidate.retrievalStatus,"ready"); assert.equal(candidate.expiryRank,1); assert.equal(candidate.soldContract?.instrumentName,sold.instrumentName); assert.deepEqual(candidate.boughtContract?.amountMetadata,metadata);
 const o=runEventBacktest({event:{id:"aug",label:"August 2024",direction:"long",entryDate:"1970-01-01",entryTimestamp:100,entryTimeSource:"manual",entryPrice:50_000},candidates:[candidate],candles:[],config});
 assert.equal(o.entryExecution?.status,"filled"); assert.equal(o.spread?.soldContract?.sourceFiles[0],`api:${sold.instrumentName}`); assert.deepEqual(spreadIdentity(o.spread!),{soldStrike:50_000,boughtStrike:49_000,width:1000});
});

test("unresolved and retrieval-failed candidates are unavailable, unranked and never executed",()=>{
 const [candidate]=buildExpiryCandidates([desired],[{...manifest,dataStatus:"data-unavailable",failedInstruments:[manifest.boughtInstrumentName!]}],100,50_000,[],"taker","liquidity-aware");
 assert.equal(candidate.expiryRank,undefined); assert.equal(candidate.entryLiquidityQuality,undefined);
 const o=runEventBacktest({event:{id:"aug",label:"August",direction:"long",entryDate:"1970-01-01",entryTimestamp:100,entryPrice:50_000},candidates:[candidate],candles:[],config});
 assert.equal(o.eventOutcome,"data-unavailable"); assert.equal(o.executedNetPnl,undefined); assert.equal(observationStatus(o),"Unavailable");
});

test("causal rejection diagnostics separate pre-order, amount, and synchronization evidence",()=>{
 const clock=executionClock({signalTimestamp:100,signalTimePrecision:"second",configuredLatencyMs:0,maxFillWaitMs:100});
 const insufficient=simulateTakerSpread({soldContract:series("S",50_000,[[90,"sell",5],[110,"sell",.4]]),boughtContract:series("B",49_000,[[115,"buy",1]])},clock,1);
 assert.equal(insufficient.sold.reasonCode,"insufficient-compatible-amount"); assert.equal(insufficient.sold.printsBeforeOrder,1); assert.match(insufficient.sold.reason,/only 0.4 was observed/); assert.match(entryEvidenceExplanation({entryExecution:insufficient,unavailableReason:"",eventOutcome:"no-trade:no-entry-fill"} as StrategyObservation),/short leg/);
 const sync=simulateTakerSpread({soldContract:series("S",50_000,[[110,"sell",1]]),boughtContract:series("B",49_000,[[150,"buy",1]])},clock,1,0,20);
 assert.equal(sync.reasonCode,"leg-synchronization-exceeded");
});

test("no-trade presentation never renders selected-exit zero profit",()=>{
 const o={eventOutcome:"no-trade:no-entry-fill",executedNetPnl:{usd:0}} as StrategyObservation;
 assert.equal(observationStatus(o),"No trade"); assert.equal(displayedProfit(o),undefined);
});
