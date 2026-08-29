import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildResearchAnalyticsModel,datasetForAnalyticsTrack} from "../app/lib/research-analytics-model.ts";
import {normalizeWidthStructures} from "../app/lib/spread-width/normalize.ts";
import {buildSpreadWidthReport} from "../app/lib/spread-width/report.ts";
import {buildShortStrikeReport} from "../app/lib/short-strike/report.ts";
import {buildDurationDteReport} from "../app/lib/duration-dte/report.ts";
import {buildUnderlyingResolutionReport} from "../app/lib/underlying-resolution/report.ts";
import {buildExitPolicyReport} from "../app/lib/exit-policy/report.ts";
import {normalizeExitPolicies} from "../app/lib/exit-policy/normalize.ts";
import {buildEconomicReport,economicLayerSummaries} from "../app/lib/economics/report.ts";
import {buildFuturesComparisonReport} from "../app/lib/futures-comparison/report.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/analysis-configuration.ts";
import {canonicalStructuralLoss} from "../app/lib/maximum-economic-loss.ts";
import {equalRiskFuturesQuantity} from "../app/lib/futures-baseline.ts";

/**
 * ONE composed fixture across all three Analytics wiring layers.
 *
 * The focused Task 1-3 suites each test their own layer. This one exists to
 * catch the cross-layer regressions that only appear when the layers are wired
 * together, labelled A-J below. It deliberately does not re-test any statistical
 * methodology.
 *
 * Shape: three MR events. e1 carries three widths and a second strike placement
 * under BOTH maker and taker, plus a canonical futures baseline -- the shape
 * that makes a denominator defect visible. e2 is a bear call with a delayed
 * track that has a causal post-entry path and a second, entry-only delayed
 * track. e3 is unresolved with no selected structure at all.
 */

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);
const H=36e5,IDX=42000,QTY=1,FEES=.0004;

const CONFIG={...DEFAULT_ANALYSIS_CONFIGURATION,exitPolicy:"settlement_benchmark" as const,pricingTrack:"raw_vwap" as const};

interface Spec {
 readonly eventId:string;readonly id:string;readonly optionType:"C"|"P";
 readonly shortStrike:number;readonly longStrike:number;
 readonly shortPremium:number;readonly longPremium:number;
 readonly strikeMethod:string;
}
const payoffInput=(s:Spec)=>({optionType:s.optionType,shortStrike:s.shortStrike,longStrike:s.longStrike,
 shortEntryPremiumBtc:s.shortPremium,longEntryPremiumBtc:s.longPremium,
 entryIndex:IDX,amount:QTY,openingFeesBtc:FEES,expiryTimestamp:T(9)});
const lossOf=(s:Spec)=>canonicalStructuralLoss(payoffInput(s));

/** e1: one short strike, three widths — plus one buffered placement. */
const BULL=(id:string,longStrike:number,longPremium:number,strikeMethod="anchor",shortStrike=40000):Spec=>
 ({eventId:"e1",id,optionType:"P",shortStrike,longStrike,shortPremium:.0075,longPremium,strikeMethod});
const E1:Spec[]=[
 BULL("e1-w1000",39000,.0030),BULL("e1-w2000",38000,.0018),BULL("e1-w3000",37000,.0010),
 BULL("e1-buffered",38000,.0018,"buffered",39000),
];
/** e2: a bear call — the structure whose fee-inclusive maximum is unbounded. */
const E2:Spec={eventId:"e2",id:"e2-bearcall",optionType:"C",shortStrike:44000,longStrike:45000,
 shortPremium:.0075,longPremium:.0030,strikeMethod:"anchor"};

const entrySnapshot=(s:Spec,at:number)=>({status:"priced",targetTimestamp:at,valuationTimestamp:at,
 sold:{priceBtcPerContract:s.shortPremium},bought:{priceBtcPerContract:s.longPremium},
 grossSpreadBtc:s.shortPremium-s.longPremium,openingFeesBtc:FEES,
 netOpeningCashFlowBtc:s.shortPremium-s.longPremium-FEES,entryTargetIndex:IDX,estimateQuality:"green"});

