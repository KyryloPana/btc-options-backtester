import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {datasetForAnalyticsTrack} from "../app/lib/research-analytics-model.ts";
import {normalizeWidthStructures} from "../app/lib/spread-width/normalize.ts";
import {canonicalStructuralLoss,STRUCTURAL_LOSS_METHOD_VERSION} from "../app/lib/maximum-economic-loss.ts";
import {readCanonicalStructuralLoss} from "../app/lib/canonical-structural-loss.ts";

/**
 * Two Research Analytics consumers that had drifted away from the canonical
 * architecture:
 *
 *  1. Spread Width recreated its own fee-inclusive "maximum economic loss" from
 *     payoffExtrema with a Number.MAX_SAFE_INTEGER tail sample, which for a bear
 *     call turns a fixed BTC delivery fee into an unbounded USD figure.
 *  2. The analytics compatibility projection decided each exit outcome's state
 *     from the TRACK's availability, so an available Reference track reported
 *     every policy -- including an invalidation that never happened -- as
 *     reached and priced.
 */

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);
const ENTRY_INDEX=42000,QTY=1;

/* ================= outcome fidelity ================= */

const ENTRY_SNAPSHOT={
 status:"priced",targetTimestamp:T(1),valuationTimestamp:T(1),
 grossSpreadBtc:.0045,openingFeesBtc:.0004,netOpeningCashFlowBtc:.0041,
 entryTargetIndex:ENTRY_INDEX,estimateQuality:"green",
};

/**
 * One reference track with a deliberately MIXED outcome set: two genuinely
 * evaluated fixed-time exits, one policy that never triggered, and one that
 * triggered but whose source valuation is unavailable.
 */
const REFERENCE_SNAPSHOT={
 status:"valued",source:"local_iv_interpolation",entrySnapshot:ENTRY_SNAPSHOT,
 valuationPathSnapshot:[{timestamp:T(3),estimatedNetPnlBtc:.002}],
 outcomeSnapshots:[
  // Reached and valued. The label is the engine's, not the canonical id.
  {label:"3D",status:"estimated",decisionTimestamp:T(4),valuationTimestamp:T(4),estimatedNetPnlBtc:.0021,estimatedNetPnlUsd:88.2},
  {label:"7D",status:"estimated",decisionTimestamp:T(8),valuationTimestamp:T(8),estimatedNetPnlBtc:.0035,estimatedNetPnlUsd:147},
  // Never triggered. The event simply did not invalidate.
  {label:"invalidation",status:"not-hit"},
  // Triggered, but the source could not value it.
  {label:"5D",status:"unavailable",decisionTimestamp:T(6),evidenceReason:"no causal mark at the decision time"},
 ],
 provenance:{executionIndependent:true,quality:"green"},
};

const DELAYED_SNAPSHOT={
 status:"evaluated",source:"delayed-engine",
 entrySnapshot:{...ENTRY_SNAPSHOT,targetTimestamp:T(2),valuationTimestamp:T(2)},
 valuationPathSnapshot:[{timestamp:T(3),estimatedNetPnlBtc:.001}],
 outcomeSnapshots:[
  {label:"3D",status:"estimated",decisionTimestamp:T(4),valuationTimestamp:T(4),estimatedNetPnlBtc:.0011},
  {label:"invalidation",status:"not-hit"},
 ],
};

