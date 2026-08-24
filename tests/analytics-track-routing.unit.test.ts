import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {ANALYTICAL_TRACK_LAYERS,CAPITAL_BASIS_LABELS,REPORT_TRACK_ROUTES} from "../app/lib/analytical-track-layers.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/analysis-configuration.ts";
import {buildShortStrikeReport} from "../app/lib/short-strike/report.ts";
import {buildSpreadWidthReport} from "../app/lib/spread-width/report.ts";
import {buildDurationDteReport} from "../app/lib/duration-dte/report.ts";
import {buildUnderlyingResolutionReport} from "../app/lib/underlying-resolution/report.ts";
import {buildEconomicReport} from "../app/lib/economics/report.ts";

/**
 * The workspace presented "Pricing track" and "Execution assumption" as if they
 * determined every report. They did not: the reports answer different questions
 * and correctly use different analytical layers, and the execution-assumption
 * control reached no report at all because every layer sets its own scenario.
 *
 * These tests pin the corrected control semantics and routing. They deliberately
 * do not re-test any statistical methodology.
 */

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);
const H=36e5,ENTRY_INDEX=42000,QTY=1;
const SHORT_PREMIUM=.0075;
const LONG_PREMIUM:Record<number,number>={39000:.0030,38000:.0018,37000:.0010};

function candidate(eventId:string,longStrike:number,scenario:"maker"|"taker",over:Record<string,unknown>={}){
 const width=40000-longStrike,longPremium=LONG_PREMIUM[longStrike]!;
 const gross=(SHORT_PREMIUM-longPremium)*QTY,fees=.0004;
 return {
  event_id:eventId,candidate_id:`${eventId}-w${width}`,structure_execution_id:`${eventId}-w${width}~${scenario}`,
  direction:"long",option_type:"P",structure_type:"bull_put_credit",strike_method:"anchor",
  actual_strikes:{short:40000,long:longStrike,width},requested_strikes:{short:40000,long:longStrike,width},
  expiry_timestamp_utc:D(8),actual_dte:7,actual_dte_days:7,target_horizon_days:7,
  structure_entry_timestamp_utc:D(1),execution_scenario:scenario,execution_scenario_status:"evaluated",
  entry_index_price:ENTRY_INDEX,quantity:QTY,exit_policy:"settlement",
  entry_legs:{short:{price_native:SHORT_PREMIUM},long:{price_native:longPremium}},
  gross_credit_debit_native:gross,opening_fees_native:fees,net_opening_cash_flow_native:gross-fees,
  ...over,
 };
}

/**
 * Two structures on one MR event, evaluated under BOTH scenarios, so removing
 * one scenario's coverage is a real change rather than an empty no-op.
 */
