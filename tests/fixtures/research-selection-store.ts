import {migrateResearchSelectionStore, type ResearchSelectionStore} from "../../app/lib/research-selections.ts";

/**
 * The canonical research selection fixture shared by the bundle-contract tests.
 *
 * Extracted so the economic-track tests exercise the SAME store the existing
 * bundle tests do; two divergent fixtures would let one suite pass while the
 * other described a different world.
 */
export const now="2026-08-16T00:00:00.000Z",ts=Date.parse(now),config={applicationBuild:"120adbb",pricingEngineVersion:"v1",qualityRulesVersion:"q1",feeScheduleVersion:"f1",dteWindows:{},expirySelectionMode:"all",executionMode:"taker",pricingAssumption:"research-estimate",pricingTracks:["vwap","iv"],historicalEvidenceWindows:{},synchronizationThresholds:{},qualityThresholds:{},feeAssumptions:{},settlementRules:{},valuationInterval:"4h",modelAssumptions:{},generatedAtUtc:now};
export const cand=(id:string,status="priced")=>({candidateId:`deribit~${id}`,venue:"deribit" as const,selected:id<"d",status:status as "priced"|"unavailable",availabilityReasons:status==="priced"?[]:["missing"],targetHorizon:id==="red"||id==="u2"?14:7,eligibleDteRange:{min:5,max:10},actualExpiryTimestamp:ts+7*864e5,actualDte:7,requestedStrikes:{short:100,long:id==="red"||id==="u2"?80:90,width:id==="red"||id==="u2"?20:10},actualStrikes:{short:100,long:id==="red"||id==="u2"?80:90,width:id==="red"||id==="u2"?20:10},structure:"credit",optionType:"P",strikeMethod:"anchor",entryQuality:status==="priced"?"red" as const:null});
export const sel=(eventId:string,id:string)=>({selectionId:`selection~${id}`,eventId,candidateId:`deribit~${id}`,venue:"deribit" as const,selectedAtUtc:now,quantity:1,candidateSnapshot:{structure:"credit",optionType:"P",expiryTimestamp:ts+7*864e5,shortStrike:100,longStrike:90,actualWidth:10,targetDte:id==="red"?14:7,actualDte:7,strikeMethod:"anchor"},entrySnapshot:{status:"priced",targetTimestamp:ts,entryTargetIndex:100,estimateQuality:"red",priceSource:"direct-vwap",sold:{priceBtcPerContract:.02},bought:{priceBtcPerContract:.01},openingFeesBtc:.001,netOpeningCashFlowBtc:.009},valuationPathSnapshot:[{timestamp:ts,status:"priced",targetIndex:100,rawEstimate:{sold:{priceBtcPerContract:.02},bought:{priceBtcPerContract:.01}},modelEstimate:{sold:{priceBtcPerContract:.02},bought:{priceBtcPerContract:.01}},closingFeesBtc:.001,estimatedNetPnlBtc:.008,estimateQuality:"red"},{timestamp:ts+144e5,status:"missing",unavailableReason:"missing-target-index",missingField:"targetIndex",estimateQuality:"unavailable"}],outcomeSnapshots:[{label:"VPOC",status:"estimated",decisionTimestamp:ts+864e5,valuationTimestamp:ts+864e5,estimatedNetPnlBtc:.004,conversionIndex:101},{label:"Settlement",status:"estimated",decisionTimestamp:ts+7*864e5,valuationTimestamp:ts+7*864e5,estimatedNetPnlBtc:.006,conversionIndex:102}],marginSnapshot:{},evidenceTradeSnapshots:[{instrumentName:"BTC-X",tradeId:"t1",timestamp:ts,price:.02,amount:1,indexPrice:100}]});
export const store:ResearchSelectionStore={schemaVersion:"1.0.0",datasetId:"acceptance",updatedAtUtc:now,events:[{eventId:"e1",sourceRun:{event:{id:"e1",direction:"long",entryDate:"2026-08-16",entryTimestamp:ts,entryPrice:100}},generationSnapshot:{generatedAtUtc:now,configuration:config,candidates:[cand("a"),cand("b"),cand("u"),cand("z","unavailable")],underlyingHourlyPath:[{openTime:ts,closeTime:ts+36e5,open:100,high:101,low:99,close:100,volume:1}]},selectedStructures:[sel("e1","a"),sel("e1","b")]},{eventId:"e2",sourceRun:{event:{id:"e2",direction:"short",entryDate:"2026-08-16",entryTimestamp:ts,entryPrice:100}},generationSnapshot:{generatedAtUtc:now,configuration:{...config,generatedAtUtc:"2026-08-16T06:00:00.000Z"},candidates:[cand("c"),cand("red"),cand("u2")],underlyingHourlyPath:[]},selectedStructures:[sel("e2","c"),sel("e2","red")]}]};

/**
 * A structure with a genuine execution-independent reference valuation, path and
 * outcome set, and BOTH immediate execution scenarios unavailable. Shared so the
 * economic-track and final-integration suites judge the same world.
 */
export function referenceOnlyFixture(){
 const fixture=migrateResearchSelectionStore(structuredClone(store)) as ReturnType<typeof migrateResearchSelectionStore>;
 const event=fixture.events[0]!,s=structuredClone(event.selectedStructures[0]!) as Record<string,unknown>;
 const entry=structuredClone((s.executionScenarios as Record<string,Record<string,unknown>>).taker.entrySnapshot);
 s.contractResolution={status:"exact_resolved",reason:null,
  short:{instrumentName:"BTC-S",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:100,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true},
  long:{instrumentName:"BTC-L",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:90,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true}};
 // A genuine reference path AND outcome set, produced execution-independently.
 s.referenceValuation={status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:entry,
  valuationPathSnapshot:[
   {timestamp:ts,status:"priced",targetIndex:100,estimatedNetPnlBtc:.001,estimateQuality:"green",
    modelEstimate:{sold:{priceBtcPerContract:.01,model:{anchorIvDecimal:.55,anchorIvApiPercent:55,anchorTimestamp:ts,anchorIndex:100,targetIndex:100,dte:7}},
     bought:{priceBtcPerContract:.004,model:{anchorIvDecimal:.61,anchorIvApiPercent:61,anchorTimestamp:ts,anchorIndex:100,targetIndex:100,dte:7}}},
    soldIvSource:"local-observed-IV",longIvSource:"constant-entry-IV"},
   {timestamp:ts+4*36e5,status:"priced",targetIndex:101,estimatedNetPnlBtc:.002,estimateQuality:"green"},
  ],
  outcomeSnapshots:[
   {label:"VPOC",status:"estimated",decisionTimestamp:ts+2*36e5,valuationTimestamp:ts+2*36e5,estimatedNetPnlBtc:.0015,conversionIndex:101,estimateQuality:"green"},
   {label:"Settlement",status:"estimated",decisionTimestamp:ts+7*864e5,valuationTimestamp:ts+7*864e5,estimatedNetPnlBtc:.003,conversionIndex:102,estimateQuality:"green"},
  ],
  provenance:{executionIndependent:true,method:"causal fixture",engineVersion:"reference/1"}};
 // Both immediate execution scenarios are genuinely unavailable.
 s.executionScenarios={
  maker:{status:"unavailable",reason:"No maker tape.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},
  taker:{status:"not_evaluated",reason:"Taker was intentionally skipped.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}};
 s.selectionProvenance="model-only-diagnostic";
 fixture.events=[{...event,selectedStructures:[s]} as typeof event,{...fixture.events[1]!,selectedStructures:[]}];
 return fixture;
}
