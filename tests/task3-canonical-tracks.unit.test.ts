import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildShortStrikeReport} from "../app/lib/short-strike/report.ts";
import {buildSpreadWidthReport} from "../app/lib/spread-width/report.ts";
import {buildResearchAnalyticsModel,createResearchAnalyticsContext,datasetForAnalyticsTrack,resetResearchAnalyticsPerformanceCounters,researchAnalyticsPerformanceCounters} from "../app/lib/research-analytics-model.ts";

const day=(n:number)=>new Date(Date.UTC(2024,0,n)).toISOString();
const entry=(gross:number)=>({status:"priced",targetTimestamp:Date.parse(day(2)),valuationTimestamp:Date.parse(day(2)),entryTargetIndex:100,
 sold:{priceBtcPerContract:gross+.02},bought:{priceBtcPerContract:.02},grossSpreadBtc:gross,openingFeesBtc:.001,netOpeningCashFlowBtc:gross-.001,estimateQuality:"yellow"});
const ref=(gross:number)=>({status:"valued",source:"local_iv_interpolation",entrySnapshot:entry(gross),valuationPathSnapshot:[{timestamp:Date.parse(day(3)),estimatedNetPnlBtc:-.01,estimatedNetPnlUsd:-1}],outcomeSnapshots:[{label:"settlement",outcome_type:"settlement",valuationTimestamp:Date.parse(day(8)),estimatedNetPnlBtc:.02,estimatedNetPnlUsd:2}]});
function data():AnalysisDataset {
 const base={event_id:"e",expiry_timestamp_utc:day(10),actual_dte:8,structure_type:"credit_spread",option_type:"P",quantity:1,direction:"long",execution_scenario_status:"unavailable",execution_scenario_reason:"sparse tape"};
 const variants=[
  {candidate_id:"tech",strategy_variant_id:"tech",strike_method:"anchor",actual_strikes:{short:90,long:80,width:10},requested_strikes:{width:10},reference_valuation:ref(.08)},
  {candidate_id:"buff",strategy_variant_id:"buff",strike_method:"buffered",actual_strikes:{short:85,long:75,width:10},requested_strikes:{width:10},reference_valuation:ref(.06)},
  {candidate_id:"wide",strategy_variant_id:"wide",strike_method:"anchor",actual_strikes:{short:90,long:70,width:20},requested_strikes:{width:25},reference_valuation:ref(.09)},
 ];
 const candidates=variants.flatMap(v=>["maker","taker"].map(execution_scenario=>({...base,...v,structure_execution_id:`${v.candidate_id}~${execution_scenario}`,execution_scenario})));
 return {filename:"task3.zip",schemaVersion:"3.2.0",migratedFrom:null,run:{},tables:{candidates,availability:variants.map(v=>({event_id:"e",strategy_variant_id:v.strategy_variant_id})),events:[{event_id:"e",entry_timestamp_utc:day(1),signal_timestamp_utc:day(1),entry_price:100,extreme_price:92,invalidation_price:88,range_low:80,range_high:100}],underlying_path:[],outcomes:[],valuations:[],margin_scenarios:[]},counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]};
}

test("Task 3 structural reports retain Reference as their counterfactual basis",()=>{
 const d=data(),model=buildResearchAnalyticsModel(d),projected=datasetForAnalyticsTrack(d,"reference");
 assert.equal(model.observations.length,3);
 assert.equal(projected.tables.candidates?.length,3);
 const strike=buildShortStrikeReport(d);
 assert.equal(strike.scenario,"reference");
 assert.equal(strike.pairs.length,0,"no empirical Q50 means no central economic pair");
 assert.equal(strike.robustness?.maker.pairs[0]?.economicsComparable,false);
 assert.equal(strike.robustness?.taker.pairs[0]?.economicsComparable,false);
 const width=buildSpreadWidthReport(d);
 assert.equal(width.scenario,"reference");
 assert.equal(width.groups.length,0,"Reference is not substituted for missing Q50 economics");
 assert.equal(width.robustness?.maker.groups[0]?.steps[0]?.economicsComparable,false);
 assert.equal(width.capital.length,0);
});

test("one dataset owns one normalization and reuses each track projection",()=>{
 resetResearchAnalyticsPerformanceCounters();
 const d=data(),context=createResearchAnalyticsContext(d);
 assert.equal(buildResearchAnalyticsModel(d),context.model);
 const reference=context.projection("reference");
 assert.equal(datasetForAnalyticsTrack(d,"reference"),reference);
 assert.equal(context.projection("reference"),reference);
 const modeled=context.projection("modeled_expected");
 assert.equal(datasetForAnalyticsTrack(d,"modeled_expected"),modeled);
 assert.deepEqual(researchAnalyticsPerformanceCounters(),{normalizationBuilds:1,projectionBuilds:2});
 assert.deepEqual(context.materializedTracks,["reference","modeled_expected"]);
});
