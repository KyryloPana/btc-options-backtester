import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildEconomicReport,economicLayerSummaries} from "../app/lib/economics/report.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/analysis-configuration.ts";
import {buildFuturesComparisonReport} from "../app/lib/futures-comparison/report.ts";
import {EQUAL_RISK_SIZING_METHOD,equalRiskFuturesQuantity} from "../app/lib/futures-baseline.ts";
import {canonicalStructuralLoss} from "../app/lib/maximum-economic-loss.ts";

/**
 * Two capabilities the bundle already exported but the workspace did not show:
 * the economics sensitivity layers beside the Reference baseline, and an
 * Options-vs-BTC-Perpetual comparison built from the canonical futures tables.
 */

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);
const ENTRY_INDEX=42000,QTY=1,SHORT_PREMIUM=.0075,LONG_PREMIUM=.0030;

const PAYOFF_INPUT={optionType:"P" as const,shortStrike:40000,longStrike:38000,
 shortEntryPremiumBtc:SHORT_PREMIUM,longEntryPremiumBtc:LONG_PREMIUM,
 entryIndex:ENTRY_INDEX,amount:QTY,openingFeesBtc:.0004,expiryTimestamp:T(9)};
const LOSS=canonicalStructuralLoss(PAYOFF_INPUT);

/** A canonical reference snapshot, so the Reference track genuinely exists. */
const referenceValuation=(endpoint:string,priced=true)=>({
 status:"valued",source:"local_iv_interpolation",
 entrySnapshot:{status:"priced",targetTimestamp:T(1),valuationTimestamp:T(1),
  grossSpreadBtc:SHORT_PREMIUM-LONG_PREMIUM,openingFeesBtc:.0004,
  netOpeningCashFlowBtc:SHORT_PREMIUM-LONG_PREMIUM-.0004,
  entryTargetIndex:ENTRY_INDEX,estimateQuality:"green"},
 valuationPathSnapshot:[{timestamp:T(2),estimatedNetPnlBtc:.002}],
 outcomeSnapshots:[priced
  ?{label:endpoint,status:"estimated",decisionTimestamp:T(4),valuationTimestamp:T(4),
    estimatedNetPnlBtc:.005,estimatedNetPnlUsd:210}
  :{label:endpoint,status:"unavailable",decisionTimestamp:T(4),
    evidenceReason:"no causal mark at the decision time"}],
 provenance:{executionIndependent:true,quality:"green"},
});

function candidate(candidateId:string,eventId:string,over:Record<string,unknown>={}){
 return {
  event_id:eventId,candidate_id:candidateId,strategy_variant_id:candidateId,
  structure_execution_id:`${candidateId}~maker`,direction:"long",option_type:"P",
  structure_type:"bull_put_credit",strike_method:"anchor",
  actual_strikes:{short:40000,long:38000,width:2000},requested_strikes:{short:40000,long:38000,width:2000},
  expiry_timestamp_utc:D(9),actual_dte:8,actual_dte_days:8,exit_policy:"settlement",
  structure_entry_timestamp_utc:D(1),execution_scenario:"maker",execution_scenario_status:"evaluated",
  entry_index_price:ENTRY_INDEX,quantity:QTY,
  entry_legs:{short:{price_native:SHORT_PREMIUM},long:{price_native:LONG_PREMIUM}},
  gross_credit_debit_native:SHORT_PREMIUM-LONG_PREMIUM,opening_fees_native:.0004,
  net_opening_cash_flow_native:SHORT_PREMIUM-LONG_PREMIUM-.0004,
  ...over,
 };
}

const economicsRow=(candidateId:string,eventId:string)=>({
 candidate_id:candidateId,event_id:eventId,
 maximum_structural_loss_status:LOSS.status,
 maximum_structural_loss_usd:LOSS.usd,
 maximum_structural_loss_native:LOSS.btcAtReferenceIndex,
 maximum_structural_loss_reference_index:LOSS.referenceIndex,
 maximum_structural_loss_settlement_index:LOSS.worstStructuralIndex,
 maximum_structural_loss_method:LOSS.method,
 maximum_structural_loss_method_version:LOSS.methodVersion,
 maximum_structural_loss_unavailable_reason:LOSS.reason,
 breakeven_index:LOSS.breakevenIndex,
});

