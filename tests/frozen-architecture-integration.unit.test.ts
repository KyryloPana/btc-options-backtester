import test from "node:test";import assert from "node:assert/strict";
import {zipSync,strToU8} from "fflate";
import {buildResearchBundle,validateResearchBundle,RESEARCH_BUNDLE_SCHEMA_VERSION} from "../app/lib/research-bundle.ts";
import {importResearchBundle} from "../app/lib/research-analysis.ts";
import {canonicalStructuralLoss} from "../app/lib/maximum-economic-loss.ts";
import {payoffExtrema} from "../app/lib/expiry-payoff.ts";
import {buildEventFuturesBaseline} from "../app/lib/futures-baseline.ts";
import {estimateStandardOptionMargin,DEFAULT_DEPLOYMENT} from "../app/lib/margin.ts";
import {now,referenceOnlyFixture,ts} from "./fixtures/research-selection-store.ts";
import {futuresEvent} from "./fixtures/futures-market.ts";

const HOUR=3_600_000,DAY=86_400_000,EXPIRY=ts+7*DAY;
const rows=(text:string)=>text.trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);

/**
 * ONE composed cross-system fixture. It is not a re-run of the three focused
 * suites: it exists so the three fixes must hold TOGETHER, in a single export,
 * and it fails if any of regressions A-F returns.
 *
 * It carries a bear call and a bull put (so the bear-call-only fee divergence
 * is exercised alongside a control), a substituted width, an evaluated
 * reference track with fixed-time outcomes, sparse strict execution, a delayed
 * track with a usable path and one with entry-only evidence.
 */
const BEAR={optionType:"C" as const,shortStrike:100_000,longStrike:101_000,shortEntryPremiumBtc:0.02,longEntryPremiumBtc:0.012,entryIndex:98_000,amount:1,openingFeesBtc:0.0003,expiryTimestamp:EXPIRY};
const BULL={optionType:"P" as const,shortStrike:100_000,longStrike:99_000,shortEntryPremiumBtc:0.02,longEntryPremiumBtc:0.012,entryIndex:101_000,amount:1,openingFeesBtc:0.0003,expiryTimestamp:EXPIRY};

const pricedOutcome=(label:string,offsetMs:number,pnl:number)=>({label,trigger:`${label} trigger`,
 decisionTimestamp:ts+offsetMs,valuationTimestamp:ts+offsetMs,targetIndex:101,conversionIndex:101,
 status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:pnl,feesBtc:0.0002,
 evidenceSource:"direct-vwap",evidenceReason:"Bounded causal tape."});

const delayedPoint=(entryMs:number,offsetMs:number,pnl:number)=>
 ({timestamp:entryMs+offsetMs,hoursFromEntry:offsetMs/HOUR,underlyingIndex:101,
  remainingDte:Math.max(0,(EXPIRY-(entryMs+offsetMs))/DAY),intrinsicSpreadBtc:0.004,estimatedPnlBtc:pnl,maxLossDays:0.1});

