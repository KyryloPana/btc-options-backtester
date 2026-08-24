import test from "node:test";import assert from "node:assert/strict";
import {expiryPayoff,payoffExtrema,type ExpiryPayoffInput} from "../app/lib/expiry-payoff.ts";
import {STRUCTURAL_LOSS_METHOD_VERSION,canonicalStructuralLoss,structuralSampleIndices} from "../app/lib/maximum-economic-loss.ts";
import {buildResearchMarginSnapshot} from "../app/lib/research-margin.ts";
import {estimateStandardOptionMargin,DEFAULT_DEPLOYMENT} from "../app/lib/margin.ts";
import {buildResearchBundle,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {buildEventFuturesBaseline} from "../app/lib/futures-baseline.ts";
import {now,referenceOnlyFixture} from "./fixtures/research-selection-store.ts";
import {ENTRY,futuresEvent} from "./fixtures/futures-market.ts";

const EXPIRY=Date.parse("2026-09-25T08:00:00Z");
/** Ordinary credit spreads at realistic BTC strikes, priced to a real credit. */
const spread=(optionType:"C"|"P",shortStrike:number,longStrike:number,entryIndex:number,amount=1):ExpiryPayoffInput=>
 ({optionType,shortStrike,longStrike,shortEntryPremiumBtc:0.02,longEntryPremiumBtc:0.012,entryIndex,amount,openingFeesBtc:0.0003,expiryTimestamp:EXPIRY});
const BEAR_1K=spread("C",100_000,101_000,98_000);
const BEAR_3K=spread("C",100_000,103_000,98_000);
const BEAR_4K=spread("C",100_000,104_000,98_000);
const BULL_1K=spread("P",100_000,99_000,101_000);

// ---------------------------------------------------------------------------
// The specific failure mode
// ---------------------------------------------------------------------------

test("REGRESSION: 0.0003 BTC of delivery fees times MAX_SAFE_INTEGER produced the $2.7T artifact",()=>{
 // The historical defect, reproduced exactly so it can never return silently.
 const tail=expiryPayoff(BEAR_1K,Number.MAX_SAFE_INTEGER,"usd-cash-flow");
 assert.equal(tail.settlementFeesBtc,0.0003,"both legs finish deep ITM, each paying the fixed 0.00015 BTC delivery fee");
 assert.ok(Math.abs(tail.pnl)>2.7e12,`the raw tail sample really is a trillion-dollar number (${tail.pnl})`);
 assert.ok(Math.abs(tail.settlementFeesBtc*Number.MAX_SAFE_INTEGER-2.702159776667e12)<1e6,
  "the artifact is exactly the fixed BTC fee converted at the sampled settlement index");
 assert.ok(Math.abs(payoffExtrema(BEAR_1K,"usd-cash-flow").maximumLoss)>1e12,
  "the fee-inclusive extremum still reports that sample; this is why it is no longer the canonical loss");

 // The canonical structural loss is economically plausible for a $1k spread.
 const canonical=canonicalStructuralLoss(BEAR_1K);
 assert.equal(canonical.status,"available");
 assert.ok(canonical.usd!>0&&canonical.usd!<1_000,`structural loss must be sub-width (${canonical.usd})`);
 assert.equal(Number(canonical.usd!.toFixed(2)),245.40);
 // Width minus the net credit received, exactly.
 const netCreditUsd=(0.02-0.012-0.0003)*98_000;
 assert.ok(Math.abs(canonical.usd!-(1_000-netCreditUsd))<1e-9);
 // Nothing is discarded: structural + the named scenario fee reconstructs the
 // bounded part of the old figure.
 assert.equal(canonical.settlementFees.includedInStructuralLoss,false);
 assert.equal(canonical.settlementFees.globalFeeInclusiveMaximum,"unbounded");
 assert.equal(canonical.settlementFees.scenarioIndex,101_000,"the tightest settlement at which the maximum is attained");
 assert.ok(Math.abs(canonical.settlementFees.scenarioDeliveryFeesUsd!-15.15)<1e-9);
});

test("STRUCTURAL LOSS: a larger artificial tail settlement index cannot increase it",()=>{
 for(const input of [BEAR_1K,BEAR_3K,BEAR_4K,BULL_1K]){
  const baseline=canonicalStructuralLoss(input).usd!;
  assert.ok(Number.isFinite(baseline)&&baseline>0&&baseline<1e5,`plausible bounded loss (${baseline})`);
  // The canonical sampler stays in a numerically sound range near the strikes.
  const indices=structuralSampleIndices(input);
  assert.ok(indices.every(index=>index<=Math.max(input.shortStrike,input.longStrike,input.entryIndex)*4),
   "the plateau sample is bounded; Number.MAX_SAFE_INTEGER is never used");
  assert.ok(!indices.includes(Number.MAX_SAFE_INTEGER));
  // Walking the settlement index outwards never finds a worse structural loss.
  const far=Math.max(input.shortStrike,input.longStrike,input.entryIndex);
  for(const multiplier of [1,2,4,10,100,1_000]){
   const index=far*multiplier;
   const point=expiryPayoff(input,index,"usd-cash-flow");
   // Signed: a profit at this settlement is not a loss, so compare against the
   // negative bound rather than taking an absolute value.
   const structural=point.netEntryCashFlowBtc*input.entryIndex+point.grossPositionValueBtc*index;
   assert.ok(structural>=-baseline*(1+1e-6),`structural loss at S=${index} (${-structural}) must not exceed ${baseline}`);
   // The fee-inclusive figure at the same index does grow without bound, which
   // is exactly the quantity that must never be called a maximum.
   if(input.optionType==="C"&&multiplier>=100)assert.ok(Math.abs(point.pnl)>baseline,"fee-inclusive loss keeps growing with the sampled index");
  }
 }
});

test("STRUCTURAL LOSS: $1k and $3k bear calls and the bull-put comparison stay plausible",()=>{
 const bear1=canonicalStructuralLoss(BEAR_1K),bear3=canonicalStructuralLoss(BEAR_3K),bull=canonicalStructuralLoss(BULL_1K);
 assert.equal(Number(bear1.usd!.toFixed(2)),245.40);
 assert.equal(Number(bear3.usd!.toFixed(2)),2_245.40);
 assert.equal(Number(bull.usd!.toFixed(2)),222.30);
 // Widening by $2k widens the structural loss by exactly $2k; the credit is unchanged.
 assert.ok(Math.abs((bear3.usd!-bear1.usd!)-2_000)<1e-9);
 for(const loss of [bear1,bear3,bull]){
  assert.equal(loss.methodVersion,STRUCTURAL_LOSS_METHOD_VERSION);
  assert.equal(loss.signConvention,"positive_magnitude");
  assert.equal(loss.btcAtReferenceIndex,loss.usd!/loss.referenceIndex!);
  assert.ok(loss.btcAtReferenceIndex!<1,"a bounded BTC representation, never a tail extremum");
  assert.match(String(loss.assumption),/representation at one index/);
 }
 // The bull put is unaffected by the bear-call defect and must not regress.
 assert.equal(bull.settlementFees.globalFeeInclusiveMaximum,"bounded");
 assert.ok(Math.abs(payoffExtrema(BULL_1K,"usd-cash-flow").maximumLoss)<1_000,
  "the bull put's fee-inclusive extremum was always bounded, which is why the defect hid");
});

test("FEE HONESTY: an unbounded global fee-inclusive maximum is never reported as a finite number",()=>{
 for(const input of [BEAR_1K,BEAR_3K,BEAR_4K]){
  const fees=canonicalStructuralLoss(input).settlementFees;
  assert.equal(fees.globalFeeInclusiveMaximum,"unbounded");
  assert.match(fees.globalFeeInclusiveMaximumReason,/without bound/);
  // The scenario figure is finite and explicitly labelled scenario-specific.
  assert.ok(Number.isFinite(fees.scenarioDeliveryFeesUsd!));
  assert.match(String(fees.scenarioLabel),/settlement at the index/);
  assert.ok(fees.scenarioIndex!<=Math.max(input.shortStrike,input.longStrike),
   "the named scenario is at a real strike, not an arbitrary gigantic index");
 }
});

// ---------------------------------------------------------------------------
// Reconciliation across the canonical layers
// ---------------------------------------------------------------------------

const structureFor=(input:ExpiryPayoffInput)=>({
 candidateSnapshot:{optionType:input.optionType,shortStrike:input.shortStrike,longStrike:input.longStrike,expiryTimestamp:input.expiryTimestamp},
 quantity:input.amount,
 referenceValuation:{status:"valued" as const,reason:null,source:"local_iv_interpolation" as const,
  entrySnapshot:{valuationTimestamp:EXPIRY-7*864e5,entryTargetIndex:input.entryIndex,
   sold:{priceBtcPerContract:input.shortEntryPremiumBtc},bought:{priceBtcPerContract:input.longEntryPremiumBtc},
   openingFeesBtc:input.openingFeesBtc},
  valuationPathSnapshot:[],outcomeSnapshots:[],provenance:null}});

test("RECONCILIATION: margin metadata reports the same canonical structural loss",()=>{
 for(const input of [BEAR_1K,BEAR_3K,BULL_1K]){
  const snapshot=buildResearchMarginSnapshot(structureFor(input)) as Record<string,unknown>;
  const canonical=canonicalStructuralLoss(input);
  assert.equal(snapshot.maximumStructuralLossUsd,canonical.usd);
  assert.equal(snapshot.maximumStructuralLossBtcAtReferenceIndex,canonical.btcAtReferenceIndex);
  assert.equal(snapshot.referenceIndex,input.entryIndex);
  assert.equal(snapshot.maximumLossMethodVersion,STRUCTURAL_LOSS_METHOD_VERSION);
  const fees=snapshot.settlementFeeTreatment as Record<string,unknown>;
  assert.equal(fees.included_in_structural_loss,false);
  assert.equal(fees.global_fee_inclusive_maximum,input.optionType==="C"?"unbounded":"bounded");
  assert.ok(Number(snapshot.maximumStructuralLossUsd)<1e5,"no trillion-dollar figure reaches the margin layer");
 }
});

test("MARGIN UNCHANGED: IM and MM do not move when the maximum-loss semantics change",()=>{
 // The Standard Margin formula echoes the theoretical spread loss but never
 // consumes it, so correcting that quantity must not move a margin number.
 const common={side:"short" as const,optionType:"C" as const,amount:1,strike:100_000,indexPrice:98_000,
  markPriceBtc:0.02,observationTimestamp:EXPIRY-7*864e5,deployment:DEFAULT_DEPLOYMENT};
 const tiny=estimateStandardOptionMargin({...common,theoreticalMaximumSpreadLossBtc:0.0025});
 const huge=estimateStandardOptionMargin({...common,theoreticalMaximumSpreadLossBtc:2.7e12});
 assert.equal(tiny.state,"ok");
 assert.equal(tiny.initialMarginBtc,huge.initialMarginBtc,"IM is independent of the maximum-loss input");
 assert.equal(tiny.maintenanceMarginBtc,huge.maintenanceMarginBtc,"MM is independent of the maximum-loss input");
 // The closed form still holds: OTM call, so max(0.15 - OTM, 0.10).
 const otm=(100_000-98_000)/98_000;
 assert.ok(Math.abs(tiny.initialMarginBtc!-(0.02+Math.max(0.15-otm,0.10)))<1e-12);
 assert.ok(Math.abs(tiny.maintenanceMarginBtc!-(0.02+0.075))<1e-12);
});

/** The shared reference fixture, re-struck as an ordinary $1k-wide bear call. */
function bearCallFixture(){
 const fixture=referenceOnlyFixture();
 const event=fixture.events[0]!,structure=event.selectedStructures[0]! as unknown as Record<string,unknown>;
 structure.candidateSnapshot={...(structure.candidateSnapshot as Record<string,unknown>),
  optionType:"C",shortStrike:BEAR_1K.shortStrike,longStrike:BEAR_1K.longStrike,actualWidth:1_000,expiryTimestamp:EXPIRY};
 const reference=structure.referenceValuation as Record<string,unknown>;
 reference.entrySnapshot={...(reference.entrySnapshot as Record<string,unknown>),
  entryTargetIndex:BEAR_1K.entryIndex,targetIndex:BEAR_1K.entryIndex,
  sold:{priceBtcPerContract:BEAR_1K.shortEntryPremiumBtc},bought:{priceBtcPerContract:BEAR_1K.longEntryPremiumBtc},
  openingFeesBtc:BEAR_1K.openingFeesBtc};
 structure.marginSnapshot=null;
 const generated=event.generationSnapshot.candidates.find(c=>c.candidateId===structure.candidateId);
 if(generated){generated.optionType="C";generated.requestedStrikes={short:BEAR_1K.shortStrike,long:BEAR_1K.longStrike,width:1_000};
  generated.actualStrikes={short:BEAR_1K.shortStrike,long:BEAR_1K.longStrike,width:1_000};generated.actualExpiryTimestamp=EXPIRY;}
 return fixture;
}

test("EXPORT: structure economics and margin scenarios agree, and the manifest validates",()=>{
 const bundle=buildResearchBundle(bearCallFixture(),now);
 const checked=validateResearchBundle(bundle.files);
 assert.equal(checked.ok,true,checked.errors.join(" | "));
 const economics=JSON.parse(bundle.files["structure_economics.jsonl"].trim().split(String.fromCharCode(10))[0]!);
 const margin=JSON.parse(bundle.files["margin_scenarios.jsonl"].trim().split(String.fromCharCode(10))[0]!);
 assert.equal(economics.maximum_structural_loss_status,"available");
 assert.equal(Number(economics.maximum_structural_loss_usd.toFixed(2)),245.40,"an ordinary $1k bear call, not $2.7 trillion");
 assert.equal(economics.maximum_structural_loss_usd,margin.maximum_structural_loss_usd);
 assert.equal(economics.maximum_structural_loss_native,margin.maximum_structural_loss_native);
 assert.equal(economics.maximum_structural_loss_reference_index,margin.reference_index);
 assert.equal(economics.settlement_fee_treatment.global_fee_inclusive_maximum,"unbounded");
 assert.equal(economics.settlement_fee_treatment.included_in_structural_loss,false);
 assert.ok(Number(economics.settlement_fee_treatment.scenario_delivery_fees_usd)<100,"fees are a scenario figure, not a tail artifact");
 // The credit ratio uses the structural loss, so it is an interpretable fraction.
 const netCreditUsd=Number(economics.net_reference_opening_cash_flow_native)*Number(economics.reference_underlying_index);
 assert.ok(Math.abs(Number(economics.credit_per_maximum_structural_loss)-netCreditUsd/Number(economics.maximum_structural_loss_usd))<1e-9);
 assert.ok(Number(economics.credit_per_maximum_structural_loss)>0&&Number(economics.credit_per_maximum_structural_loss)<100,
  "an interpretable credit-to-risk fraction, not a ratio against a trillion");
 assert.ok(!("maximum_economic_loss_usd" in economics),"the misleading fee-inclusive name is gone, not silently reused");
});

// ---------------------------------------------------------------------------
// Futures equal-risk sizing
// ---------------------------------------------------------------------------

test("FUTURES: equal-risk sizing uses the bounded structural loss and stays plausible",()=>{
 const structural=canonicalStructuralLoss(BEAR_1K).usd!;
 const event=futuresEvent("long",{invalidationPrice:80,maximumStructuralLossUsd:structural});
 (event.selectedStructures[0] as unknown as {marginSnapshot:Record<string,number>}).marginSnapshot={maximumStructuralLossUsd:structural};
 const comparison=buildEventFuturesBaseline(event).comparison;
 assert.equal(comparison.risk_budget_usd,structural);
 const risk=Number(comparison.risk_to_invalidation_usd_per_unit);
 assert.equal(comparison.quantity,structural/risk);
 assert.ok(Number(comparison.quantity)<100,`an ordinary $1k spread must not size hundreds of millions of BTC (${comparison.quantity})`);
 assert.ok(Number(comparison.risk_budget_usd)<10_000,`no trillion-dollar risk budget (${comparison.risk_budget_usd})`);
 assert.match(String(comparison.equal_risk_sizing_method),/maximum_structural_loss_usd/);

 // The old fee-inclusive figure would have produced exactly the absurd result.
 const poisoned=futuresEvent("long",{invalidationPrice:80});
 (poisoned.selectedStructures[0] as unknown as {marginSnapshot:Record<string,number>}).marginSnapshot={maximumStructuralLossUsd:2.702159776667e12};
 const absurd=buildEventFuturesBaseline(poisoned).comparison;
 assert.ok(Number(absurd.quantity)>1e10,"proving the sizing path is what the corrected input protects");
 assert.notEqual(comparison.quantity,absurd.quantity);
 assert.equal(comparison.reference_entry_timestamp_utc,new Date(ENTRY).toISOString(),"nothing else about the baseline moved");
});