/** Every canonical fixed-time policy plus the thesis endpoints. */
const outcomeSnapshots=(from:number)=>[
 {label:"vpoc",status:"estimated",decisionTimestamp:T(4),valuationTimestamp:T(4),estimatedNetPnlBtc:.0021,estimatedNetPnlUsd:88.2},
 {label:"invalidation",status:"not-hit"},
 {label:"3D",status:"estimated",decisionTimestamp:from+3*24*H,valuationTimestamp:from+3*24*H,estimatedNetPnlBtc:.0018,estimatedNetPnlUsd:75.6},
 {label:"5D",status:"estimated",decisionTimestamp:from+5*24*H,valuationTimestamp:from+5*24*H,estimatedNetPnlBtc:.0026,estimatedNetPnlUsd:109.2},
 {label:"7D",status:"estimated",decisionTimestamp:from+7*24*H,valuationTimestamp:from+7*24*H,estimatedNetPnlBtc:.0031,estimatedNetPnlUsd:130.2},
 {label:"50 credit",status:"estimated",decisionTimestamp:T(4),valuationTimestamp:T(4),estimatedNetPnlBtc:.0020,estimatedNetPnlUsd:84},
 {label:"70 credit",status:"estimated",decisionTimestamp:T(5),valuationTimestamp:T(5),estimatedNetPnlBtc:.0028,estimatedNetPnlUsd:117.6},
 {label:"settlement",status:"estimated",decisionTimestamp:T(9),valuationTimestamp:T(9),estimatedNetPnlBtc:.0041,estimatedNetPnlUsd:172.2},
];

const referenceValuation=(s:Spec)=>({status:"valued",source:"local_iv_interpolation",
 entrySnapshot:entrySnapshot(s,T(1)),
 valuationPathSnapshot:[{timestamp:T(2),estimatedNetPnlBtc:.0009},{timestamp:T(3),estimatedNetPnlBtc:.0015}],
 outcomeSnapshots:outcomeSnapshots(T(1)),provenance:{executionIndependent:true,quality:"green"}});

/** A COMPLETE delayed track: delayed opening plus a causal post-entry path. */
const delayedComplete=(s:Spec)=>({status:"evaluated",source:"delayed-engine",
 entrySnapshot:entrySnapshot(s,T(2)),
 valuationPathSnapshot:[{timestamp:T(3),estimatedNetPnlBtc:.0008},{timestamp:T(4),estimatedNetPnlBtc:.0012}],
 outcomeSnapshots:[{label:"settlement",status:"estimated",decisionTimestamp:T(9),valuationTimestamp:T(9),estimatedNetPnlBtc:.0035,estimatedNetPnlUsd:147}]});
/** ENTRY-ONLY delayed evidence: an opening with no causal post-entry path. */
const delayedEntryOnly=(s:Spec)=>({status:"evaluated",source:"delayed-engine",
 entrySnapshot:entrySnapshot(s,T(2)),valuationPathSnapshot:[],outcomeSnapshots:[]});

function candidate(s:Spec,scenario:"maker"|"taker",over:Record<string,unknown>={}){
 const gross=(s.shortPremium-s.longPremium)*QTY;
 return {event_id:s.eventId,candidate_id:s.id,strategy_variant_id:s.id,
  structure_execution_id:`${s.id}~${scenario}`,
  direction:s.optionType==="C"?"short":"long",option_type:s.optionType,
  structure_type:s.optionType==="C"?"bear_call_credit":"bull_put_credit",strike_method:s.strikeMethod,
  actual_strikes:{short:s.shortStrike,long:s.longStrike,width:Math.abs(s.shortStrike-s.longStrike)},
  requested_strikes:{short:s.shortStrike,long:s.longStrike,width:Math.abs(s.shortStrike-s.longStrike)},
  expiry_timestamp_utc:D(9),actual_dte:8,actual_dte_days:8,target_horizon_days:7,exit_policy:"settlement",
  structure_entry_timestamp_utc:D(1),execution_scenario:scenario,execution_scenario_status:"evaluated",
  entry_index_price:IDX,quantity:QTY,
  entry_legs:{short:{price_native:s.shortPremium},long:{price_native:s.longPremium}},
  gross_credit_debit_native:gross,opening_fees_native:FEES,net_opening_cash_flow_native:gross-FEES,
  reference_valuation:referenceValuation(s),
  ...over};
}

/** Exported canonical structural loss, from the canonical helper. */
const economicsRow=(s:Spec)=>{
 const loss=lossOf(s);
 return {candidate_id:s.id,event_id:s.eventId,
  maximum_structural_loss_status:loss.status,
  maximum_structural_loss_usd:loss.usd,maximum_structural_loss_native:loss.btcAtReferenceIndex,
  maximum_structural_loss_reference_index:loss.referenceIndex,
  maximum_structural_loss_settlement_index:loss.worstStructuralIndex,
  maximum_structural_loss_method:loss.method,maximum_structural_loss_method_version:loss.methodVersion,
  maximum_structural_loss_unavailable_reason:loss.reason,breakeven_index:loss.breakevenIndex,
  settlement_fee_treatment:{included_in_structural_loss:false,
   global_fee_inclusive_maximum:loss.settlementFees.globalFeeInclusiveMaximum,
   global_fee_inclusive_maximum_reason:loss.settlementFees.globalFeeInclusiveMaximumReason,
   scenario_index:loss.settlementFees.scenarioIndex,scenario_label:loss.settlementFees.scenarioLabel,
   scenario_delivery_fees_btc:loss.settlementFees.scenarioDeliveryFeesBtc,
   scenario_delivery_fees_usd:loss.settlementFees.scenarioDeliveryFeesUsd}};
};