function composedFixture(){
 const fixture=referenceOnlyFixture();
 const event=fixture.events[0]!,structure=event.selectedStructures[0]! as unknown as Record<string,unknown>;
 // A bear call with a SUBSTITUTED width: requested 2k, actually resolved to 1k.
 structure.candidateSnapshot={...(structure.candidateSnapshot as Record<string,unknown>),
  optionType:"C",shortStrike:BEAR.shortStrike,longStrike:BEAR.longStrike,actualWidth:1_000,expiryTimestamp:EXPIRY};
 const generated=event.generationSnapshot.candidates.find(c=>c.candidateId===structure.candidateId);
 if(generated){generated.optionType="C";generated.actualExpiryTimestamp=EXPIRY;
  generated.requestedStrikes={short:BEAR.shortStrike,long:102_000,width:2_000};
  generated.actualStrikes={short:BEAR.shortStrike,long:BEAR.longStrike,width:1_000};}
 const reference=structure.referenceValuation as Record<string,unknown>;
 reference.entrySnapshot={...(reference.entrySnapshot as Record<string,unknown>),
  entryTargetIndex:BEAR.entryIndex,targetIndex:BEAR.entryIndex,
  sold:{priceBtcPerContract:BEAR.shortEntryPremiumBtc},bought:{priceBtcPerContract:BEAR.longEntryPremiumBtc},
  openingFeesBtc:BEAR.openingFeesBtc};
 reference.outcomeSnapshots=[
  pricedOutcome("VPOC",2*HOUR,0.0015),pricedOutcome("50% credit",8*HOUR,0.0021),
  pricedOutcome("3D",3*DAY,0.0033),pricedOutcome("5D",5*DAY,0.0041),pricedOutcome("7D",6*DAY,0.0047),
  {label:"Invalidation",trigger:"First completed 1H candle beyond invalidation",status:"not-hit",
   estimateQuality:"unavailable",evidenceSource:"unavailable",evidenceReason:"The exit condition was not reached."},
  // A recognised source marker outside the exported contract.
  {label:"14D",trigger:"14 days after entry",decisionTimestamp:ts+14*DAY,status:"unavailable",
   estimateQuality:"unavailable",evidenceReason:"Target occurs after contract expiry."},
 ];
 structure.marginSnapshot=null;
 // Delayed maker: real opening plus a usable causal path. Delayed taker:
 // opening evidence only, which must never read as a complete economic track.
 const delayedEntry=ts+4*HOUR;
 structure.delayedExecution={version:"entry-timing-v1",
  maker:{status:"evaluated",reason:null,source:"delayed observed maker opportunity",
   entrySnapshot:{valuationTimestamp:delayedEntry,targetTimestamp:delayedEntry,entryTargetIndex:101,
    grossSpreadBtc:0.009,openingFeesBtc:0.0005,netOpeningCashFlowBtc:0.0085,estimateQuality:"green",
    provenance:{observed:true,makerQueueFillClaimed:false,causalAfterRequestedOrder:true}},
   valuationPathSnapshot:[delayedPoint(delayedEntry,HOUR,0.004),delayedPoint(delayedEntry,2*DAY,0.006)],
   outcomeSnapshots:[{label:"terminal delayed path",valuationTimestamp:delayedEntry+2*DAY,estimatedNetPnlBtc:0.006}]},
  taker:{status:"evaluated",reason:null,source:"delayed conservative taker tape proxy",
   entrySnapshot:{valuationTimestamp:ts+DAY,targetTimestamp:ts+DAY,entryTargetIndex:101,
    grossSpreadBtc:0.008,openingFeesBtc:0.0005,netOpeningCashFlowBtc:0.0075,estimateQuality:"yellow"},
   valuationPathSnapshot:[],outcomeSnapshots:[]}};
 return {fixture,delayedEntry};
}

const composedBundle=()=>{
 const {fixture,delayedEntry}=composedFixture();
 const bundle=buildResearchBundle(fixture,now,undefined,{tradeDatasetMrEventCount:15});
 const checked=validateResearchBundle(bundle.files);
 assert.equal(checked.ok,true,checked.errors.join(" | "));
 return {bundle,delayedEntry};
};