const RISK_PER_UNIT=2200;

function futuresRow(eventId:string,over:Record<string,unknown>={}){
 return {
  event_id:eventId,comparison_id:`${eventId}~futures`,instrument:"BTC-PERPETUAL",venue:"deribit",
  availability:"available",direction:"long",
  reference_entry_timestamp_utc:D(1),reference_entry_price:ENTRY_INDEX,reference_entry_basis:"bar_close",
  exit_policy:"vpoc",exit_timestamp_utc:D(4),exit_price:43500,exit_status:"available",
  holding_hours:72,
  gross_pnl_usd_per_unit:1500,fees_usd_per_unit:42.75,slippage_usd_per_unit:0,
  net_pnl_usd_per_unit_before_funding:1457.25,
  funding_usd_per_unit:-7.25,funding_status:"available",funding_source:"deribit",
  funding_intervals_expected:72,funding_intervals_observed:72,
  net_pnl_usd_per_unit_after_funding:1450,
  risk_to_invalidation_usd_per_unit:RISK_PER_UNIT,
  unit_convention:"per 1 BTC-equivalent of perpetual notional, quoted in USD",
  equal_risk_sizing_method:EQUAL_RISK_SIZING_METHOD,
  endpoints:[
   {policy:"vpoc",trigger_timestamp_utc:D(3),decision_timestamp_utc:D(3),
    observation_timestamp_utc:D(4),observation_price:43500,outcome:"reached",status:"available",reason_code:null},
   {policy:"invalidation",trigger_timestamp_utc:null,decision_timestamp_utc:null,
    observation_timestamp_utc:null,observation_price:null,outcome:"not_reached",status:"not_reached",
    reason_code:"futures_invalidation_not_reached"},
   {policy:"fixed_3d",trigger_timestamp_utc:D(4),decision_timestamp_utc:D(4),
    observation_timestamp_utc:D(4),observation_price:43000,outcome:"reached",status:"available",reason_code:null},
  ],
  reason_codes:[],
  ...over,
 };
}

/**
 * ONE MR event with THREE selected option structures and exactly one futures
 * baseline, which is the shape that makes an event-level denominator defect
 * visible.
 */