const RISK_PER_UNIT=2200;
const futuresRow=(eventId:string,over:Record<string,unknown>={})=>({
 event_id:eventId,comparison_id:`${eventId}~futures`,instrument:"BTC-PERPETUAL",venue:"deribit",
 availability:"available",direction:"long",
 reference_entry_timestamp_utc:D(1),reference_entry_price:IDX,reference_entry_basis:"bar_close",
 exit_policy:"vpoc",exit_timestamp_utc:D(4),exit_price:43500,exit_status:"available",holding_hours:72,
 gross_pnl_usd_per_unit:1500,fees_usd_per_unit:42.75,slippage_usd_per_unit:0,
 net_pnl_usd_per_unit_before_funding:1457.25,
 funding_usd_per_unit:-7.25,funding_status:"available",funding_source:"deribit",
 funding_intervals_expected:72,funding_intervals_observed:72,
 net_pnl_usd_per_unit_after_funding:1450,risk_to_invalidation_usd_per_unit:RISK_PER_UNIT,
 unit_convention:"per 1 BTC-equivalent of perpetual notional, quoted in USD",
 endpoints:[
  {policy:"vpoc",trigger_timestamp_utc:D(3),decision_timestamp_utc:D(3),observation_timestamp_utc:D(4),
   observation_price:43500,outcome:"reached",status:"available",reason_code:null},
  // One deliberately UNAVAILABLE endpoint: the event must survive it.
  {policy:"invalidation",trigger_timestamp_utc:null,decision_timestamp_utc:null,observation_timestamp_utc:null,
   observation_price:null,outcome:"not_reached",status:"not_reached",reason_code:"futures_invalidation_not_reached"},
  {policy:"fixed_3d",trigger_timestamp_utc:D(4),decision_timestamp_utc:D(4),observation_timestamp_utc:D(4),
   observation_price:43000,outcome:"reached",status:"available",reason_code:null},
 ],
 reason_codes:[],...over});

interface FixtureOptions {
 /** Drop every taker row, to prove execution evidence never moves event N. */
 readonly withoutTaker?:boolean;
 /**
  * Give CONSERVATIVE modelled execution a genuinely evaluated snapshot while
  * EXPECTED stays uncalibrated. Without this asymmetry, substituting one for the
  * other is undetectable because both would be unavailable anyway.
  */
 readonly calibratedConservative?:boolean;
 /** Drop the extra widths and the buffered placement. */
 readonly singleStructure?:boolean;
 /** Export margin_scenarios without any available reconstruction. */
 readonly withoutMargin?:boolean;
}