test("INTEGRATION: the three fixes hold together in one export",()=>{
 const {bundle,delayedEntry}=composedBundle();
 const economics=rows(bundle.files["structure_economics.jsonl"])[0]!;
 const margin=rows(bundle.files["margin_scenarios.jsonl"])[0]!;
 const outcomes=rows(bundle.files["outcomes.jsonl"]).filter(r=>r.analytics_track==="reference_fair_value");
 const tracks=economics.tracks as Array<Record<string,unknown>>;

 // A. Bear-call structural loss is bounded and plausible, never trillion-scale.
 const expected=canonicalStructuralLoss(BEAR).usd!;
 assert.ok(expected>0&&expected<1_000,`structural loss must be sub-width (${expected})`);
 assert.equal(economics.maximum_structural_loss_usd,expected);
 assert.equal(economics.maximum_structural_loss_usd,margin.maximum_structural_loss_usd,"one canonical risk across tables");
 assert.equal(economics.maximum_structural_loss_native,margin.maximum_structural_loss_native);
 assert.equal(economics.settlement_fee_treatment&&(economics.settlement_fee_treatment as Record<string,unknown>).global_fee_inclusive_maximum,"unbounded");
 // The raw fee-inclusive extremum is still trillion-scale; it simply is not the canonical risk.
 assert.ok(Math.abs(payoffExtrema(BEAR,"usd-cash-flow").maximumLoss)>1e12);

 // Requested/actual strike and width provenance survives the substitution.
 assert.equal(economics.requested_width,2_000);
 assert.equal(economics.actual_width,1_000);
 assert.equal(economics.width_substituted,true);
 assert.equal(economics.requested_long_strike,102_000);
 assert.equal(economics.actual_long_strike,BEAR.longStrike);

 // B. Evaluated fixed-time sources export evaluated, with their own PnL.
 for(const [outcome,pnl] of [["fixed_3d",0.0033],["fixed_5d",0.0041],["fixed_7d",0.0047]] as const){
  const row=outcomes.find(r=>r.outcome_type===outcome)!;
  assert.equal(row.status,"evaluated",`${outcome} must not regress to unavailable`);
  assert.equal(row.net_pnl_native,pnl);
 }
 assert.equal(outcomes.find(r=>r.outcome_type==="invalidation")!.status,"unavailable","a not-hit source keeps its status");
 assert.ok(!outcomes.some(r=>r.outcome_type==="fixed_14d"),"a source marker outside the contract is not promoted to an exit policy");

 // C. Evaluated outcomes carry holding time from their own track entry.
 assert.deepEqual(
  Object.fromEntries(outcomes.filter(r=>r.status==="evaluated").map(r=>[r.outcome_type,r.holding_hours])),
  {vpoc:2,credit_capture_50:8,fixed_3d:72,fixed_5d:120,fixed_7d:144});
 assert.equal(outcomes.find(r=>r.outcome_type==="invalidation")!.holding_hours,null);

 // D. Delayed availability reconciles with real priced rows, in both directions.
 const maker=tracks.find(t=>t.track==="delayed_maker")!,taker=tracks.find(t=>t.track==="delayed_taker")!;
 assert.equal(maker.status,"available");
 assert.equal(maker.path_status,"available");
 const makerRows=rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker");
 assert.equal(makerRows.filter(r=>r.valuation_status==="priced").length,2,"available means priced rows exist");
 assert.ok(makerRows.every(r=>r.entry_timestamp_utc===new Date(delayedEntry).toISOString()),"anchored to the delayed opening, not the signal");
 assert.equal(taker.status,"unavailable","entry-only evidence is not a complete economic track");
 assert.equal(taker.entry_status,"available");
 assert.equal(taker.path_status,"unavailable");
 assert.equal(taker.reason_code,"delayed_entry_available_path_unavailable");
 assert.equal(rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_taker").length,0);

 // Cross-table candidate integrity.
 assert.equal(rows(bundle.files["structure_economics.jsonl"]).length,1,"one scenario-independent economic row per candidate");
 assert.equal(tracks.length,7);
 assert.equal(tracks.find(t=>t.track==="reference_fair_value")!.status,"available");
 assert.equal(tracks.find(t=>t.track==="modeled_expected")!.status,"unavailable");
 assert.notEqual(tracks.find(t=>t.track==="modeled_expected")!.reason,null);
 for(const track of ["strict_maker","strict_taker"])assert.ok(tracks.some(t=>t.track===track),"strict statuses stay independent");
 // Per-leg IV survives untouched, with no spread-level IV invented.
 const iv=rows(bundle.files["valuations.jsonl"]).find(r=>r.analytics_track==="reference_fair_value"
  &&(r.short_leg_volatility as Record<string,unknown>|undefined)?.iv_decimal!=null)!;
 for(const field of ["iv_decimal","iv_units","iv_source","iv_source_timestamp_utc","observation","anchor_index","target_index","dte_days"])
  assert.ok(field in (iv.short_leg_volatility as Record<string,unknown>),field);
 assert.ok(!Object.keys(iv).some(key=>/^spread_iv|spread_volatility/.test(key)));
});

test("INTEGRATION: E -- futures equal-risk consumes the bounded structural risk",()=>{
 const structural=canonicalStructuralLoss(BEAR).usd!;
 const event=futuresEvent("long",{invalidationPrice:80});
 (event.selectedStructures[0] as unknown as {marginSnapshot:Record<string,number>}).marginSnapshot={maximumStructuralLossUsd:structural};
 const comparison=buildEventFuturesBaseline(event).comparison;
 assert.equal(comparison.risk_budget_usd,structural);
 assert.match(String(comparison.equal_risk_sizing_method),/maximum_structural_loss_usd/);
 assert.ok(Number(comparison.risk_budget_usd)<10_000,"no trillion-scale risk budget");
 assert.ok(Number(comparison.quantity)<1_000,`no hundreds of millions of BTC-equivalent units (${comparison.quantity})`);
 assert.ok(Math.abs(Number(comparison.gross_trading_pnl_usd))<1e6,"total futures PnL is not trillion-scale from poisoned sizing");
 // The authoritative per-unit layer is untouched by the sizing change.
 assert.equal(comparison.direction,"long");
 assert.ok(Number.isFinite(comparison.reference_entry_price as number));
 assert.ok(Number.isFinite(comparison.exit_price as number));
 assert.ok(Number.isFinite(comparison.gross_pnl_usd_per_unit as number));
 assert.ok(Number.isFinite(comparison.fees_usd_per_unit as number));
 assert.ok(Number(comparison.risk_to_invalidation_usd_per_unit)>0);
 assert.equal(comparison.funding_status,"available");
 // Missing funding stays explicit, never silently zero.
 const noFunding=futuresEvent("long",{invalidationPrice:80});
 delete (noFunding.generationSnapshot.futuresMarket as {funding?:unknown}).funding;
 const withoutFunding=buildEventFuturesBaseline(noFunding).comparison;
 assert.equal(withoutFunding.funding_status,"unavailable");
 assert.equal(withoutFunding.funding_usd_per_unit,null);
});

test("INTEGRATION: F -- an older exported bundle is rejected, never reinterpreted",()=>{
 const {bundle}=composedBundle();
 const zip=(files:Record<string,string>)=>zipSync(Object.fromEntries(
  Object.entries(files).map(([name,text])=>[`research_bundle/${name}`,strToU8(text)])));
 // 3.4.0 carried fee-inclusive max loss; 3.5.0 carried null holding time.
 // Neither can be faithfully upgraded, so both must be refused on import.
 for(const previous of ["3.4.0","3.5.0","3.3.0","3.2.0"]){
  const files={...bundle.files,"run.json":bundle.files["run.json"].replace(`"${RESEARCH_BUNDLE_SCHEMA_VERSION}"`,`"${previous}"`)};
  assert.equal(validateResearchBundle(files).ok,false,`${previous} must not validate under current semantics`);
  const imported=importResearchBundle(zip(files),`old-${previous}.zip`);
  assert.equal(imported.status,"invalid",`${previous} must not import under current semantics`);
 }
 // The current bundle imports cleanly, so the rejection is about semantics.
 assert.notEqual(importResearchBundle(zip(bundle.files),"current.zip").status,"invalid");
});

test("INTEGRATION: Standard Margin is unmoved by the structural-loss semantics",()=>{
 const {bundle}=composedBundle();
 const margin=rows(bundle.files["margin_scenarios.jsonl"])[0]!;
 // Structural risk is metadata on the margin row, never an IM/MM input.
 const common={side:"short" as const,optionType:"C" as const,amount:1,strike:BEAR.shortStrike,
  indexPrice:BEAR.entryIndex,markPriceBtc:0.02,observationTimestamp:ts,deployment:DEFAULT_DEPLOYMENT};
 const small=estimateStandardOptionMargin({...common,theoreticalMaximumSpreadLossBtc:canonicalStructuralLoss(BEAR).btcAtReferenceIndex!});
 const poisoned=estimateStandardOptionMargin({...common,theoreticalMaximumSpreadLossBtc:2.702159776667e12});
 assert.equal(small.state,"ok");
 assert.equal(small.initialMarginBtc,poisoned.initialMarginBtc);
 assert.equal(small.maintenanceMarginBtc,poisoned.maintenanceMarginBtc);
 const otm=(BEAR.shortStrike-BEAR.entryIndex)/BEAR.entryIndex;
 assert.ok(Math.abs(small.initialMarginBtc!-(0.02+Math.max(0.15-otm,0.10)))<1e-12);
 assert.ok(Math.abs(small.maintenanceMarginBtc!-(0.02+0.075))<1e-12);
 // Portfolio Margin stays unavailable and the protective long is never margin.
 assert.equal(margin.portfolio_margin_status,"unavailable");
 for(const key of Object.keys(margin))assert.ok(!/protective|long_leg_cash/i.test(key),key);
});

test("INTEGRATION: the bull-put control does not regress",()=>{
 const bull=canonicalStructuralLoss(BULL);
 assert.equal(bull.status,"available");
 assert.ok(bull.usd!>0&&bull.usd!<1_000);
 assert.equal(bull.settlementFees.globalFeeInclusiveMaximum,"bounded","only a bear call diverges");
 assert.equal(bull.btcAtReferenceIndex,bull.usd!/BULL.entryIndex);
 // Widening moves structural risk by exactly the extra width.
 const wider=canonicalStructuralLoss({...BULL,longStrike:97_000});
 assert.ok(Math.abs((wider.usd!-bull.usd!)-2_000)<1e-9);
});
