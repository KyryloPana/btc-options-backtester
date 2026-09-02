import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {normalizeShortStrikeStructures,strikeMethodOf} from "../app/lib/short-strike/normalize.ts";
import {buildShortStrikeReport} from "../app/lib/short-strike/report.ts";

const H=36e5;
const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const T=(day:number,hour=0)=>Date.UTC(2026,0,day,hour);

/**
 * A bullish MR at 42,000 whose failed-breakout extreme is 40,050.
 * Technical short put = 40,000 (extreme rounded down), buffered = 39,000.
 * Range 39,500-44,500 (width 5,000); invalidation 39,800.
 */
const events=[
 {event_id:"e1",direction:"long",entry_price:42000,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,
  entry_timestamp_utc:D(1),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
 // e2 is invalidated on day 4, and its strike is never breached.
 {event_id:"e2",direction:"long",entry_price:42000,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,
  entry_timestamp_utc:D(1),invalidation_decision_timestamp_utc:D(4,5),
  observation_end_timestamp_utc:D(20),sequence_status:"invalidation_first",censoring_status:"resolved"},
 // e3 breaches, then is invalidated three hours later: order is determinate.
 {event_id:"e3",direction:"long",entry_price:42000,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,
  entry_timestamp_utc:D(1),invalidation_decision_timestamp_utc:D(3,6),
  observation_end_timestamp_utc:D(20),sequence_status:"invalidation_first",censoring_status:"resolved"},
 // e4 breaches inside the SAME hourly candle as its invalidation: ambiguous.
 {event_id:"e4",direction:"long",entry_price:42000,extreme_price:40050,invalidation_price:39800,
  range_low:39500,range_high:44500,vpoc_price:43500,
  entry_timestamp_utc:D(1),invalidation_decision_timestamp_utc:D(3,3,),
  observation_end_timestamp_utc:D(20),sequence_status:"invalidation_first",censoring_status:"resolved"},
 // e5 is a BEARISH MR: short call above spot, so "safer" is a HIGHER strike.
 {event_id:"e5",direction:"short",entry_price:42000,extreme_price:43950,invalidation_price:44200,
  range_low:39500,range_high:44500,vpoc_price:40500,
  entry_timestamp_utc:D(1),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved"},
];

/** Hourly candles from day 1 to day 6; `dip`/`spike` shape the challenge. */
function path(eventId:string,shape:(hour:number)=>{high:number;low:number;close:number}){
 return Array.from({length:24*5},(_,i)=>{
  const s=shape(i);
  return {event_id:eventId,timestamp_utc:new Date(T(1)+i*H).toISOString(),
   open:42000,high:s.high,low:s.low,close:s.close,index_price:s.close};
 });
}
const flat=()=>({high:42400,low:41600,close:42000});
// Touches 40,000 at hour 30 but never closes below it.
const touchOnly=(h:number)=>h===30?{high:42000,low:39990,close:41000}:flat();
// e3: breaches at hour 51 (day 3 03:00), invalidation at day 3 06:00 -> ordered.
const breachDay3=(h:number)=>h>=51?{high:41000,low:39400,close:39850}:flat();
// e4: breaches at hour 51 = day 3 03:00, invalidation stamped in the same candle.
const breachSameCandle=(h:number)=>h>=51?{high:41000,low:39400,close:39850}:flat();
const spikeUp=(h:number)=>h===30?{high:44010,low:42000,close:43000}:flat();

const underlying_path=[
 ...path("e1",touchOnly),...path("e2",flat),...path("e3",breachDay3),
 ...path("e4",breachSameCandle),...path("e5",spikeUp),
];

/** One (event, expiry, width) family in one scenario, at two placements. */
function candidate(eventId:string,method:"anchor"|"buffered",scenario:"maker"|"taker",over:Record<string,unknown>={}){
 const bearish=eventId==="e5";
 const short=bearish?(method==="anchor"?44000:45000):(method==="anchor"?40000:39000);
 const long=bearish?short+1000:short-1000;
 const id=`${eventId}-${method}`;
 return {
  event_id:eventId,candidate_id:id,structure_execution_id:`${id}~${scenario}`,
  direction:bearish?"short":"long",
  strike_method:method,option_type:bearish?"C":"P",structure_type:bearish?"bear_call_credit":"bull_put_credit",
  actual_strikes:{short,long,width:1000},
  expiry_timestamp_utc:D(8),actual_dte:7,target_horizon_days:7,
  structure_entry_timestamp_utc:D(1),
  execution_scenario:scenario,execution_scenario_status:"evaluated",
  entry_index_price:42000,
  gross_credit_debit_native:method==="anchor"?.0100:.0060,
  net_opening_cash_flow_native:method==="anchor"?.0090:.0052,
  ...over,
 };
}

const candidates=[
 candidate("e1","anchor","maker"),candidate("e1","buffered","maker"),
 candidate("e2","anchor","maker"),candidate("e2","buffered","maker"),
 candidate("e3","anchor","maker"),candidate("e3","buffered","maker"),
 candidate("e4","anchor","maker"),candidate("e4","buffered","maker"),
 candidate("e5","anchor","maker"),candidate("e5","buffered","maker"),
 // Same structures under taker, so mixing can be detected if it ever happens.
 candidate("e1","anchor","taker"),candidate("e1","buffered","taker"),
 // A technical structure with no buffered partner: must stay unpaired.
 {...candidate("e1","anchor","maker"),candidate_id:"e1-anchor-w2000",
  structure_execution_id:"e1-anchor-w2000~maker",actual_strikes:{short:40000,long:38000,width:2000}},
];

const outcomes=[
 {event_id:"e2",candidate_id:"e2-anchor",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-420},
 {event_id:"e2",candidate_id:"e2-buffered",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-260},
 {event_id:"e1",candidate_id:"e1-anchor",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:420},
 {event_id:"e1",candidate_id:"e1-buffered",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:252},
 {event_id:"e3",candidate_id:"e3-anchor",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-900},
 {event_id:"e3",candidate_id:"e3-buffered",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-500},
 // An invalidation priced for e5, whose invalidation never occurs in-window.
 {event_id:"e5",candidate_id:"e5-anchor",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",net_pnl_usd:-777},
 {event_id:"e5",candidate_id:"e5-anchor",execution_scenario:"maker",outcome_type:"settlement",status:"priced",net_pnl_usd:300},
];

const valuations=[
 {event_id:"e1",candidate_id:"e1-anchor",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-300},
 {event_id:"e1",candidate_id:"e1-anchor",execution_scenario:"maker",timestamp_utc:D(3),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:120},
 {event_id:"e1",candidate_id:"e1-buffered",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-140},
 {event_id:"e1",candidate_id:"e1-buffered",execution_scenario:"maker",timestamp_utc:D(3),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:90},
 // Modelled marks must never fill an adverse figure.
 {event_id:"e2",candidate_id:"e2-anchor",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"iv_normalized",valuation_status:"priced",net_pnl_usd:-9999},
 // A pre-entry and a post-expiry raw mark, neither of which may contribute.
 {event_id:"e3",candidate_id:"e3-anchor",execution_scenario:"maker",timestamp_utc:D(0),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-5000},
 {event_id:"e3",candidate_id:"e3-anchor",execution_scenario:"maker",timestamp_utc:D(19),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-6000},
 {event_id:"e3",candidate_id:"e3-anchor",execution_scenario:"maker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-210},
];

const dataset={filename:"f.zip",schemaVersion:"2.2.0",migratedFrom:null,run:{dataset_id:"ds",bundle_id:"b"},
 tables:{events,candidates,outcomes,valuations,underlying_path,availability:[],margin_scenarios:[]},
 counts:{selectedCandidates:candidates.length,denominator:candidates.length},venues:["deribit"],sourceRuns:[],
 eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;

const all=normalizeShortStrikeStructures(dataset);
const pick=(candidateId:string,scenario:"maker"|"taker"="maker")=>all.find(s=>s.candidateId===candidateId&&s.executionScenario===scenario)!;
const report=buildShortStrikeReport(dataset,"maker");
const pairFor=(eventId:string)=>report.pairs.find(p=>p.eventId===eventId&&p.widthUsd===1000)!;

/* ---------------- matching ---------------- */

test("MATCHING: pairs hold event, expiry, width, structure and scenario constant",()=>{
 const pair=pairFor("e1");
 assert.equal(pair.technical.strikeMethod,"technical");
 assert.equal(pair.buffered.strikeMethod,"buffered");
 for(const key of ["eventId","expiryTimestampMs","widthUsd","structureType","optionType","executionScenario"] as const)
  assert.deepEqual(pair.buffered[key],pair.technical[key],`${key} must be held constant inside a pair`);
 assert.equal(pair.technical.matchKey,pair.buffered.matchKey);
});

test("MATCHING: a structure with no partner at its width is excluded, not force-matched",()=>{
 // e1 also has a 2000-wide technical structure with no buffered counterpart.
 assert.equal(report.pairs.filter(p=>p.eventId==="e1").length,1,"only the 1000-wide family pairs");
 const orphan=report.unpaired.find(u=>u.structure.candidateId==="e1-anchor-w2000")!;
 assert.ok(orphan,"the unmatched structure is reported rather than dropped");
 assert.match(orphan.reason,/no buffered-strike structure/i);
});

test("MATCHING: observed maker and taker remain strict robustness layers while scenario is absent from the structural key",()=>{
 assert.ok(report.pairs.every(p=>p.technical.executionScenario==="maker"&&p.buffered.executionScenario==="maker"));
 assert.ok(report.structures.every(s=>s.executionScenario==="maker"));
 const taker=buildShortStrikeReport(dataset,"taker");
 assert.ok(taker.pairs.every(p=>p.technical.executionScenario==="taker"&&p.buffered.executionScenario==="taker"));
 assert.equal(taker.pairs.length,1,"only e1 has both placements under taker");
 // Scenario is deliberately absent from the primary structural key; explicit observed layers still filter before pairing.
 assert.ok(!pick("e1-anchor","maker").matchKey.includes("taker"));
 assert.equal(pick("e1-anchor","maker").matchKey,pick("e1-anchor","taker").matchKey);
});

test("MATCHING: canonical strike_method is read, never inferred from the strike value",()=>{
 assert.equal(strikeMethodOf("anchor"),"technical");
 assert.equal(strikeMethodOf("buffered"),"buffered");
 assert.equal(strikeMethodOf("something-else"),null);
 assert.equal(strikeMethodOf(null),null);
});

/* ---------------- geometry ---------------- */

test("GEOMETRY: distances are signed so positive always means farther out of the money",()=>{
 const technical=pick("e1-anchor").geometry,buffered=pick("e1-buffered").geometry;
 // Bullish: short put below spot. 42,000 - 40,000 = 2,000.
 assert.equal(technical.distanceFromEntrySpotUsd,2000);
 assert.equal(buffered.distanceFromEntrySpotUsd,3000);
 // Beyond the failed-breakout extreme of 40,050.
 assert.equal(technical.distanceFromExtremeUsd,50);
 assert.equal(buffered.distanceFromExtremeUsd,1050);
 // Invalidation 39,800: the technical strike sits ABOVE it (negative), the
 // buffered one below it, i.e. the thesis stops out first.
 assert.equal(technical.distanceFromInvalidationUsd,-200);
 assert.equal(buffered.distanceFromInvalidationUsd,800);
});

test("GEOMETRY: a bearish MR reverses the geometry without reversing the sign convention",()=>{
 const technical=pick("e5-anchor").geometry,buffered=pick("e5-buffered").geometry;
 // Short call above spot: 44,000 - 42,000 = 2,000 out of the money.
 assert.equal(technical.distanceFromEntrySpotUsd,2000);
 assert.equal(buffered.distanceFromEntrySpotUsd,3000);
 assert.equal(technical.distanceFromExtremeUsd,50,"44,000 is 50 beyond the 43,950 extreme");
 assert.equal(buffered.distanceFromInvalidationUsd,800,"45,000 is 800 beyond the 44,200 invalidation");
});

test("GEOMETRY: normalized distances use entry spot and the event's range width",()=>{
 const g=pick("e1-anchor").geometry;
 assert.equal(g.entrySpot,42000);
 assert.equal(g.entrySpotSource,"entry_index_price");
 assert.ok(Math.abs(g.distanceAsPctOfSpot!-2000/42000)<1e-12);
 assert.ok(Math.abs(g.distanceAsPctOfRange!-2000/5000)<1e-12,"range width is 44,500 - 39,500");
});

test("GEOMETRY: entry delta is Unavailable with its reason, never reconstructed",()=>{
 const g=pick("e1-anchor").geometry;
 assert.equal(g.entryDelta,null);
 assert.match(g.entryDeltaReason!,/no delta on any table/i);
 assert.equal(report.geometry.find(r=>r.method==="technical")!.medianEntryDelta,null);
});

/* ---------------- challenge ---------------- */

test("CHALLENGE: a touch is an intrabar extreme, a breach is a completed close beyond the strike",()=>{
 const touched=pick("e1-anchor").challenge;
 assert.equal(touched.touched,true,"the 39,990 low reached the 40,000 strike");
 assert.equal(touched.breached,false,"but no candle closed below it");
 assert.equal(touched.firstTouchMs,T(1)+30*H);
 assert.equal(touched.firstBreachMs,null);
 // The buffered 39,000 strike was never even touched by the same path.
 assert.equal(pick("e1-buffered").challenge.touched,false);
});

test("CHALLENGE: invalidation without a breach is distinguished from a breach",()=>{
 const c=pick("e2-anchor").challenge;
 assert.equal(c.breached,false);
 assert.equal(c.invalidatedInWindow,true);
 assert.equal(c.invalidatedWithoutBreach,true);
 assert.equal(c.breachBeforeInvalidation,null,"there is no breach to order");
});

test("CHALLENGE: breach before invalidation is asserted only when the candles differ",()=>{
 const c=pick("e3-anchor").challenge;
 assert.equal(c.breached,true);
 assert.equal(c.firstBreachMs,T(1)+51*H,"day 3 03:00");
 assert.equal(c.invalidatedInWindow,true);
 assert.equal(c.breachBeforeInvalidation,true,"breach 03:00 precedes invalidation 06:00");
 assert.equal(c.ambiguousOrdering,false);
 assert.equal(c.invalidatedWithoutBreach,false);
});

test("CHALLENGE: same-candle ordering is preserved as ambiguous, never invented",()=>{
 const c=pick("e4-anchor").challenge;
 assert.equal(c.breached,true);
 assert.equal(c.invalidatedInWindow,true);
 assert.equal(c.ambiguousOrdering,true,"both fall inside the day-3 03:00 candle");
 assert.equal(c.breachBeforeInvalidation,null,"the sequence is unknown at candle-open precision");
 // An ambiguous pair must not be counted as an ordered breach.
 const technical=report.challenge.find(r=>r.method==="technical")!;
 assert.equal(technical.ambiguousOrderingN,1);
 assert.ok(technical.breachBeforeInvalidationN<technical.breachedN,"the ambiguous case is excluded from the ordered count");
});

test("CHALLENGE: buffering moves the strike out of reach of the same path",()=>{
 const technical=report.challenge.find(r=>r.method==="technical")!;
 const buffered=report.challenge.find(r=>r.method==="buffered")!;
 assert.ok(technical.breachedN>buffered.breachedN,"the farther strike is breached less on identical paths");
 assert.ok(technical.touchShare!>=buffered.touchShare!);
 // Compared strictly within matched pairs, both placements see the identical
 // path; the method-level populations differ only because one extra technical
 // structure has no buffered partner at its width.
 const paired=report.pairs.filter(p=>p.technical.challenge.reason===null&&p.buffered.challenge.reason===null);
 assert.equal(paired.length,report.pairs.length,"every pair is observable on both sides");
 assert.ok(paired.some(p=>p.technical.challenge.breached===true&&p.buffered.challenge.breached===false),
  "at least one pair is breached technically but survives when buffered");
 assert.ok(paired.every(p=>!(p.buffered.challenge.breached===true&&p.technical.challenge.breached===false)),
  "buffering never introduces a breach the technical strike avoided");
});

/* ---------------- timing ---------------- */

test("TIMING: candles before entry or after expiry never challenge the strike",()=>{
 // The path runs from day 1; entry is day 1 and expiry day 8, so every candle
 // in the fixture is in-window. Narrowing the window must shrink the count.
 const late={...dataset,tables:{...dataset.tables,
  candidates:candidates.map(c=>c.candidate_id==="e1-anchor"&&c.execution_scenario==="maker"
   ?{...c,structure_entry_timestamp_utc:D(3)}:c)}} as unknown as AnalysisDataset;
 const narrowed=normalizeShortStrikeStructures(late).find(s=>s.candidateId==="e1-anchor"&&s.executionScenario==="maker")!;
 assert.ok(narrowed.challenge.candlesInWindow<pick("e1-anchor").challenge.candlesInWindow);
 assert.equal(narrowed.challenge.touched,false,"the hour-30 touch is now before entry and cannot challenge the strike");
});

test("TIMING: an invalidation outside the structure's life is never priced as an outcome",()=>{
 // e5's event has no invalidation timestamp at all, yet an invalidation PnL row
 // exists in the bundle. It must not become this structure's outcome.
 const s=pick("e5-anchor");
 assert.equal(s.challenge.invalidatedInWindow,false);
 assert.equal(s.pnlAtInvalidationUsd,null,"the -777 invalidation row is not an outcome this structure lived through");
 assert.equal(s.realizedPnlUsd,300,"it settles instead");
});

test("TIMING: adverse marks outside the structure's life are excluded",()=>{
 // e3-anchor has raw marks at day 0 (pre-entry, -5000) and day 19 (post-expiry,
 // -6000); only the in-window -210 may count.
 assert.equal(pick("e3-anchor").worstAdverseUsd,-210);
});

/* ---------------- economics ---------------- */

test("ECONOMICS: credit sacrificed is technical minus buffered, gross and net",()=>{
 const pair=pairFor("e1");
 // Gross .0100 vs .0060 BTC at a 42,000 index -> 420 vs 252 USD.
 assert.ok(Math.abs(pair.grossCreditSacrificedUsd!-168)<1e-9);
 // Net .0090 vs .0052 -> 378 vs 218.4.
 assert.ok(Math.abs(pair.netCreditSacrificedUsd!-159.6)<1e-9);
 assert.ok(Math.abs(pair.relativeCreditSacrifice!-168/420)<1e-9);
});

test("ECONOMICS: risk reduction is signed so positive always means buffering helped",()=>{
 const pair=pairFor("e1");
 // Worst adverse: technical -300, buffered -140 -> a 160 reduction in loss.
 assert.equal(pair.technical.worstAdverseUsd,-300);
 assert.equal(pair.buffered.worstAdverseUsd,-140);
 assert.equal(pair.worstAdverseReductionUsd,160);
 // MAE before the first profitable mark, same direction.
 assert.equal(pair.maeReductionUsd,160);
});

test("ECONOMICS: the tradeoff is expressed as both cost and protection, not a verdict",()=>{
 const pair=pairFor("e1");
 assert.ok(pair.grossCreditSacrificedUsd!>0,"credit was given up");
 assert.ok(pair.worstAdverseReductionUsd!>0,"and adverse loss fell");
 assert.ok(pair.extraDistanceUsd===1000,"for 1,000 more distance");
 // The report exposes both sides and reaches no conclusion of its own.
 assert.ok(report.methodology.some(line=>/does not choose a strike rule/i.test(line)));
});

test("ECONOMICS: paired deltas exist for every requested dimension",()=>{
 const labels=pairFor("e2").deltas.map(d=>d.label);
 for(const expected of ["Δ entry credit (gross)","Δ entry credit (net)","Δ worst adverse","Δ MAE before profit",
  "Δ PnL at invalidation","Δ settlement / tail PnL","Δ realized PnL"])
  assert.ok(labels.includes(expected),`${expected} must be a paired delta`);
 // e2 was invalidated: technical -420 vs buffered -260 -> +160 for buffering.
 assert.equal(pairFor("e2").deltas.find(d=>d.label==="Δ PnL at invalidation")!.value,160);
});

test("ECONOMICS: modelled marks never fill an adverse figure",()=>{
 // e2-anchor's only valuation is on the iv_normalized track.
 const s=pick("e2-anchor");
 assert.equal(s.worstAdverseUsd,null);
 assert.equal(s.adverse.status,"raw_evaluation_not_attempted");
 assert.match(s.adverse.reason!,/raw-VWAP/);
});

/* ---------------- conditional PnL ---------------- */

test("CONDITIONAL: PnL is grouped by what the structure actually lived through",()=>{
 const breached=report.conditionalPnl.find(r=>r.bucket==="breached")!;
 assert.ok(breached.technicalN>0,"e3 and e4 breached under the technical strike");
 const neverTouched=report.conditionalPnl.find(r=>r.bucket==="never_touched")!;
 assert.ok(neverTouched.technicalN>0,"e2 was never touched even though it invalidated");
 const touched=report.conditionalPnl.find(r=>r.bucket==="touched_not_breached")!;
 assert.ok(touched.technicalN>0,"e1 was touched but not breached");
});

test("CONDITIONAL: the paired delta only uses pairs where BOTH sides fell in the bucket",()=>{
 // e1: technical touched, buffered untouched -> the pair is not a touched pair.
 const touched=report.conditionalPnl.find(r=>r.bucket==="touched_not_breached")!;
 assert.equal(touched.pairedN,0,"a touched technical is never paired against an untouched buffered");
 assert.equal(touched.medianPairedPnlDeltaUsd,null,"so no paired delta is fabricated");
 assert.ok(touched.technicalN>0&&touched.bufferedN===0,"the unpaired population is still reported separately");
});

test("REFERENCE: default routing retains null-scenario Reference structures and uses fair-value outcomes and path",()=>{
 const referenceCandidate=(method:"anchor"|"buffered")=>({
  ...candidate("e1",method,"maker"),candidate_id:`reference-${method}`,
  reference_valuation:{status:"valued",entrySnapshot:{valuationTimestamp:D(1),targetIndex:42000,grossSpreadBtc:method==="anchor"?.01:.006,netOpeningCashFlowBtc:method==="anchor"?.009:.005},
   valuationPathSnapshot:[{timestamp:D(2),estimatedNetPnlUsd:method==="anchor"?-300:-120},{timestamp:D(3),estimatedNetPnlUsd:80}],
   outcomeSnapshots:[{label:"vpoc",status:"priced",trigger_status:"reached",trigger_timestamp_utc:D(3),estimatedNetPnlUsd:method==="anchor"?300:180},{label:"settlement",status:"priced",trigger_status:"reached",estimatedNetPnlUsd:method==="anchor"?20:10}]},
 });
 const referenceDataset={...dataset,tables:{...dataset.tables,candidates:[referenceCandidate("anchor"),referenceCandidate("buffered")],outcomes:[],valuations:[]}} as unknown as AnalysisDataset;
 const r=buildShortStrikeReport(referenceDataset);
 assert.equal(r.scenario,"reference");
 assert.equal(r.structures.length,2);
 assert.equal(r.pairs.length,1);
 assert.equal(r.pairs[0]!.technical.executionScenario,null);
 assert.equal(r.pairs[0]!.technical.realizedPnlUsd,300,"post-entry VPOC is the realized outcome, not settlement");
 assert.equal(r.pairs[0]!.worstAdverseReductionUsd,180,"Reference path is sufficient without raw tape");
 assert.equal(r.robustness!.maker.summary.medianWorstAdverseReductionUsd,null,"Reference marks do not backfill observed maker evidence");
});

/* ---------------- summary and missing data ---------------- */

test("SUMMARY: matched coverage and medians are reported over pairs, not over all structures",()=>{
 const s=report.summary;
 assert.equal(s.matchedPairs,report.pairs.length);
 assert.equal(s.matchedEvents,5,"e1 through e5 each contribute one 1000-wide pair");
 assert.ok(s.technicalStructures>s.matchedPairs,"the extra 2000-wide technical structure is counted but unpaired");
 assert.equal(s.unmatchedTechnical,1);
 assert.equal(s.medianExtraDistanceUsd,1000);
 assert.ok(s.breachRateDifference!<0,"buffering breached less often across matched pairs");
});

test("MISSING DATA: a not-evaluated scenario yields Unavailable economics, never zero",()=>{
 const notEvaluated={...dataset,tables:{...dataset.tables,
  candidates:candidates.map(c=>c.candidate_id==="e1-buffered"&&c.execution_scenario==="maker"
   ?{...c,execution_scenario_status:"not_evaluated",execution_scenario_reason:"No maker-consistent tape print.",
     gross_credit_debit_native:null,net_opening_cash_flow_native:null}:c)}} as unknown as AnalysisDataset;
 const r=buildShortStrikeReport(notEvaluated,"maker");
 const pair=r.pairs.find(p=>p.eventId==="e1"&&p.widthUsd===1000)!;
 assert.equal(pair.economicsComparable,false);
 assert.equal(pair.grossCreditSacrificedUsd,null,"never 0");
 assert.equal(pair.worstAdverseReductionUsd,null);
 // Geometry is structural and survives a not-evaluated scenario.
 assert.equal(pair.extraDistanceUsd,1000);
 assert.equal(r.summary.medianGrossCreditSacrificedUsd!==null,true,"other pairs still contribute");
});

test("MISSING DATA: a missing underlying path leaves the challenge unobservable, not untouched",()=>{
 const noPath={...dataset,tables:{...dataset.tables,underlying_path:[]}} as unknown as AnalysisDataset;
 const s=normalizeShortStrikeStructures(noPath).find(x=>x.candidateId==="e1-anchor"&&x.executionScenario==="maker")!;
 assert.equal(s.challenge.touched,null,"absent evidence is not a false");
 assert.equal(s.challenge.breached,null);
 assert.match(s.challenge.reason!,/no underlying path/i);
 const r=buildShortStrikeReport(noPath,"maker");
 assert.equal(r.challenge.find(x=>x.method==="technical")!.observableN,0,"unobservable rows leave the denominator");
 assert.equal(r.challenge.find(x=>x.method==="technical")!.breachShare,null,"and no share is invented");
});

test("MISSING DATA: an empty bundle produces no pairs and no fabricated statistics",()=>{
 const empty={...dataset,tables:{events:[],candidates:[],outcomes:[],valuations:[],underlying_path:[],availability:[],margin_scenarios:[]}} as unknown as AnalysisDataset;
 const r=buildShortStrikeReport(empty,"maker");
 assert.equal(r.pairs.length,0);
 assert.equal(r.summary.matchedPairs,0);
 assert.equal(r.summary.medianGrossCreditSacrificedUsd,null);
 assert.equal(r.summary.breachRateDifference,null);
});

test("SCOPE: width is held constant inside pairs and is never the reported variable",()=>{
 for(const pair of report.pairs)assert.equal(pair.technical.widthUsd,pair.buffered.widthUsd);
 assert.ok(report.methodology.some(line=>/analyses short-strike PLACEMENT only/i.test(line)));
});