function fixture(over:{futures?:Record<string,unknown>[];optionOutcome?:string;futuresPathRows?:number;unpriced?:string}={}):AnalysisDataset{
 const ids=["c1","c2","c3"];
 const endpointLabel=over.optionOutcome??"vpoc";
 const candidates=ids.map(id=>candidate(id,"e1",{
  reference_valuation:referenceValuation(endpointLabel,over.unpriced!==id),
 }));
 const availability=ids.map((id,i)=>({availability_id:`a${i}`,event_id:"e1",candidate_id:id,
  strategy_variant_id:id,contract_status:"resolved"}));
 const endpoint=over.optionOutcome??"vpoc";
 const outcomes=ids.map(id=>({candidate_id:id,event_id:"e1",execution_scenario:"maker",
  outcome_type:endpoint,status:"evaluated",trigger_status:"reached",source_status:"estimated",
  holding_hours:72,decision_available_timestamp_utc:D(4),valuation_timestamp_utc:D(4),
  net_pnl_native:.005,net_pnl_usd:210}));
 const structure_economics=ids.map(id=>economicsRow(id,"e1"));
 const margin_scenarios=ids.map(id=>({candidate_id:id,event_id:"e1",margin_status:"available",
  margin_model:"standard",reference_index:ENTRY_INDEX,
  incremental_initial_margin:.02,peak_initial_margin:.03,
  maximum_structural_loss_usd:LOSS.usd,maximum_structural_loss_native:LOSS.btcAtReferenceIndex}));
 const futures_path=Array.from({length:over.futuresPathRows??3},(_,i)=>({event_id:"e1",
  timestamp_utc:new Date(T(1)+i*36e5).toISOString(),futures_price:ENTRY_INDEX,venue:"deribit"}));
 const events=[{event_id:"e1",direction:"long",entry_price:ENTRY_INDEX,entry_timestamp_utc:D(1),
  signal_timestamp_utc:D(1),sequence_status:"vpoc_first"}];
 return {filename:"fixture.zip",schemaVersion:"3.6.0",migratedFrom:null,run:{},
  tables:{events,candidates,availability,outcomes,valuations:[],structure_economics,margin_scenarios,
   futures_comparisons:over.futures??[futuresRow("e1")],futures_path,underlying_path:[]},
  counts:{},venues:["deribit"],sourceRuns:[],eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;
}

/* ================= economics layers ================= */

const economics=()=>buildEconomicReport(fixture(),DEFAULT_ANALYSIS_CONFIGURATION);

test("ECONOMICS: Q50 is central and Reference is counterfactual",()=>{
 const report=economics(),layers=economicLayerSummaries(report);
 const reference=layers.find(l=>l.track==="reference")!;
 assert.equal(reference.role,"counterfactual");
 assert.equal(layers.filter(l=>l.role==="central").length,1,"exactly one central layer");
 assert.equal(report.positions,report.central.positions);
 // Maker and taker appear as their own rows rather than replacing reference.
 assert.ok(layers.some(l=>l.track==="immediate_maker"&&l.role==="diagnostic"));
 assert.ok(layers.some(l=>l.track==="immediate_taker"&&l.role==="diagnostic"));
});

test("ECONOMICS: conservative modelled execution is labelled modelled, never observed",()=>{
 const layers=economicLayerSummaries(economics());
 const conservative=layers.find(l=>l.track==="modeled_conservative")!;
 assert.equal(conservative.role,"conservative");
 assert.equal(layers.find(l=>l.track==="penalty_sensitivity")!.role,"sensitivity");
 for(const track of ["delayed_maker","delayed_taker"] as const)
  assert.equal(layers.find(l=>l.track===track)!.role,"diagnostic","a delayed opening is its own question, not central economics");
});

test("ECONOMICS: expected modelled execution stays unavailable when uncalibrated, never zero",()=>{
 const layers=economicLayerSummaries(economics());
 const expected=layers.find(l=>l.track==="modeled_expected")!;
 assert.equal(expected.status,"unavailable");
 assert.equal(expected.pricedPositions,0);
 assert.equal(expected.medianExitPnlBtc,null,"Unavailable, not 0");
 assert.equal(expected.medianReturnOnStructuralLoss,null);
 assert.match(expected.reason!,/unavailable|calibration/i);
 // Conservative is a distinct row and is never used in place of expected.
 assert.notEqual(expected.reason,layers.find(l=>l.track==="modeled_conservative")!.reason);
});

test("ECONOMICS: missing margin stays unavailable rather than becoming a return of zero",()=>{
 const data=fixture();
 (data.tables as Record<string,unknown>).margin_scenarios=[];
 const report=buildEconomicReport(data,DEFAULT_ANALYSIS_CONFIGURATION);
 for(const position of report.positions){
  assert.equal(position.incrementalInitialMarginBtc.value,null);
  assert.equal(position.returnOnOpeningMargin.value,null);
  assert.ok(position.returnOnOpeningMargin.reason,"with a reason");
 }
 assert.equal(report.capabilities.openingMargin,false);
 assert.equal(economicLayerSummaries(report).find(l=>l.track==="modeled_expected")!.medianReturnOnStructuralLoss,null);
});

test("ECONOMICS: the visible wording is structural loss, and margin is not renamed",()=>{
 const view=readFileSync(new URL("../app/components/economic-analysis-report.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(view,/Max loss|Aggregate max loss|Maximum economic loss/i);
 assert.match(view,/<th>Structural loss<\/th>/);
 assert.match(view,/Return \/ structural loss/);
 assert.match(view,/Capital &amp; margin diagnostics/);
});

/* ================= futures comparison ================= */

const futures=()=>buildFuturesComparisonReport(fixture());

test("FUTURES: one event-level baseline is not multiplied by the option structures",()=>{
 const report=futures();
 assert.equal(report.events.length,1,"one futures observation per MR event");
 assert.equal(report.summary.eventsWithBaseline,1);
 assert.equal(report.summary.optionConfigurations,3,"three option configurations on that one event");
 // The event-level median is the single per-unit value, NOT a three-times-
 // repeated value dressed up as a larger sample.
 assert.equal(report.summary.medianFuturesNetPnlUsdPerUnit,1450);
 assert.equal(report.summary.medianRiskToInvalidationUsdPerUnit,RISK_PER_UNIT);
 assert.notEqual(report.summary.eventsWithBaseline,report.summary.optionConfigurations);
});

test("FUTURES: equal-risk sizing uses the canonical structural loss and the shared helper",()=>{
 const option=futures().events[0]!.options[0]!;
 assert.equal(option.equalRisk.riskBudgetUsd,LOSS.usd);
 assert.equal(option.equalRisk.futuresQuantity,equalRiskFuturesQuantity(LOSS.usd,RISK_PER_UNIT));
 assert.equal(option.equalRisk.futuresPnlUsd,1450*option.equalRisk.futuresQuantity!);
 assert.equal(option.equalRisk.differenceUsd,210-option.equalRisk.futuresPnlUsd!);
 assert.equal(futures().equalRiskSizingMethod,EQUAL_RISK_SIZING_METHOD);
});

test("FUTURES: an ordinary spread does not produce an absurd equal-risk quantity",()=>{
 const option=futures().events[0]!.options[0]!;
 const quantity=option.equalRisk.futuresQuantity!;
 assert.ok(Number.isFinite(quantity)&&quantity>0);
 // The old fee-inclusive risk budget produced hundreds of millions of BTC of
 // notional on a spread exactly like this one.
 assert.ok(quantity<10,`a $2,000-wide spread cannot size into ${quantity} BTC of perpetual`);
 assert.ok(Math.abs(option.equalRisk.futuresPnlUsd!)<1e5,"and the paired PnL stays plausible");
});

test("FUTURES: missing funding stays explicit and is never treated as zero",()=>{
 const partial=futuresRow("e1",{funding_status:"partial",funding_usd_per_unit:null,
  funding_intervals_observed:40,net_pnl_usd_per_unit_after_funding:null});
 const report=buildFuturesComparisonReport(fixture({futures:[partial]}));
 const baseline=report.events[0]!.baseline;
 assert.equal(baseline.fundingStatus,"partial");
 assert.equal(baseline.fundingUsdPerUnit,null,"Unavailable, not 0");
 assert.equal(baseline.netPnlUsdPerUnitAfterFunding,null);
 assert.equal(report.summary.eventsWithPartialOrMissingFunding,1);
 assert.equal(report.summary.eventsWithCompleteFunding,0);
 // The event is still shown, and the equal-risk row explains itself.
 const option=report.events[0]!.options[0]!;
 assert.equal(option.equalRisk.status,"unavailable");
 assert.equal(option.equalRisk.differenceUsd,null);
 assert.match(option.equalRisk.reason!,/funding partial/i);
 // The endpoint itself was still available, so the row is not hidden.
 assert.equal(option.comparability,"paired");
 assert.equal(baseline.endpoints.find(e=>e.policy==="vpoc")!.status,"available");
});

test("FUTURES: an endpoint mismatch is never treated as a matched pair",()=>{
 // A 50% credit-capture exit has no perpetual analogue.
 const report=buildFuturesComparisonReport(fixture({
  optionOutcome:"credit_capture_50",
  futures:[futuresRow("e1",{exit_policy:"credit_capture_50"})],
 }));
 const option=report.events[0]!.options[0]!;
 assert.equal(option.comparability,"benchmark_only");
 assert.match(option.comparabilityReason!,/no perpetual analogue/i);
 assert.equal(option.equalRisk.status,"unavailable");
 assert.equal(option.equalRisk.differenceUsd,null);
 assert.equal(report.summary.pairedComparableN,0);
 assert.equal(report.summary.equalRiskComparableN,0);
 assert.equal(report.summary.medianPairedDifferenceUsd,null,"no synthetic futures credit-capture exit is invented");
 assert.equal(report.summary.benchmarkOnlyN,3);
});

test("FUTURES: an unreached futures endpoint is unavailable, not a paired zero",()=>{
 const report=buildFuturesComparisonReport(fixture({
  optionOutcome:"invalidation",
  futures:[futuresRow("e1",{exit_policy:"invalidation",exit_status:"not_reached",
   exit_price:null,exit_timestamp_utc:null,net_pnl_usd_per_unit_after_funding:null})],
 }));
 const option=report.events[0]!.options[0]!;
 assert.equal(option.comparability,"unavailable");
 assert.match(option.comparabilityReason!,/not_reached|futures_invalidation_not_reached/);
 assert.equal(option.equalRisk.differenceUsd,null);
 assert.equal(report.summary.medianPairedDifferenceUsd,null);
 // The other canonical endpoints survive: the event is not hidden.
 const baseline=report.events[0]!.baseline;
 assert.equal(baseline.endpoints.find(e=>e.policy==="vpoc")!.status,"available");
 assert.equal(report.summary.eventsWithVpocEndpoint,1);
 assert.equal(report.summary.eventsWithInvalidationEndpoint,0);
});

test("FUTURES: matched pair differences use only genuinely comparable observations",()=>{
 const report=futures();
 assert.equal(report.summary.pairedComparableN,3);
 assert.equal(report.summary.equalRiskComparableN,3);
 const differences=report.events[0]!.options.map(o=>o.equalRisk.differenceUsd);
 assert.ok(differences.every(x=>x!==null));
 assert.equal(report.summary.medianPairedDifferenceUsd,differences[0]);
 // One structure whose option side is unpriced drops out of the difference and
 // is not replaced by zero.
 const thinned=buildFuturesComparisonReport(fixture({unpriced:"c3"}));
 assert.equal(thinned.summary.equalRiskComparableN,2);
 const dropped=thinned.events[0]!.options.find(o=>o.candidateId==="c3")!;
 assert.equal(dropped.equalRisk.differenceUsd,null);
 assert.match(dropped.equalRisk.reason!,/no priced result/i);
});

test("FUTURES: the report layer performs no spot or index substitution",()=>{
 const source=readFileSync(new URL("../app/lib/futures-comparison/report.ts",import.meta.url),"utf8");
 // A futures price is never taken from an index or spot series. The only index
 // this layer reads is the OPTION entry index, and only to express margin in USD.
 assert.doesNotMatch(source,/(?<!entry_)index_price/,"no index series is read as a futures price");
 assert.doesNotMatch(source,/spot/i);
 assert.match(source,/num\(candidate\.entry_index_price\)/,"the option entry index is used for margin conversion only");
 // And no retrieval or engine call happens here.
 assert.doesNotMatch(source,/fetch\(|buildEventFuturesBaseline|deribit-history|https?:\/\//);
 assert.match(source,/futures_comparisons/);
 assert.match(source,/futures_path/);
});

test("FUTURES: no exported futures table leaves the report explicitly unavailable",()=>{
 const data=fixture();
 (data.tables as Record<string,unknown>).futures_comparisons=[];
 const report=buildFuturesComparisonReport(data);
 assert.equal(report.availability,"unavailable");
 assert.match(report.unavailableReason!,/no futures_comparisons rows/i);
 assert.equal(report.events.length,0);
 assert.equal(report.summary.medianPairedDifferenceUsd,null);
 assert.equal(report.summary.eventsWithBaseline,0);
});

test("FUTURES: the workspace renders the report after Economics",()=>{
 const shell=readFileSync(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");
 const economicsAt=shell.indexOf("EconomicAnalysisReportView report=");
 const futuresAt=shell.indexOf("FuturesComparisonReportView report=");
 const workbenchAt=shell.indexOf("<ResearchAnalyticsWorkbench");
 assert.ok(economicsAt>0&&futuresAt>economicsAt,"Options vs BTC Perpetual sits after Economics");
 assert.ok(workbenchAt>futuresAt,"and before Diagnostics & Audit");
});
