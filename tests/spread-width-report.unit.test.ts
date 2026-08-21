import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {normalizeWidthStructures} from "../app/lib/spread-width/normalize.ts";
import {buildSpreadWidthReport} from "../app/lib/spread-width/report.ts";
import {expiryPayoff,payoffExtrema} from "../app/lib/expiry-payoff.ts";

const H=36e5;
const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);
const ENTRY_INDEX=42000,QTY=1;

/**
 * One bullish MR at 42,000, short put fixed at 40,000, three protective longs
 * (39,000 / 38,000 / 37,000) so width is the only thing that varies.
 */
const events=[
 {event_id:"e1",direction:"long",entry_price:ENTRY_INDEX,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),
  vpoc_trigger_timestamp_utc:D(3),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
 {event_id:"e2",direction:"long",entry_price:ENTRY_INDEX,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),
  vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:D(4,5),
  observation_end_timestamp_utc:D(20),sequence_status:"invalidation_first",censoring_status:"resolved"},
 {event_id:"e3",direction:"long",entry_price:ENTRY_INDEX,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,entry_timestamp_utc:D(1),
  vpoc_trigger_timestamp_utc:D(12),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
];

const flat=()=>({high:42400,low:41600,close:42000});
const dipToStrike=(h:number)=>h===30?{high:42000,low:39990,close:41000}:flat();
const path=(eventId:string,shape:(h:number)=>{high:number;low:number;close:number})=>
 Array.from({length:24*5},(_,i)=>{const s=shape(i);
  return {event_id:eventId,timestamp_utc:new Date(T(1)+i*H).toISOString(),open:42000,high:s.high,low:s.low,close:s.close,index_price:s.close}});
const underlying_path=[...path("e1",dipToStrike),...path("e2",flat),...path("e3",flat)];

/** Premiums fall as the long strike moves further out, so wider = more credit. */
const LONG_PREMIUM:Record<number,number>={39000:.0030,38000:.0018,37000:.0010};
const SHORT_PREMIUM=.0075;

function candidate(eventId:string,longStrike:number,scenario:"maker"|"taker",over:Record<string,unknown>={}){
 const width=40000-longStrike,longPremium=LONG_PREMIUM[longStrike]!;
 const gross=(SHORT_PREMIUM-longPremium)*QTY,fees=.0004;
 const id=`${eventId}-w${width}`;
 return {
  event_id:eventId,candidate_id:id,structure_execution_id:`${id}~${scenario}`,direction:"long",
  option_type:"P",structure_type:"bull_put_credit",strike_method:"anchor",
  actual_strikes:{short:40000,long:longStrike,width},
  requested_strikes:{short:40000,long:longStrike,width},
  expiry_timestamp_utc:D(8),actual_dte:7,target_horizon_days:7,
  structure_entry_timestamp_utc:D(1),execution_scenario:scenario,execution_scenario_status:"evaluated",
  entry_index_price:ENTRY_INDEX,quantity:QTY,
  entry_legs:{short:{action:"sell",price_native:SHORT_PREMIUM},long:{action:"buy",price_native:longPremium}},
  gross_credit_debit_native:gross,opening_fees_native:fees,net_opening_cash_flow_native:gross-fees,
  ...over,
 };
}

const candidates=[
 candidate("e1",39000,"maker"),candidate("e1",38000,"maker"),candidate("e1",37000,"maker"),
 candidate("e2",39000,"maker"),candidate("e2",38000,"maker"),
 candidate("e3",39000,"maker"),candidate("e3",38000,"maker"),
 // Same ladder under taker, so scenario mixing is detectable.
 candidate("e1",39000,"taker"),candidate("e1",38000,"taker"),
 // A DIFFERENT short strike: must never join e1's width ladder.
 {...candidate("e1",38000,"maker"),candidate_id:"e1-otherK",structure_execution_id:"e1-otherK~maker",
  actual_strikes:{short:39000,long:38000,width:1000},requested_strikes:{short:39000,long:38000,width:1000}},
 // Requested 2000 but historical availability delivered 3000.
 {...candidate("e3",37000,"maker"),candidate_id:"e3-substituted",structure_execution_id:"e3-substituted~maker",
  requested_strikes:{short:40000,long:38000,width:2000}},
];