function fixture(over:{takerCoverage?:boolean}={}):AnalysisDataset{
 const events=[{event_id:"e1",direction:"long",entry_price:ENTRY_INDEX,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),signal_timestamp_utc:D(1),
  vpoc_trigger_timestamp_utc:D(3),vpoc_decision_timestamp_utc:D(3),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"}];
 const underlying_path=Array.from({length:24*5},(_,i)=>({event_id:"e1",
  timestamp_utc:new Date(T(1)+i*H).toISOString(),open:42000,high:42400,low:41600,close:42000,index_price:42000}));
 const maker=[candidate("e1",39000,"maker"),candidate("e1",38000,"maker"),candidate("e1",37000,"maker")];
 const taker=over.takerCoverage===false
  ?[candidate("e1",39000,"taker",{execution_scenario_status:"unavailable",execution_scenario_reason:"sparse tape"}),
    candidate("e1",38000,"taker",{execution_scenario_status:"unavailable",execution_scenario_reason:"sparse tape"}),
    candidate("e1",37000,"taker",{execution_scenario_status:"unavailable",execution_scenario_reason:"sparse tape"})]
  :[candidate("e1",39000,"taker"),candidate("e1",38000,"taker"),candidate("e1",37000,"taker")];
 const availability=maker.map((c,i)=>({availability_id:`a${i}`,event_id:"e1",candidate_id:c.candidate_id,
  strategy_variant_id:c.candidate_id,contract_status:"resolved"}));
 return {filename:"fixture.zip",schemaVersion:"3.6.0",migratedFrom:null,run:{},
  tables:{events,underlying_path,candidates:[...maker,...taker],availability,
   outcomes:[],valuations:[],margin_scenarios:[],structure_economics:[]},
  counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;
}

/* ---------------- reference-primary routing ---------------- */

test("ROUTING: Reference is the Short Strike primary layer, with maker and taker as robustness",()=>{
 const report=buildShortStrikeReport(fixture());
 assert.equal(report.scenario,"reference","the primary analysis is not an execution scenario");
 assert.ok(report.robustness,"maker and taker are attached beside it");
 assert.equal(report.robustness!.maker.scenario,"maker");
 assert.equal(report.robustness!.taker.scenario,"taker");
 // Robustness layers are separate reports, never pooled into the primary one.
 assert.notEqual(report.robustness!.maker,report.robustness!.taker);
 const route=REPORT_TRACK_ROUTES.find(r=>r.report==="Short Strike")!;
 assert.equal(route.primaryLayer,"reference");
 assert.deepEqual([...route.robustnessLayers],["immediate_maker","immediate_taker"]);
});

test("ROUTING: Reference is the Spread Width primary layer, with maker and taker as robustness",()=>{
 const report=buildSpreadWidthReport(fixture());
 assert.equal(report.scenario,"reference");
 assert.equal(report.robustness!.maker.scenario,"maker");
 assert.equal(report.robustness!.taker.scenario,"taker");
 const route=REPORT_TRACK_ROUTES.find(r=>r.report==="Spread Width")!;
 assert.equal(route.primaryLayer,"reference");
 assert.deepEqual([...route.robustnessLayers],["immediate_maker","immediate_taker"]);
});

test("ROUTING: Economics keeps Reference primary and does not let observed layers overwrite it",()=>{
 const report=buildEconomicReport(fixture(),DEFAULT_ANALYSIS_CONFIGURATION);
 assert.equal(report.configuration.executionScenario,"reference");
 assert.equal(report.configuration.pricingTrack,"reference");
 // The rendered primary positions ARE the reference layer, not a maker layer.
 assert.equal(report.positions,report.reference.positions);
 assert.equal(report.portfolio,report.reference.portfolio);
 assert.ok(report.observed.maker&&report.observed.taker,"observed layers exist beside it");
 assert.notEqual(report.observed.maker,report.reference,"and are not the same object as the baseline");
});

/* ---------------- execution independence ---------------- */

test("ROUTING: Underlying Resolution is invariant to execution assumptions",()=>{
 const withTaker=buildUnderlyingResolutionReport(fixture());
 const withoutTaker=buildUnderlyingResolutionReport(fixture({takerCoverage:false}));
 assert.deepEqual(withoutTaker.endpoints,withTaker.endpoints,"MR resolution is a property of the underlying path");
 assert.equal(withoutTaker.effectiveN,withTaker.effectiveN);
 assert.equal(withoutTaker.totalEvents,withTaker.totalEvents);
 assert.equal(REPORT_TRACK_ROUTES.find(r=>r.report==="Underlying Resolution")!.executionDependent,false);
 assert.equal(REPORT_TRACK_ROUTES.find(r=>r.report==="Underlying Resolution")!.robustnessLayers.length,0);
});

test("ROUTING: Duration structural numbers do not change when maker/taker coverage changes",()=>{
 const full=buildDurationDteReport(fixture(),"maker",DEFAULT_ANALYSIS_CONFIGURATION);
 const thin=buildDurationDteReport(fixture({takerCoverage:false}),"maker",DEFAULT_ANALYSIS_CONFIGURATION);
 // Execution-INDEPENDENT structural analysis: one row per structure.
 assert.equal(thin.structures.length,full.structures.length);
 assert.deepEqual(thin.actualDteAll,full.actualDteAll);
 assert.equal(thin.headline.medianActualDteDays,full.headline.medianActualDteDays);
 assert.equal(thin.headline.effectiveEvents,full.headline.effectiveEvents);
 assert.deepEqual(thin.dteBuffer,full.dteBuffer);
 assert.deepEqual(thin.outcomeBeforeExpiry,full.outcomeBeforeExpiry);
 // Execution-DEPENDENT coverage genuinely did move, so the check above is real.
 assert.notDeepEqual(thin.headline.taker,full.headline.taker);
});

test("ROUTING: the Duration display scenario declares exactly what it scopes",()=>{
 const scope=buildDurationDteReport(fixture(),"maker",DEFAULT_ANALYSIS_CONFIGURATION).executionScenarioScope;
 assert.equal(scope.displayScenario,"maker");
 assert.ok(scope.appliesTo.length>0&&scope.independentOf.length>0);
 assert.match(scope.independentOf.join(" "),/actual DTE/i);
 assert.match(scope.appliesTo.join(" "),/holding period/i);
 assert.match(scope.note,/not a report-wide track selector/i);
});

/* ---------------- modeled sensitivity ---------------- */

test("ROUTING: expected modeled execution stays explicitly unavailable when uncalibrated",()=>{
 const report=buildEconomicReport(fixture(),DEFAULT_ANALYSIS_CONFIGURATION);
 assert.equal(report.modeledStatus,"Uncalibrated sensitivity");
 const expected=report.modeled.modeled_expected!,conservative=report.modeled.modeled_conservative!;
 // Uncalibrated means explicitly Unavailable, never zero. The rows survive so
 // the missingness stays visible and countable.
 assert.ok(expected.positions.length>0,"the structures are still counted, not silently dropped");
 for(const position of expected.positions){
  assert.notEqual(position.status,"priced","an uncalibrated modelled opening is not a priced result");
  assert.equal(position.pnlBtc,null,"and is Unavailable rather than zero");
  assert.equal(position.pnlUsd,null);
  assert.ok(position.missingReason,"with an explicit reason");
 }
 // Conservative modelled execution is never substituted for expected.
 assert.notEqual(expected,conservative);
 const layer=ANALYTICAL_TRACK_LAYERS.find(x=>x.id==="modeled_expected")!;
 assert.match(layer.availability!,/calibration/i);
 assert.equal(layer.group,"modeled_sensitivity");
 assert.equal(ANALYTICAL_TRACK_LAYERS.find(x=>x.id==="modeled_conservative")!.group,"modeled_sensitivity");
});

/* ---------------- visible control surface ---------------- */

// The visible control surface is asserted from component source, which is this
// repository's established pattern for component-level checks.
const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8");
const form=read("../app/components/analysis-configuration-form.tsx");
const legend=read("../app/components/analytical-track-legend.tsx");
const shell=read("../app/components/shell/research-analytics.tsx");

test("CONTROLS: no workspace label claims one maker/taker selector governs every report",()=>{
 assert.doesNotMatch(form,/Execution assumption/i,
  "a control that reaches no report must not be presented as a required workspace choice");
 // A pricing-track control that remains must state the scope it actually has.
 assert.doesNotMatch(form,/>Pricing track</,"it is no longer presented as a workspace-wide pricing selector");
 assert.match(form,/Holding-period valuation track/);
 assert.match(form,/Duration &amp; DTE operational holding subsection only/);
 assert.match(form,/None of them selects an analytical track for the workspace/);
 // And the legend states there is no such selector at all.
 assert.match(legend,/no workspace-wide execution selector/i);
 // The root component no longer hard-codes a scenario literal at the call site.
 assert.doesNotMatch(shell,/buildDurationDteReport\(d,"maker"/);
 assert.match(shell,/DURATION_DISPLAY_SCENARIO/);
 assert.match(shell,/Duration & DTE is NOT a maker report/);
});

test("CONTROLS: the visible capital basis says Maximum structural loss",()=>{
 assert.equal(CAPITAL_BASIS_LABELS.maximum_economic_loss,"Maximum structural loss");
 // The form renders its options from the canonical label map, so the visible
 // wording cannot drift away from it.
 assert.match(form,/CAPITAL_BASIS_LABELS/);
 assert.doesNotMatch(form,/Maximum economic loss/);
 assert.match(form,/CAPITAL_BASIS_COMPATIBILITY_NOTE/,"the retained token is documented in the UI");
 for(const label of Object.values(CAPITAL_BASIS_LABELS))assert.doesNotMatch(label,/economic loss/i);
});

test("CONTROLS: the legend is read-only methodology, not another control panel",()=>{
 assert.doesNotMatch(legend,/<select|<input|<button/,"nothing in the legend is selectable");
 assert.doesNotMatch(legend,/onChange|onClick/,"and nothing in it mutates configuration");
 assert.match(legend,/Primary baseline|ANALYTICAL_LAYER_GROUPS/);
 assert.match(legend,/REPORT_TRACK_ROUTES/,"the routing table is rendered from the canonical map");
 assert.match(legend,/ANALYTICAL_TRACK_LAYERS/);
 // The canonical map itself carries the three groups and the calibration gate.
 assert.deepEqual([...new Set(ANALYTICAL_TRACK_LAYERS.map(x=>x.group))].sort(),
  ["execution_robustness","modeled_sensitivity","primary_baseline"]);
 assert.match(ANALYTICAL_TRACK_LAYERS.find(x=>x.id==="modeled_expected")!.availability!,/Unavailable unless the existing calibration/);
});

test("CONTROLS: every routed report names a layer the legend actually defines",()=>{
 const ids=new Set(ANALYTICAL_TRACK_LAYERS.map(x=>x.id));
 for(const route of REPORT_TRACK_ROUTES){
  if(route.primaryLayer!=="underlying_path")assert.ok(ids.has(route.primaryLayer),`${route.report} primary layer`);
  for(const layer of route.robustnessLayers)assert.ok(ids.has(layer),`${route.report} robustness layer ${layer}`);
 }
});