function outcomeFixture():AnalysisDataset{
 const common={
  event_id:"e1",candidate_id:"c1",strategy_variant_id:"v1",direction:"long",
  option_type:"P",structure_type:"bull_put_credit",strike_method:"anchor",
  actual_strikes:{short:40000,long:38000,width:2000},
  requested_strikes:{short:40000,long:38000,width:2000},
  expiry_timestamp_utc:D(9),actual_dte:8,quantity:QTY,entry_index_price:ENTRY_INDEX,
  exit_policy:"settlement",
  reference_valuation:REFERENCE_SNAPSHOT,
  delayed_execution:{maker:DELAYED_SNAPSHOT},
 };
 const candidates=[{
  ...common,execution_scenario:"maker",execution_scenario_status:"evaluated",
  structure_entry_timestamp_utc:D(1),entry_quality:"green",
  entry_legs:{short:{price_native:.0075},long:{price_native:.0030}},
  gross_credit_debit_native:.0045,opening_fees_native:.0004,net_opening_cash_flow_native:.0041,
 }];
 // Exported outcome rows, in the canonical tabular vocabulary, for the
 // execution-scenario track. Each states its OWN status.
 const outcomes=[
  {candidate_id:"c1",execution_scenario:"maker",outcome_type:"fixed_3d",status:"evaluated",
   trigger_status:"reached",source_status:"estimated",holding_hours:72,
   decision_available_timestamp_utc:D(4),valuation_timestamp_utc:D(4),
   raw_net_pnl_native:.0021,raw_net_pnl_usd:88.2,net_pnl_native:null,net_pnl_usd:null},
  {candidate_id:"c1",execution_scenario:"maker",outcome_type:"invalidation",status:"unavailable",
   trigger_status:"not_reached",source_status:"not-hit",holding_hours:null,
   decision_available_timestamp_utc:null,valuation_timestamp_utc:null,
   raw_net_pnl_native:null,raw_net_pnl_usd:null,net_pnl_native:null,net_pnl_usd:null},
  {candidate_id:"c1",execution_scenario:"maker",outcome_type:"fixed_5d",status:"unavailable",
   trigger_status:"reached",source_status:"unavailable",holding_hours:null,
   decision_available_timestamp_utc:D(6),valuation_timestamp_utc:null,
   raw_net_pnl_native:null,raw_net_pnl_usd:null,net_pnl_native:null,net_pnl_usd:null},
 ];
 const availability=[{availability_id:"a1",event_id:"e1",strategy_variant_id:"v1",candidate_id:"c1",contract_status:"resolved"}];
 const events=[{event_id:"e1",direction:"long",entry_price:ENTRY_INDEX,signal_timestamp_utc:D(1),
  entry_timestamp_utc:D(1),sequence_status:"vpoc_first"}];
 return {filename:"fixture.zip",schemaVersion:"3.6.0",migratedFrom:null,run:{},
  tables:{availability,candidates,outcomes,events,valuations:[],margin_scenarios:[],structure_economics:[]},
  counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;
}

const projected=(track:Parameters<typeof datasetForAnalyticsTrack>[1])=>
 (datasetForAnalyticsTrack(outcomeFixture(),track).tables.outcomes??[]) as Readonly<Record<string,unknown>>[];
const byType=(rows:readonly Readonly<Record<string,unknown>>[],type:string)=>rows.find(r=>r.outcome_type===type)!;

test("OUTCOMES: an available Reference track does not promote an invalidation that never triggered",()=>{
 const rows=projected("reference");
 const invalidation=byType(rows,"invalidation");
 assert.ok(invalidation,"the unreached policy is still exported, not dropped");
 assert.equal(invalidation.trigger_status,"not_reached","track availability must not fabricate `reached`");
 assert.notEqual(invalidation.status,"priced","track availability must not fabricate `priced`");
 assert.equal(invalidation.status,"unavailable");
 assert.equal(invalidation.holding_hours,null,"an unreached outcome has no holding time");
 assert.equal(invalidation.net_pnl_native,null,"no PnL is invented for an outcome that never happened");
});

test("OUTCOMES: an evaluated fixed_3d keeps its canonical identity and stays priced",()=>{
 const row=byType(projected("reference"),"fixed_3d");
 // The engine persisted "3D"; the canonical identity table maps it, and the
 // projection does not lowercase it into an unmatched "3d".
 assert.equal(row.outcome_type,"fixed_3d");
 assert.equal(row.trigger_status,"reached");
 assert.equal(row.source_status,"estimated");
 assert.equal(row.status,"priced");
 assert.equal(row.net_pnl_native,.0021);
});

test("OUTCOMES: fixed_5d and fixed_7d each preserve their own source state",()=>{
 const rows=projected("reference");
 const five=byType(rows,"fixed_5d"),seven=byType(rows,"fixed_7d");
 // 5D triggered but could not be valued: reached, yet not priced.
 assert.equal(five.trigger_status,"reached");
 assert.equal(five.source_status,"unavailable");
 assert.equal(five.status,"unavailable","a triggered-but-unvalued outcome is not priced");
 assert.equal(five.holding_hours,null);
 // 7D was genuinely evaluated on the same track.
 assert.equal(seven.trigger_status,"reached");
 assert.equal(seven.status,"priced");
 assert.equal(seven.net_pnl_native,.0035);
 assert.notEqual(five.status,seven.status,"two policies on one track can hold different states");
});

test("OUTCOMES: an exported holding_hours survives the projection unchanged",()=>{
 const rows=projected("immediate_maker");
 assert.equal(byType(rows,"fixed_3d").holding_hours,72,"an exported holding time is passed through, not recomputed");
 assert.equal(byType(rows,"invalidation").holding_hours,null);
 assert.equal(byType(rows,"fixed_5d").holding_hours,null);
});

test("OUTCOMES: an unavailable source outcome is not promoted by its parent track",()=>{
 const rows=projected("immediate_maker");
 const five=byType(rows,"fixed_5d");
 assert.equal(five.status,"unavailable");
 assert.equal(five.raw_status,"unavailable","the per-pricing-track status follows the outcome, not the track");
 assert.equal(byType(rows,"fixed_3d").status,"priced","and a genuinely evaluated outcome is not demoted either");
});

test("OUTCOMES: a delayed track preserves outcome states by the same rule",()=>{
 const rows=projected("delayed_maker");
 assert.equal(byType(rows,"fixed_3d").status,"priced");
 assert.equal(byType(rows,"fixed_3d").trigger_status,"reached");
 const invalidation=byType(rows,"invalidation");
 assert.equal(invalidation.trigger_status,"not_reached");
 assert.equal(invalidation.status,"unavailable");
 // Holding time is measured from the DELAYED entry, never from the signal.
 assert.equal(byType(rows,"fixed_3d").holding_hours,48);
});

/* ================= structural-loss regression ================= */

interface Leg {optionType:"C"|"P";shortStrike:number;longStrike:number;shortPremium:number;longPremium:number}
const width=(leg:Leg)=>Math.abs(leg.shortStrike-leg.longStrike);
const BEAR_CALL:Leg={optionType:"C",shortStrike:44000,longStrike:45000,shortPremium:.0075,longPremium:.0030};
const BULL_PUT:Leg={optionType:"P",shortStrike:40000,longStrike:38000,shortPremium:.0075,longPremium:.0030};

const payoffInput=(leg:Leg)=>({optionType:leg.optionType,shortStrike:leg.shortStrike,longStrike:leg.longStrike,
 shortEntryPremiumBtc:leg.shortPremium,longEntryPremiumBtc:leg.longPremium,
 entryIndex:ENTRY_INDEX,amount:QTY,openingFeesBtc:.0004,expiryTimestamp:T(9)});

function widthFixture(leg:Leg,over:{economics?:Record<string,unknown>|null;margin?:Record<string,unknown>|null}={}):AnalysisDataset{
 const width=Math.abs(leg.shortStrike-leg.longStrike);
 const candidate={
  event_id:"e1",candidate_id:"c1",structure_execution_id:"c1~maker",direction:leg.optionType==="C"?"short":"long",
  option_type:leg.optionType,structure_type:leg.optionType==="C"?"bear_call_credit":"bull_put_credit",
  strike_method:"anchor",
  actual_strikes:{short:leg.shortStrike,long:leg.longStrike,width},
  requested_strikes:{short:leg.shortStrike,long:leg.longStrike,width},
  expiry_timestamp_utc:D(9),actual_dte:8,structure_entry_timestamp_utc:D(1),
  execution_scenario:"maker",execution_scenario_status:"evaluated",
  entry_index_price:ENTRY_INDEX,quantity:QTY,
  entry_legs:{short:{price_native:leg.shortPremium},long:{price_native:leg.longPremium}},
  gross_credit_debit_native:leg.shortPremium-leg.longPremium,opening_fees_native:.0004,
  net_opening_cash_flow_native:leg.shortPremium-leg.longPremium-.0004,
 };
 const events=[{event_id:"e1",direction:leg.optionType==="C"?"short":"long",entry_price:ENTRY_INDEX,entry_timestamp_utc:D(1)}];
 return {filename:"fixture.zip",schemaVersion:"3.6.0",migratedFrom:null,run:{},
  tables:{candidates:[candidate],outcomes:[],valuations:[],events,underlying_path:[],
   margin_scenarios:over.margin===undefined?[]:over.margin===null?[]:[over.margin],
   structure_economics:over.economics===undefined?[]:over.economics===null?[]:[over.economics]},
  counts:{},venues:[],sourceRuns:[],eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;
}

const only=(dataset:AnalysisDataset)=>normalizeWidthStructures(dataset)[0]!;

/** A canonical structure_economics row, built from the canonical helper. */
function economicsRow(leg:Leg,over:Record<string,unknown>={}):Record<string,unknown>{
 const loss=canonicalStructuralLoss(payoffInput(leg));
 return {
  candidate_id:"c1",event_id:"e1",
  maximum_structural_loss_status:loss.status,
  maximum_structural_loss_usd:loss.usd,
  maximum_structural_loss_native:loss.btcAtReferenceIndex,
  maximum_structural_loss_reference_index:loss.referenceIndex,
  maximum_structural_loss_settlement_index:loss.worstStructuralIndex,
  maximum_structural_loss_method:loss.method,
  maximum_structural_loss_method_version:loss.methodVersion,
  maximum_structural_loss_unavailable_reason:loss.reason,
  breakeven_index:loss.breakevenIndex,
  settlement_fee_treatment:{
   included_in_structural_loss:false,
   global_fee_inclusive_maximum:loss.settlementFees.globalFeeInclusiveMaximum,
   global_fee_inclusive_maximum_reason:loss.settlementFees.globalFeeInclusiveMaximumReason,
   scenario_index:loss.settlementFees.scenarioIndex,
   scenario_label:loss.settlementFees.scenarioLabel,
   scenario_delivery_fees_btc:loss.settlementFees.scenarioDeliveryFeesBtc,
   scenario_delivery_fees_usd:loss.settlementFees.scenarioDeliveryFeesUsd,
  },
  ...over,
 };
}

test("STRUCTURAL: a narrow bear call cannot produce a trillion-dollar structural risk",()=>{
 const s=only(widthFixture(BEAR_CALL,{economics:economicsRow(BEAR_CALL)}));
 const value=s.payoff.maximumStructuralLossUsd.value!;
 assert.notEqual(value,null);
 assert.ok(Number.isFinite(value));
 assert.ok(value>0,"a $1,000-wide credit spread genuinely risks something");
 // The old defect reported 0.0003 BTC x 9.007e15 = $2.702 trillion here.
 assert.ok(value<1e4,`a $1,000-wide bear call must risk well under $10,000, got ${value}`);
 assert.ok(value<width(BEAR_CALL)*QTY*1.01,"and it cannot exceed the strike width it is bounded by");
 // Whether a GLOBAL fee-inclusive maximum exists at all is stated, not assumed.
 assert.equal(s.payoff.settlementFees!.globalFeeInclusiveMaximum,"unbounded");
 assert.equal(s.payoff.settlementFees!.includedInStructuralLoss,false);
});

test("STRUCTURAL: a bull put carries a finite, plausible structural risk",()=>{
 const s=only(widthFixture(BULL_PUT,{economics:economicsRow(BULL_PUT)}));
 const value=s.payoff.maximumStructuralLossUsd.value!;
 assert.ok(Number.isFinite(value)&&value>0);
 assert.ok(value<width(BULL_PUT)*QTY*1.01,"bounded by the strike width it purchased");
 assert.equal(s.payoff.settlementFees!.globalFeeInclusiveMaximum,"bounded",
  "both legs of a bull put are out of the money above the short strike");
});

test("STRUCTURAL: the reported loss is the exported canonical value, not a local recomputation",()=>{
 const row=economicsRow(BULL_PUT);
 const s=only(widthFixture(BULL_PUT,{economics:row}));
 assert.equal(s.payoff.maximumStructuralLossUsd.value,row.maximum_structural_loss_usd);
 assert.equal(s.payoff.maximumStructuralLossBtc.value,row.maximum_structural_loss_native);
 assert.equal(s.payoff.structuralLossSource,"structure_economics");
 assert.equal(s.payoff.structuralLossMethodVersion,STRUCTURAL_LOSS_METHOD_VERSION);
 // A deliberately altered canonical export is followed, which is exactly what
 // "consumed, not recomputed" has to mean.
 const shifted=economicsRow(BULL_PUT,{maximum_structural_loss_usd:1234.5,maximum_structural_loss_native:1234.5/ENTRY_INDEX});
 assert.equal(only(widthFixture(BULL_PUT,{economics:shifted})).payoff.maximumStructuralLossUsd.value,1234.5);
});

test("STRUCTURAL: margin_scenarios is reconciliation, and a material disagreement is an integrity failure",()=>{
 const economics=economicsRow(BULL_PUT);
 const agreeing={candidate_id:"c1",margin_status:"available",margin_model:"standard",
  maximum_structural_loss_usd:economics.maximum_structural_loss_usd,
  maximum_structural_loss_native:economics.maximum_structural_loss_native,
  reference_index:ENTRY_INDEX,incremental_initial_margin:.02,peak_initial_margin:.03};
 const reconciled=only(widthFixture(BULL_PUT,{economics,margin:agreeing})).payoff;
 assert.equal(reconciled.structuralLossReconciled,true);
 assert.equal(reconciled.maximumStructuralLossUsd.value,economics.maximum_structural_loss_usd);

 const disagreeing={...agreeing,maximum_structural_loss_usd:5_000_000};
 const broken=only(widthFixture(BULL_PUT,{economics,margin:disagreeing})).payoff;
 assert.equal(broken.maximumStructuralLossUsd.value,null,"neither canonical figure may be chosen silently");
 assert.match(broken.maximumStructuralLossUsd.reason!,/disagree/i);
});

test("STRUCTURAL: changing a scenario delivery fee does not redefine the structural loss",()=>{
 const base=economicsRow(BULL_PUT);
 const treatment=base.settlement_fee_treatment as Record<string,unknown>;
 const inflated=economicsRow(BULL_PUT,{settlement_fee_treatment:{...treatment,
  scenario_delivery_fees_btc:5,scenario_delivery_fees_usd:5*ENTRY_INDEX}});
 const before=only(widthFixture(BULL_PUT,{economics:base})).payoff;
 const after=only(widthFixture(BULL_PUT,{economics:inflated})).payoff;
 assert.equal(after.maximumStructuralLossUsd.value,before.maximumStructuralLossUsd.value,
  "delivery fees are reported beside the structural loss, never inside it");
 // The fee itself is still visible and still moved.
 assert.equal(after.settlementFeesAtStructuralLossBtc,5);
 assert.notEqual(after.settlementFeesAtStructuralLossBtc,before.settlementFeesAtStructuralLossBtc);
});

test("STRUCTURAL: Standard Margin IM and MM are untouched by the structural-loss source",()=>{
 const margin={candidate_id:"c1",margin_status:"available",margin_model:"standard",
  account_configuration:"segregated_sm",incremental_initial_margin:.02,
  peak_initial_margin:.03,peak_maintenance_margin:.015,reference_index:ENTRY_INDEX};
 const withoutEconomics=only(widthFixture(BULL_PUT,{margin})).capital;
 const withEconomics=only(widthFixture(BULL_PUT,{economics:economicsRow(BULL_PUT),margin:{...margin,
  maximum_structural_loss_usd:(economicsRow(BULL_PUT).maximum_structural_loss_usd as number)}})).capital;
 for(const capital of [withoutEconomics,withEconomics]){
  assert.ok(Math.abs(capital.incrementalInitialMarginUsd.value!-.02*ENTRY_INDEX)<1e-9);
  assert.ok(Math.abs(capital.peakMarginUsd.value!-.03*ENTRY_INDEX)<1e-9);
  assert.equal(capital.marginModel,"standard");
  // Structural loss is an economic quantity; it is never reused as margin.
  assert.notEqual(capital.incrementalInitialMarginUsd.value,capital.maximumStructuralLossUsd.value);
 }
});

test("STRUCTURAL: with no canonical table at all the canonical METHOD is still used, never the old extremum",()=>{
 const s=only(widthFixture(BEAR_CALL));
 const helper=canonicalStructuralLoss(payoffInput(BEAR_CALL));
 assert.equal(s.payoff.structuralLossSource,"canonical_helper");
 assert.equal(s.payoff.maximumStructuralLossUsd.value,helper.usd);
 assert.ok(s.payoff.maximumStructuralLossUsd.value!<1e4,"still bounded, on the same bear call that produced the artifact");
});

test("STRUCTURAL: the reader reports an explicit reason when nothing canonical exists",()=>{
 const reading=readCanonicalStructuralLoss({});
 assert.equal(reading.status,"unavailable");
 assert.equal(reading.usd,null);
 assert.match(reading.reason!,/structure_economics|margin_scenarios/);
});