const outcomes=[
 {event_id:"e1",candidate_id:"e1-w1000",execution_scenario:"maker",outcome_type:"vpoc",status:"priced",net_pnl_usd:180},
 {event_id:"e1",candidate_id:"e1-w2000",execution_scenario:"maker",outcome_type:"vpoc",status:"priced",net_pnl_usd:230},
 {event_id:"e1",candidate_id:"e1-w3000",execution_scenario:"maker",outcome_type:"vpoc",status:"priced",net_pnl_usd:260},
 {event_id:"e1",candidate_id:"e1-w1000",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:180},
 {event_id:"e1",candidate_id:"e1-w2000",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:230},
 {event_id:"e1",candidate_id:"e1-w3000",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:260},
 {event_id:"e2",candidate_id:"e2-w1000",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-260},
 {event_id:"e2",candidate_id:"e2-w2000",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-410},
 {event_id:"e3",candidate_id:"e3-w1000",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:170},
 {event_id:"e3",candidate_id:"e3-w2000",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:220},
];

const valuations=[
 {event_id:"e1",candidate_id:"e1-w1000",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-180},
 {event_id:"e1",candidate_id:"e1-w2000",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-240},
 {event_id:"e1",candidate_id:"e1-w3000",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-300},
];

/** No margin data anywhere: the canonical default. */
const margin_scenarios=[{event_id:"e1",candidate_id:"e1-w1000",margin_status:"unavailable",
 incremental_initial_margin:null,peak_initial_margin:null,peak_maintenance_margin:null,maximum_loss_usd:null}];