function fixture(options:FixtureOptions={}):AnalysisDataset{
 const e1=options.singleStructure?[E1[0]!]:E1;
 const specs=[...e1,E2];
 const makers=[
  ...e1.map(s=>candidate(s,"maker")),
  candidate(E2,"maker",{delayed_execution:{maker:delayedComplete(E2),taker:delayedEntryOnly(E2)}}),
 ].map(c=>options.calibratedConservative
  ?{...c,modeled_execution:{
     conservative:{status:"evaluated",source:"modeled-conservative",modelVersion:"mc-1",
      entrySnapshot:entrySnapshot(E1[0]!,T(1)),
      valuationPathSnapshot:[{timestamp:T(3),estimatedNetPnlBtc:.0007}],
      outcomeSnapshots:[{label:"settlement",status:"estimated",decisionTimestamp:T(9),
       valuationTimestamp:T(9),estimatedNetPnlBtc:.0029,estimatedNetPnlUsd:121.8}]},
     expected:{status:"unavailable",reason:"calibration requirements are not met"}}}
  :c);
 const takers=options.withoutTaker?[]:specs.map(s=>candidate(s,"taker"));
 // e3 is a genuine MR event with NO viable structure at all.
 const events=[
  {event_id:"e1",direction:"long",entry_price:IDX,extreme_price:40050,invalidation_price:39800,
   range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),signal_timestamp_utc:D(1),
   vpoc_trigger_timestamp_utc:D(3),vpoc_decision_timestamp_utc:D(3),invalidation_decision_timestamp_utc:null,
   observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
  {event_id:"e2",direction:"short",entry_price:IDX,extreme_price:43950,invalidation_price:44200,
   range_low:39500,range_high:44500,vpoc_price:40500,entry_timestamp_utc:D(1),signal_timestamp_utc:D(1),
   vpoc_trigger_timestamp_utc:D(6),vpoc_decision_timestamp_utc:D(6),invalidation_decision_timestamp_utc:null,
   observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
  {event_id:"e3",direction:"long",entry_price:IDX,extreme_price:40050,invalidation_price:39800,
   range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),signal_timestamp_utc:D(1),
   vpoc_trigger_timestamp_utc:null,vpoc_decision_timestamp_utc:null,invalidation_decision_timestamp_utc:null,
   observation_end_timestamp_utc:D(20),sequence_status:"unresolved",censoring_status:"censored"},
 ];
 const underlying_path=events.flatMap(e=>Array.from({length:24*6},(_,i)=>({event_id:e.event_id,
  timestamp_utc:new Date(T(1)+i*H).toISOString(),open:42000,high:42400,low:41600,close:42000,index_price:42000})));
 const candidates=[...makers,...takers];
 // e3 keeps an availability row: an event with no viable structure is still an
 // opportunity and must stay in the denominator.
 const availability=[...specs.map((s,i)=>({availability_id:`a${i}`,event_id:s.eventId,candidate_id:s.id,
  strategy_variant_id:s.id,contract_status:"resolved"})),
  {availability_id:"a-e3",event_id:"e3",candidate_id:null,strategy_variant_id:"e3-none",
   contract_status:"confirmed_non_listing",reason:"no listed expiry in the DTE window"}];
 const outcomes=candidates.flatMap(c=>[
  {candidate_id:c.candidate_id,event_id:c.event_id,execution_scenario:c.execution_scenario,
   outcome_type:"settlement",status:"evaluated",trigger_status:"reached",source_status:"estimated",
   holding_hours:192,decision_available_timestamp_utc:D(9),valuation_timestamp_utc:D(9),
   raw_status:"priced",raw_net_pnl_native:.0041,raw_net_pnl_usd:172.2,
   iv_normalized_status:"priced",iv_normalized_net_pnl_native:.0041,iv_normalized_net_pnl_usd:172.2},
  {candidate_id:c.candidate_id,event_id:c.event_id,execution_scenario:c.execution_scenario,
   outcome_type:"invalidation",status:"unavailable",trigger_status:"not_reached",source_status:"not-hit",
   holding_hours:null,decision_available_timestamp_utc:null,valuation_timestamp_utc:null,
   raw_status:"not_applicable",raw_net_pnl_native:null,raw_net_pnl_usd:null},
 ]);
 // Per-leg IV must survive the importer and the projection untouched.
 const valuations=candidates.map(c=>({candidate_id:c.candidate_id,event_id:c.event_id,
  execution_scenario:c.execution_scenario,pricing_track:"raw_vwap",valuation_status:"priced",
  timestamp_utc:D(3),net_pnl_native:.0015,net_pnl_usd:63,
  short_leg_volatility:{iv_decimal:.62,iv_api_percentage:62,iv_units:"decimal",observation:"interpolated"},
  long_leg_volatility:{iv_decimal:.71,iv_api_percentage:71,iv_units:"decimal",observation:"interpolated"}}));
 const margin_scenarios=specs.map(s=>options.withoutMargin
  ?{candidate_id:s.id,event_id:s.eventId,margin_status:"unavailable",
    unavailable_reason:"no canonical valuation path for a historical margin reconstruction"}
  :{candidate_id:s.id,event_id:s.eventId,margin_status:"available",margin_model:"standard",
    account_configuration:"segregated_sm",reference_index:IDX,
    incremental_initial_margin:.02,incremental_maintenance_margin:.011,
    peak_initial_margin:.03,peak_maintenance_margin:.015,capital_days_margin:.24,
    maximum_structural_loss_usd:lossOf(s).usd,maximum_structural_loss_native:lossOf(s).btcAtReferenceIndex});
 return {filename:"integration.zip",schemaVersion:"3.6.0",migratedFrom:null,run:{},
  tables:{events,underlying_path,candidates,availability,outcomes,valuations,
   structure_economics:specs.map(economicsRow),margin_scenarios,
   // ONE futures baseline for e1, which carries four option structures.
   futures_comparisons:[futuresRow("e1")],
   futures_path:Array.from({length:5},(_,i)=>({event_id:"e1",venue:"deribit",
    timestamp_utc:new Date(T(1)+i*H).toISOString(),futures_price:IDX}))},
  counts:{},venues:["deribit"],sourceRuns:["run-1"],eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;
}

const eventIds=(d:AnalysisDataset)=>new Set(buildResearchAnalyticsModel(d).observations.map(o=>o.eventId));

/* ============ A / B: structures and execution tracks never inflate event N ============ */

test("A+B: neither extra structures nor maker/taker evidence inflates the MR event count",()=>{
 const full=fixture(),thin=fixture({singleStructure:true}),noTaker=fixture({withoutTaker:true});
 // e1 goes from four structures to one; the event count must not move.
 assert.equal(eventIds(full).size,eventIds(thin).size,"widths and strike placements are nested observations");
 assert.equal(eventIds(full).size,eventIds(noTaker).size,"execution tracks are nested observations");
 const underlyingFull=buildUnderlyingResolutionReport(full),underlyingThin=buildUnderlyingResolutionReport(thin);
 assert.equal(underlyingFull.totalEvents,underlyingThin.totalEvents);
 assert.equal(underlyingFull.effectiveN,underlyingThin.effectiveN);
 assert.deepEqual(buildUnderlyingResolutionReport(noTaker).endpoints,underlyingFull.endpoints,
  "MR resolution is a property of the underlying path alone");
 // Structure-level counts DID move, so the invariance above is not vacuous.
 const widthFull=normalizeWidthStructures(full).length,widthThin=normalizeWidthStructures(thin).length;
 assert.ok(widthFull>widthThin,"the structure population genuinely changed");
});

test("A+B: an event survives with no strict execution, no structures and no modelled layer",()=>{
 const model=buildResearchAnalyticsModel(fixture({withoutTaker:true}));
 // e3 has no viable structure at all and must remain an opportunity.
 assert.ok(model.denominators.generatedOpportunities>0);
 assert.ok(model.resolution.some(r=>r.eventId==="e3"),"an unresolved event stays visible");
 assert.equal(model.denominators.immediateTakerSupported,0,"no taker evidence anywhere");
 assert.ok(eventIds(fixture()).size>=2,"and the evented population is unchanged by that");
});

/* ============ C: fee-inclusive bear-call risk must not return ============ */

test("C: the bear call carries a bounded structural risk in every consumer, and they agree",()=>{
 const data=fixture();
 const canonical=lossOf(E2);
 assert.equal(canonical.status,"available");
 assert.ok(canonical.usd!<1e4,"the canonical bear-call loss is bounded");

 const width=normalizeWidthStructures(data).find(s=>s.candidateId===E2.id&&s.executionScenario==="maker")!;
 assert.equal(width.payoff.maximumStructuralLossUsd.value,canonical.usd);
 assert.equal(width.payoff.structuralLossSource,"structure_economics","consumed, not recomputed");
 // Delivery fees stay separate and the unbounded global maximum stays stated.
 assert.equal(width.payoff.settlementFees!.includedInStructuralLoss,false);
 assert.equal(width.payoff.settlementFees!.globalFeeInclusiveMaximum,"unbounded");
 // Standard Margin remains a distinct account quantity.
 assert.ok(Math.abs(width.capital.incrementalInitialMarginUsd.value!-.02*IDX)<1e-9);
 assert.notEqual(width.capital.incrementalInitialMarginUsd.value,width.capital.maximumStructuralLossUsd.value);

 const economics=buildEconomicReport(data,CONFIG);
 const position=economics.reference.positions.find(p=>p.candidateId===E2.id)!;
 assert.equal(position.maximumStructuralLossUsd.value,canonical.usd,
  "Economic Analysis reports the SAME canonical magnitude as Spread Width");
 const bull=lossOf(E1[1]!);
 assert.equal(economics.reference.positions.find(p=>p.candidateId===E1[1]!.id)!.maximumStructuralLossUsd.value,bull.usd);
 assert.ok(bull.usd!<Math.abs(E1[1]!.shortStrike-E1[1]!.longStrike)*QTY*1.01,"bounded by width");
});

test("C: a canonical export is consumed rather than laundered through the local helper",()=>{
 // The export deliberately disagrees with a local recomputation. Every consumer
 // must follow the EXPORT; a consumer that recomputes would report its own value
 // and hide a malformed 3.6 export.
 const data=fixture();
 const canonical=lossOf(E2),exported=canonical.usd!*1.5;
 (data.tables as Record<string,unknown>).structure_economics=(data.tables.structure_economics??[]).map(r=>
  r.candidate_id===E2.id?{...r,maximum_structural_loss_usd:exported,maximum_structural_loss_native:exported/IDX}:r);
 (data.tables as Record<string,unknown>).margin_scenarios=(data.tables.margin_scenarios??[]).map(r=>
  r.candidate_id===E2.id?{...r,maximum_structural_loss_usd:exported,maximum_structural_loss_native:exported/IDX}:r);

 const width=normalizeWidthStructures(data).find(s=>s.candidateId===E2.id&&s.executionScenario==="maker")!;
 assert.equal(width.payoff.maximumStructuralLossUsd.value,exported,"Spread Width follows the export");
 const position=buildEconomicReport(data,CONFIG).reference.positions.find(p=>p.candidateId===E2.id)!;
 assert.equal(position.maximumStructuralLossUsd.value,exported,"Economic Analysis follows the export too");
 assert.notEqual(position.maximumStructuralLossUsd.value,canonical.usd);
});

test("C: two disagreeing canonical tables stay an integrity failure, not a silent choice",()=>{
 const data=fixture();
 (data.tables as Record<string,unknown>).margin_scenarios=(data.tables.margin_scenarios??[]).map(r=>
  r.candidate_id===E2.id?{...r,maximum_structural_loss_usd:5_000_000}:r);
 const width=normalizeWidthStructures(data).find(s=>s.candidateId===E2.id&&s.executionScenario==="maker")!;
 assert.equal(width.payoff.maximumStructuralLossUsd.value,null);
 assert.match(width.payoff.maximumStructuralLossUsd.reason!,/disagree/i);
 const position=buildEconomicReport(data,CONFIG).reference.positions.find(p=>p.candidateId===E2.id)!;
 assert.equal(position.maximumStructuralLossUsd.value,null,"and the same failure reaches Economic Analysis");
});

test("C: the Duration structural-loss capital basis reads the canonical export, not margin alone",()=>{
 // Standard Margin reconstruction is unavailable for every structure, but the
 // canonical structural loss was still exported.
 const data=fixture({withoutMargin:true});
 const report=buildDurationDteReport(data,"maker",CONFIG);
 assert.equal(report.operationalHolding.capitalBasis,"maximum_economic_loss","the retained serialized token");
 assert.notEqual(report.operationalHolding.medianCapitalDayReturn,null,
  "the canonical structural loss exists, so a capital-day return exists");
 // The margin-based bases correctly remain account quantities and stay unavailable.
 const onMargin=buildDurationDteReport(data,"maker",{...CONFIG,capitalBasis:"peak_required_capital"});
 assert.equal(onMargin.operationalHolding.medianCapitalDayReturn,null,
  "peak required capital is an ACCOUNT quantity and is not substituted from structural loss");
});

/* ============ D / E: outcome fidelity end to end ============ */

test("D: an unreached invalidation is never priced anywhere downstream",()=>{
 const data=fixture();
 for(const track of ["reference","immediate_maker","delayed_maker"] as const){
  const rows=(datasetForAnalyticsTrack(data,track).tables.outcomes??[]).filter(o=>o.outcome_type==="invalidation");
  for(const row of rows){
   assert.equal(row.trigger_status,"not_reached",`${track} must not fabricate reached`);
   assert.notEqual(row.status,"priced",`${track} must not fabricate priced`);
   assert.equal(row.holding_hours,null);
   assert.equal(row.net_pnl_native,null);
  }
 }
 // And no rendered Exit Policy observation resolves onto it.
 const policies=normalizeExitPolicies(datasetForAnalyticsTrack(data,"reference"));
 assert.ok(policies.length>0);
 for(const p of policies)assert.notEqual(p.winningTrigger,"invalidation",
  "an exit that never triggered cannot win a policy");
});

test("E: every canonical fixed-time and capture outcome survives to the rendered Exit Policy report",()=>{
 const projected=datasetForAnalyticsTrack(fixture(),"reference");
 const rows=projected.tables.outcomes??[];
 const byType=(t:string)=>rows.find(r=>r.candidate_id===E1[0]!.id&&r.outcome_type===t);
 for(const type of ["vpoc","fixed_3d","fixed_5d","fixed_7d","credit_capture_50","credit_capture_70","settlement"]){
  const row=byType(type);
  assert.ok(row,`${type} survives canonical identity mapping`);
  assert.equal(row!.status,"priced",`${type} stays evaluated/priced`);
  assert.equal(row!.trigger_status,"reached");
  assert.equal(row!.source_status,"estimated");
  assert.ok(row!.decision_available_timestamp_utc,`${type} keeps its decision timestamp`);
  assert.ok(row!.valuation_timestamp_utc,`${type} keeps its valuation timestamp`);
  assert.notEqual(row!.net_pnl_native,null,`${type} keeps its BTC PnL`);
  assert.notEqual(row!.net_pnl_usd,null,`${type} keeps its USD PnL`);
 }
 // The engine label "3D" must not become an unmatched "3d".
 assert.equal(byType("3d"),undefined);
 // The persisted Reference counterfactual remains inspectable, but it is not
 // promoted into central Q50 economics when empirical execution is absent.
 const report=buildExitPolicyReport(fixture(),CONFIG);
 assert.ok(report.policies.every(p=>p.stats.pricedExits.n===0),"Reference does not substitute for Q50");
 assert.ok(report.observed.maker&&report.observed.taker,"observed robustness stays separate");
});

/* ============ F: holding time ============ */

test("F: a priced exit keeps a plausible causal holding time, and none is ever negative",()=>{
 const data=fixture();
 for(const track of ["reference","immediate_maker","delayed_maker"] as const){
  for(const p of normalizeExitPolicies(datasetForAnalyticsTrack(data,track))){
   if(p.holdingHours===null)continue;
   assert.ok(p.holdingHours>=0,`${track}/${p.policyId} produced a negative holding period`);
   if(p.status==="priced")assert.ok(p.holdingHours>0,`${track}/${p.policyId} priced with no elapsed time`);
  }
 }
 // The delayed track holds for LESS time than reference: it opened a day later.
 const referenceEntry=(datasetForAnalyticsTrack(data,"reference").tables.candidates??[])
  .find(c=>c.candidate_id===E2.id)!.structure_entry_timestamp_utc;
 const delayedEntry=(datasetForAnalyticsTrack(data,"delayed_maker").tables.candidates??[])
  .find(c=>c.candidate_id===E2.id)!.structure_entry_timestamp_utc;
 assert.equal(referenceEntry,D(1));
 assert.equal(delayedEntry,D(2),"delayed holding starts from the delayed opening, never the signal");
 // Nothing is backfilled from expiry for an unreached outcome.
 const invalidation=(datasetForAnalyticsTrack(data,"reference").tables.outcomes??[])
  .find(o=>o.outcome_type==="invalidation")!;
 assert.equal(invalidation.holding_hours,null);
});

test("F: an outcome valued before its own delayed opening is Unavailable, never negative",()=>{
 const data=fixture();
 // Backdate the delayed outcome to before the delayed entry.
 (data.tables as Record<string,unknown>).candidates=(data.tables.candidates??[]).map(c=>
  c.candidate_id===E2.id&&c.execution_scenario==="maker"
   ?{...c,delayed_execution:{maker:{...delayedComplete(E2),
      outcomeSnapshots:[{label:"settlement",status:"estimated",decisionTimestamp:T(1),
       valuationTimestamp:T(1),estimatedNetPnlBtc:.0035,estimatedNetPnlUsd:147}]}}}
   :c);
 const projected=datasetForAnalyticsTrack(data,"delayed_maker");
 const row=(projected.tables.outcomes??[]).find(o=>o.candidate_id===E2.id&&o.outcome_type==="settlement")!;
 assert.equal(row.holding_hours,null,"the canonical guard rejects a pre-entry close");
 for(const p of normalizeExitPolicies(projected))
  assert.ok(p.holdingHours===null||p.holdingHours>=0,"and no consumer re-derives a negative holding period");
});

/* ============ G: delayed availability ============ */

test("G: entry-only delayed evidence never becomes an economically available layer",()=>{
 const model=buildResearchAnalyticsModel(fixture());
 const observation=model.observations.find(o=>o.eventId==="e2")!;
 assert.equal(observation.tracks.delayed_maker!.status,"available","a causal post-entry path exists");
 assert.equal(observation.tracks.delayed_taker!.status,"unavailable","opening evidence alone is entry-only");
 assert.ok(observation.tracks.delayed_taker!.reason,"with an explicit reason");
 const layers=economicLayerSummaries(buildEconomicReport(fixture(),CONFIG));
 const entryOnly=layers.find(l=>l.track==="delayed_taker")!;
 assert.equal(entryOnly.status,"unavailable");
 assert.equal(entryOnly.pricedPositions,0);
 assert.equal(entryOnly.medianExitPnlBtc,null,"Unavailable, never zero");
 assert.equal(entryOnly.role,"diagnostic","and it remains a diagnostic, not central economics");
});

/* ============ H / I: futures denominator and equal risk ============ */

test("H: one futures baseline serves an event with four option structures",()=>{
 const report=buildFuturesComparisonReport(fixture());
 assert.equal(report.events.length,1);
 assert.equal(report.summary.eventsWithBaseline,1,"one perpetual observation per MR event");
 assert.equal(report.summary.optionConfigurations,4,"four option structures attach downstream");
 assert.equal(report.summary.medianFuturesNetPnlUsdPerUnit,1450,"not a four-times-repeated sample");
 // An unavailable endpoint does not remove the event.
 assert.equal(report.summary.eventsWithInvalidationEndpoint,0);
 assert.equal(report.summary.eventsWithVpocEndpoint,1);
 assert.equal(report.summary.eventsWithCompleteFunding,1);
 // Matched-pair N is a STRUCTURE-level count and is reported separately from the
 // event-level futures population. Removing structures must move the
 // structure-level numbers and leave every event-level number untouched.
 assert.ok(report.summary.pairedComparableN<=report.summary.optionConfigurations);
 const thin=buildFuturesComparisonReport(fixture({singleStructure:true}));
 assert.ok(thin.summary.optionConfigurations<report.summary.optionConfigurations,"structure-level N moved");
 assert.equal(thin.summary.eventsWithBaseline,report.summary.eventsWithBaseline,"event-level N did not");
 assert.equal(thin.summary.medianFuturesNetPnlUsdPerUnit,report.summary.medianFuturesNetPnlUsdPerUnit,
  "and the futures median is not reweighted by option selection density");
});

test("I: equal-risk sizing uses the canonical structural risk and the shared helper",()=>{
 const report=buildFuturesComparisonReport(fixture());
 for(const option of report.events[0]!.options){
  if(option.equalRisk.status!=="available")continue;
  const spec=E1.find(s=>s.id===option.candidateId)!;
  assert.equal(option.equalRisk.riskBudgetUsd,lossOf(spec).usd,"the canonical bounded structural loss");
  assert.equal(option.equalRisk.futuresQuantity,equalRiskFuturesQuantity(lossOf(spec).usd,RISK_PER_UNIT));
  assert.ok(option.equalRisk.futuresQuantity!<10,"an ordinary spread cannot size into a huge perpetual position");
 }
});

/* ============ J: modelled missingness ============ */

test("J: uncalibrated expected modelled execution is Unavailable, not zero and not Conservative",()=>{
 // Conservative is genuinely evaluated here while expected is not, so
 // substituting one for the other is detectable rather than a silent no-op.
 const layers=economicLayerSummaries(buildEconomicReport(fixture({calibratedConservative:true}),CONFIG));
 const expected=layers.find(l=>l.track==="modeled_expected")!,
  conservative=layers.find(l=>l.track==="modeled_conservative")!;
 assert.equal(conservative.status,"available","the control layer genuinely produced priced positions");
 assert.ok(conservative.pricedPositions>0);
 assert.notEqual(conservative.medianExitPnlBtc,null);
 // Expected must stay unavailable DESPITE conservative being available.
 assert.equal(expected.status,"unavailable");
 assert.equal(expected.pricedPositions,0);
 assert.equal(expected.medianExitPnlBtc,null,"Unavailable, never zero");
 assert.equal(expected.medianReturnOnStructuralLoss,null);
 assert.notEqual(expected.medianExitPnlBtc,conservative.medianExitPnlBtc,
  "conservative modelled execution is never substituted for expected");
 assert.notEqual(expected.pricedPositions,conservative.pricedPositions);
 assert.match(expected.reason!,/calibration/i);
 assert.equal(conservative.role,"conservative");
 assert.equal(layers.filter(l=>l.role==="central").length,1);
 assert.equal(layers.find(l=>l.role==="central")!.track,"modeled_expected");
});

/* ============ cross-cutting: routing, IV, provenance ============ */

test("ROUTING: structural reports use Reference while Economics uses Q50",()=>{
 const data=fixture();
 assert.equal(buildShortStrikeReport(data).scenario,"reference");
 assert.equal(buildSpreadWidthReport(data).scenario,"reference");
 const economics=buildEconomicReport(data,CONFIG);
 assert.equal(economics.positions,economics.central.positions);
 // Robustness layers exist beside the primary one and are never pooled into it.
 assert.equal(buildSpreadWidthReport(data).robustness!.taker.scenario,"taker");
 assert.equal(buildShortStrikeReport(data).robustness!.maker.scenario,"maker");
});

test("IV: normalized per-leg implied volatility survives the importer and the projection",()=>{
 const data=fixture();
 const source=(data.tables.valuations??[])[0]!;
 assert.equal((source.short_leg_volatility as Record<string,unknown>).iv_decimal,.62);
 const projected=(datasetForAnalyticsTrack(data,"immediate_maker").tables.valuations??[])
  .find(v=>v.candidate_id===E1[0]!.id);
 assert.ok(projected,"the valuation row survives projection");
 const shortIv=projected!.short_leg_volatility as Record<string,unknown>|undefined;
 assert.ok(shortIv,"per-leg IV is not stripped by the analytics projection");
 assert.equal(shortIv!.iv_decimal,.62);
 assert.equal(shortIv!.iv_units,"decimal");
 assert.equal((projected!.long_leg_volatility as Record<string,unknown>).iv_decimal,.71);
});

test("PROVENANCE: the futures report layer stays a consumer and states its assumptions",()=>{
 const source=readFileSync(new URL("../app/lib/futures-comparison/report.ts",import.meta.url),"utf8");
 assert.doesNotMatch(source,/fetch\(|buildEventFuturesBaseline|https?:\/\//,"no engine rerun and no retrieval");
 const view=readFileSync(new URL("../app/components/futures-comparison-report.tsx",import.meta.url),"utf8");
 assert.match(view,/ANALYTICAL sizing figure/,"the equal-risk quantity is not portrayed as executable size");
 assert.match(view,/never a guaranteed executable size/);
 assert.match(view,/zero-slippage reference assumption/,"the slippage assumption is disclosed, not concealed");
 assert.match(view,/not observed executable economics/);
});