const dataset={filename:"f.zip",schemaVersion:"2.2.0",migratedFrom:null,run:{dataset_id:"ds",bundle_id:"b"},
 tables:{events,candidates,outcomes,valuations,underlying_path,margin_scenarios,availability:[]},
 counts:{selectedCandidates:candidates.length,denominator:candidates.length},venues:["deribit"],sourceRuns:[],
 eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;

const all=normalizeWidthStructures(dataset);
const pick=(id:string,scenario:"maker"|"taker"="maker")=>all.find(s=>s.candidateId===id&&s.executionScenario===scenario)!;
const report=buildSpreadWidthReport(dataset,"maker");
const groupFor=(eventId:string)=>report.groups.find(g=>g.eventId===eventId&&g.shortStrike===40000)!;

/* ---------------- matching ---------------- */

test("MATCHING: a width ladder holds event, expiry, short strike and scenario constant",()=>{
 const group=groupFor("e1");
 assert.equal(group.structures.length,3);
 for(const s of group.structures){
  assert.equal(s.identity.shortStrike,40000);
  assert.equal(s.executionScenario,"maker");
  assert.equal(s.expiryTimestampMs,group.structures[0]!.expiryTimestampMs);
 }
 assert.deepEqual(group.structures.map(s=>s.identity.actualWidthUsd),[1000,2000,3000],"ordered by ACTUAL width");
});

test("MATCHING: a different short strike never joins the width ladder",()=>{
 const group=groupFor("e1");
 assert.ok(group.structures.every(s=>s.candidateId!=="e1-otherK"));
 // It forms its own single-structure key and is reported as unmatched.
 const orphan=report.unmatched.find(u=>u.structure.candidateId==="e1-otherK")!;
 assert.ok(orphan);
 assert.match(orphan.reason,/no other width shares this event/i);
 assert.notEqual(pick("e1-otherK").matchKey,pick("e1-w2000").matchKey);
});

test("MATCHING: observed maker and taker remain separate ladders while scenario is absent from the structural key",()=>{
 assert.ok(report.structures.every(s=>s.executionScenario==="maker"));
 assert.ok(report.groups.every(g=>g.structures.every(s=>s.executionScenario==="maker")));
 const taker=buildSpreadWidthReport(dataset,"taker");
 assert.ok(taker.groups.every(g=>g.structures.every(s=>s.executionScenario==="taker")));
 assert.equal(pick("e1-w1000","maker").matchKey,pick("e1-w1000","taker").matchKey);
});

test("MATCHING: adjacent steps are consecutive widths inside one group, not aggregate totals",()=>{
 const steps=groupFor("e1").steps;
 assert.deepEqual(steps.map(s=>[s.narrowerWidthUsd,s.widerWidthUsd]),[[1000,2000],[2000,3000]]);
 assert.ok(steps.every(s=>s.shortStrike===40000));
});

/* ---------------- requested vs actual width ---------------- */

test("ACTUAL WIDTH: when requested equals actual, both agree and nothing is flagged",()=>{
 const s=pick("e1-w2000");
 assert.equal(s.identity.requestedWidthUsd,2000);
 assert.equal(s.identity.actualWidthUsd,2000);
 assert.equal(s.identity.widthSubstituted,false);
});

test("ACTUAL WIDTH: a substituted width is flagged and the ACTUAL strikes drive the economics",()=>{
 const s=pick("e3-substituted");
 assert.equal(s.identity.requestedWidthUsd,2000,"the request is retained for audit");
 assert.equal(s.identity.actualWidthUsd,3000,"availability delivered a wider spread");
 assert.equal(s.identity.widthSubstituted,true);
 // Credit-per-width differs by denominator, proving the actual width is the one used.
 assert.notEqual(s.entry.creditPerActualWidth,s.entry.creditPerRequestedWidth);
 const netUsd=s.entry.netCreditUsd!;
 assert.ok(Math.abs(s.entry.creditPerActualWidth!-netUsd/3000)<1e-9,"actual width is the economic denominator");
 assert.ok(Math.abs(s.entry.creditPerRequestedWidth!-netUsd/2000)<1e-9,"the requested figure stays visible but separate");
 // It is placed on the ladder at its ACTUAL width.
 assert.equal(groupFor("e3").structures.at(-1)!.identity.actualWidthUsd,3000);
});

/* ---------------- entry economics ---------------- */

test("ENTRY: gross, fees and net credit come from canonical per-leg fields",()=>{
 const s=pick("e1-w2000");
 const gross=(SHORT_PREMIUM-LONG_PREMIUM[38000]!)*QTY;
 assert.ok(Math.abs(s.entry.grossCreditBtc!-gross)<1e-12);
 assert.equal(s.entry.openingFeesBtc,.0004);
 assert.ok(Math.abs(s.entry.netCreditBtc!-(gross-.0004))<1e-12);
 assert.ok(Math.abs(s.entry.grossCreditUsd!-gross*ENTRY_INDEX)<1e-9);
});

test("ENTRY: long-leg share, fee drag and the round-trip estimate are explicit",()=>{
 const s=pick("e1-w1000");
 assert.ok(Math.abs(s.entry.longLegCostShareOfShortPremium!-LONG_PREMIUM[39000]!/SHORT_PREMIUM)<1e-12);
 assert.ok(Math.abs(s.entry.feeDragOnOpening!-.0004/s.entry.grossCreditBtc!)<1e-12);
 // A round trip is four legs, so the estimate must exceed the opening alone.
 assert.ok(s.entry.estimatedRoundTripFeesBtc!>s.entry.openingFeesBtc!);
 assert.ok(s.entry.feeDragRoundTrip!>s.entry.feeDragOnOpening!);
});

test("ENTRY: a narrower spread keeps less credit than a wider one on this ladder",()=>{
 assert.ok(pick("e1-w1000").entry.netCreditUsd!<pick("e1-w3000").entry.netCreditUsd!,
  "a closer protective long costs more premium, so it retains less credit");
});

/* ---------------- inverse payoff ---------------- */

test("PAYOFF: maximum economic loss comes from the authoritative inverse utility, not width minus credit",()=>{
 const s=pick("e1-w2000");
 const input={optionType:"P" as const,shortStrike:40000,longStrike:38000,
  shortEntryPremiumBtc:SHORT_PREMIUM,longEntryPremiumBtc:LONG_PREMIUM[38000]!,
  entryIndex:ENTRY_INDEX,amount:QTY,openingFeesBtc:.0004,expiryTimestamp:T(8)};
 const expected=payoffExtrema(input,"usd-cash-flow");
 assert.equal(s.payoff.maxEconomicLossUsd.value,expected.maximumLoss);
 assert.equal(s.payoff.maxProfitUsd.value,expected.maximumProfit);
 // The naive model would be width - net credit; the exact inverse payoff is not that.
 const naive=-(2000-s.entry.netCreditUsd!);
 assert.notEqual(Math.round(s.payoff.maxEconomicLossUsd.value!),Math.round(naive));
});

test("PAYOFF: the result is settlement-price dependent and carries a BTC equivalent",()=>{
 const s=pick("e1-w2000");
 const input={optionType:"P" as const,shortStrike:40000,longStrike:38000,
  shortEntryPremiumBtc:SHORT_PREMIUM,longEntryPremiumBtc:LONG_PREMIUM[38000]!,
  entryIndex:ENTRY_INDEX,amount:QTY,openingFeesBtc:.0004,expiryTimestamp:T(8)};
 const high=expiryPayoff(input,45000,"usd-cash-flow").pnl,low=expiryPayoff(input,36000,"usd-cash-flow").pnl;
 assert.ok(high>low,"the payoff genuinely depends on the settlement index");
 assert.notEqual(s.payoff.maxEconomicLossBtc.value,s.payoff.maxEconomicLossUsd.value,"native BTC and USD are distinct");
 assert.notEqual(s.payoff.maxLossIndex,null);
 assert.ok(s.payoff.settlementFeesAtMaxLossBtc!>=0,"per-leg settlement fees are included");
});

test("PAYOFF: a wider spread carries a strictly larger maximum economic loss",()=>{
 const losses=groupFor("e1").structures.map(s=>s.payoff.maxEconomicLossUsd.value!);
 for(let i=1;i<losses.length;i++)assert.ok(losses[i]!<losses[i-1]!,"loss is negative, so wider is more negative");
});

test("PAYOFF: breakeven is solved on the canonical net payoff",()=>{
 const s=pick("e1-w2000");
 assert.notEqual(s.payoff.breakEvenIndex.value,null);
 assert.ok(s.payoff.breakEvenIndex.value!<40000,"a bull put credit breaks even below its short strike");
});

test("PAYOFF: invalid canonical inputs leave the payoff Unavailable with a reason",()=>{
 const broken={...dataset,tables:{...dataset.tables,candidates:candidates.map(c=>
  c.candidate_id==="e1-w2000"&&c.execution_scenario==="maker"?{...c,entry_legs:{short:{price_native:null},long:{price_native:null}}}:c)}} as unknown as AnalysisDataset;
 const s=normalizeWidthStructures(broken).find(x=>x.candidateId==="e1-w2000"&&x.executionScenario==="maker")!;
 assert.equal(s.payoff.maxEconomicLossUsd.value,null);
 assert.match(s.payoff.maxEconomicLossUsd.reason!,/canonical premium|absent/i);
 assert.equal(s.capital.returnOnMaxLoss.value,null,"a ratio whose denominator is missing stays Unavailable");
});

/* ---------------- long-leg insurance ---------------- */

test("PROTECTION: the counterfactual removes only the long leg, keeping everything else identical",()=>{
 const s=pick("e1-w2000");
 assert.equal(s.protection.longLegPremiumBtc,LONG_PREMIUM[38000]!*QTY);
 assert.ok(s.protection.totalProtectionCostUsd!>0,"the long leg costs premium plus its share of fees");
 // At the long strike protection has begun to bite; deep in the tail it is
 // worth far more, because the unprotected short has no floor.
 assert.notEqual(s.protection.benefitAtLongStrikeUsd.value,null);
 assert.ok(s.protection.benefitAtDeepTailUsd.value!>s.protection.benefitAtLongStrikeUsd.value!);
 assert.equal(s.protection.nakedTailUnbounded,true);
});

test("PROTECTION: a wider spread buys less tail protection for less premium",()=>{
 const narrow=pick("e1-w1000"),wide=pick("e1-w3000");
 assert.ok(narrow.protection.longLegPremiumUsd!>wide.protection.longLegPremiumUsd!,"the closer long costs more");
 assert.ok(narrow.protection.benefitAtDeepTailUsd.value!>wide.protection.benefitAtDeepTailUsd.value!,
  "and removes more of the tail");
});

test("PROTECTION: cost and benefit are reported separately, never netted into a verdict",()=>{
 const s=pick("e1-w1000");
 assert.notEqual(s.protection.totalProtectionCostUsd,null);
 assert.notEqual(s.protection.benefitAtDeepTailUsd.value,null);
 assert.equal(s.protection.netProtectionValueUsd,s.protection.benefitAtDeepTailUsd.value!-s.protection.totalProtectionCostUsd!);
 assert.ok(report.methodology.some(l=>/No width is chosen/i.test(l)));
});

/* ---------------- path risk ---------------- */

test("PATH: outcomes are candidate-relative and touch/breach is shared across the ladder",()=>{
 // The short strike is identical at every width, so the challenge state must be too.
 const states=groupFor("e1").structures.map(s=>`${s.challenge.touched}/${s.challenge.breached}`);
 assert.equal(new Set(states).size,1,"width cannot change whether the short strike was touched");
 assert.equal(pick("e1-w1000").challenge.touched,true);
 assert.equal(pick("e1-w1000").challenge.breached,false);
 // e1 never invalidates, so no invalidation PnL may be attributed to it.
 assert.equal(pick("e1-w1000").pnlAtInvalidationUsd,null);
 assert.equal(pick("e2-w1000").pnlAtInvalidationUsd,-260,"e2 genuinely invalidated in-window");
});

test("PATH: worst adverse widens with width and never uses a modelled mark",()=>{
 assert.equal(pick("e1-w1000").worstAdverseUsd,-180);
 assert.equal(pick("e1-w3000").worstAdverseUsd,-300);
 assert.equal(pick("e2-w1000").worstAdverseUsd,null,"no raw track for e2");
 assert.equal(pick("e2-w1000").adverse.status,"raw_evaluation_not_attempted");
});

test("PATH: slow-resolution cohorts reuse the canonical Duration & DTE boundaries",()=>{
 assert.ok(report.cohortBoundaries.resolvedEventsN>0);
 const widths=report.slowResolution.map(r=>r.actualWidthUsd);
 assert.deepEqual(widths,report.summary.distinctActualWidths);
 for(const row of report.slowResolution)
  assert.deepEqual(row.cells.map(c=>c.cohort),["fast","normal","slow","unresolved"],"unresolved stays an explicit cohort");
 const populated=report.slowResolution.flatMap(r=>r.cells).filter(c=>c.n>0);
 assert.ok(populated.length>0,"the fixture spans more than one cohort");
});

/* ---------------- capital ---------------- */

test("CAPITAL: maximum economic loss, opening margin and peak margin stay three separate things",()=>{
 const c=pick("e1-w2000").capital;
 assert.notEqual(c.maxEconomicLossUsd.value,null,"max loss is a payoff property and is computable");
 assert.equal(c.incrementalInitialMarginUsd.value,null,"opening margin is an account property and is unavailable here");
 assert.equal(c.peakMarginUsd.value,null);
 assert.match(c.incrementalInitialMarginUsd.reason!,/account model|portfolio margin/i);
 // The maximum loss must never be silently reused as a margin figure.
 assert.notEqual(c.incrementalInitialMarginUsd.value,c.maxEconomicLossUsd.value);
});

test("CAPITAL: a return is Unavailable exactly when its denominator is",()=>{
 const c=pick("e1-w2000").capital;
 assert.notEqual(c.returnOnMaxLoss.value,null,"max loss exists, so this ratio exists");
 assert.equal(c.returnOnOpeningMargin.value,null);
 assert.equal(c.returnOnPeakCapital.value,null);
 assert.match(c.returnOnOpeningMargin.reason!,/account model|portfolio margin/i);
});

test("CAPITAL: a genuinely available margin figure produces a real ratio",()=>{
 const withMargin={...dataset,tables:{...dataset.tables,margin_scenarios:[
  {event_id:"e1",candidate_id:"e1-w2000",margin_status:"available",margin_model:"standard",
   account_configuration:"segregated_sm",incremental_initial_margin:.02,peak_initial_margin:.03,peak_maintenance_margin:null}]}} as unknown as AnalysisDataset;
 const s=normalizeWidthStructures(withMargin).find(x=>x.candidateId==="e1-w2000"&&x.executionScenario==="maker")!;
 assert.ok(Math.abs(s.capital.incrementalInitialMarginUsd.value!-.02*ENTRY_INDEX)<1e-9);
 assert.ok(Math.abs(s.capital.peakMarginUsd.value!-.03*ENTRY_INDEX)<1e-9);
 assert.notEqual(s.capital.returnOnOpeningMargin.value,null);
 assert.notEqual(s.capital.returnOnPeakCapital.value,null);
 assert.equal(s.capital.marginModel,"standard");
 // Opening and peak stay distinct even when both exist.
 assert.notEqual(s.capital.incrementalInitialMarginUsd.value,s.capital.peakMarginUsd.value);
});

test("CAPITAL: the report surfaces how much capital data actually exists",()=>{
 assert.equal(report.summary.openingMarginAvailableN,0);
 assert.equal(report.summary.peakMarginAvailableN,0);
 assert.ok(report.summary.maxLossAvailableN>0,"max loss is computable even with no margin data at all");
 const row=report.capital.find(r=>r.actualWidthUsd===2000)!;
 assert.equal(row.medianOpeningMarginUsd,null);
 assert.match(row.marginUnavailableReason!,/account model|portfolio margin/i);
});

/* ---------------- paired width steps ---------------- */

test("STEPS: adjacent-width differences are pairwise, not aggregate",()=>{
 const step=groupFor("e1").steps[0]!;
 assert.equal(step.narrowerWidthUsd,1000);
 assert.equal(step.widerWidthUsd,2000);
 assert.ok(step.deltaNetCreditUsd!>0,"widening retains more credit");
 assert.ok(step.deltaMaxEconomicLossUsd!<0,"and carries a larger maximum loss");
 assert.equal(step.deltaWorstAdverseUsd,-240-(-180),"wider ran further under water on the same path");
 assert.ok(step.deltaProtectionBenefitUsd!<0,"the wider long removes less tail");
 assert.equal(step.economicsComparable,true);
});

test("STEPS: an unevaluated scenario leaves economic deltas Unavailable, never zero",()=>{
 const notEvaluated={...dataset,tables:{...dataset.tables,candidates:candidates.map(c=>
  c.candidate_id==="e1-w2000"&&c.execution_scenario==="maker"
   ?{...c,execution_scenario_status:"not_evaluated",execution_scenario_reason:"No maker-consistent tape print.",
     entry_legs:null,gross_credit_debit_native:null,net_opening_cash_flow_native:null,opening_fees_native:null}:c)}} as unknown as AnalysisDataset;
 const r=buildSpreadWidthReport(notEvaluated,"maker");
 const step=r.groups.find(g=>g.eventId==="e1")!.steps[0]!;
 assert.equal(step.economicsComparable,false);
 assert.equal(step.deltaNetCreditUsd,null);
 assert.equal(step.deltaWorstAdverseUsd,null);
});

/* ---------------- summary and missing data ---------------- */

test("SUMMARY: matched observations, width bands and substitution are all reported",()=>{
 const s=report.summary;
 assert.deepEqual(s.distinctActualWidths,[1000,2000,3000]);
 assert.equal(s.matchedGroups,3,"e1, e2 and e3 each have a ladder");
 assert.equal(s.substitutedWidthN,1,"only e3-substituted differs from its request");
 assert.ok(s.adjacentSteps>=4);
 assert.notEqual(s.medianMaxEconomicLossUsd,null);
});

test("MISSING DATA: a single-width group is excluded from pairwise comparison",()=>{
 const single={...dataset,tables:{...dataset.tables,
  candidates:candidates.filter(c=>!(c.event_id==="e2"&&c.candidate_id==="e2-w2000"))}} as unknown as AnalysisDataset;
 const r=buildSpreadWidthReport(single,"maker");
 assert.equal(r.groups.some(g=>g.eventId==="e2"),false,"e2 no longer has an adjacent width");
 assert.ok(r.unmatched.some(u=>u.structure.eventId==="e2"),"and is reported rather than dropped");
});

test("MISSING DATA: no raw valuation path leaves adverse figures Unavailable, not zero",()=>{
 const noRaw={...dataset,tables:{...dataset.tables,valuations:[]}} as unknown as AnalysisDataset;
 const r=buildSpreadWidthReport(noRaw,"maker");
 assert.ok(r.structures.every(s=>s.worstAdverseUsd===null));
 assert.equal(r.pathRisk.find(p=>p.actualWidthUsd===1000)!.medianWorstAdverseUsd,null);
 // Entry economics and payoff are unaffected by a missing valuation track.
 assert.notEqual(r.entryEconomics.find(p=>p.actualWidthUsd===1000)!.medianNetCreditUsd,null);
});

test("MISSING DATA: an empty bundle produces no groups and no fabricated statistics",()=>{
 const empty={...dataset,tables:{events:[],candidates:[],outcomes:[],valuations:[],underlying_path:[],margin_scenarios:[],availability:[]}} as unknown as AnalysisDataset;
 const r=buildSpreadWidthReport(empty,"maker");
 assert.equal(r.groups.length,0);
 assert.equal(r.summary.matchedObservations,0);
 assert.equal(r.summary.medianNetCreditUsd,null);
 assert.deepEqual(r.summary.distinctActualWidths,[]);
});

test("SCOPE: the short strike is constant everywhere and width is never selected",()=>{
 for(const g of report.groups)assert.equal(new Set(g.structures.map(s=>s.identity.shortStrike)).size,1);
 assert.ok(report.methodology.some(l=>/analyses PROTECTIVE WIDTH only/i.test(l)));
 assert.ok(report.methodology.some(l=>/never re-optimized here/i.test(l)));
});
