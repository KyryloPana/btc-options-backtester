import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildHorizonAvailability,buildHorizonFamilies,normalizeDteCandidates} from "../app/lib/duration-dte/normalize.ts";
import {buildDurationDteReport} from "../app/lib/duration-dte/report.ts";

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const ENTRY=D(1);

/**
 * Seven canonical-shaped events covering every reconciling state:
 *  e1 vpoc_first @ +3d      -- horizon 7 (dte 5, covered) AND horizon 14 (dte 2, NOT covered)
 *  e2 invalidation_first @ +1d -- horizon 7 (dte 10, covered)
 *  e3 unresolved (censored @ +5d) -- horizon 30 (dte 20, no-resolution bucket via censoring)
 *  e4 ambiguous @ +2d       -- horizon 7 (dte 8, covered, ambiguous bucket)
 *  e5 vpoc_first @ +4d, actual DTE missing on its only candidate -- horizon 14
 *  e6 ineligible for Underlying Resolution (missing entry_timestamp_utc) -- horizon 7
 *  e7 vpoc_first @ +1d, generated-but-never-priced candidate only (no candidates.jsonl row)
 */
const events=[
 {event_id:"e1",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(4),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved",entry_price:100,range_low:90,range_high:110,vpoc_distance:5},
 {event_id:"e2",direction:"short",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:D(2),
  observation_end_timestamp_utc:D(20),sequence_status:"invalidation_first",censoring_status:"resolved",entry_price:200,range_low:180,range_high:220,vpoc_distance:-10},
 {event_id:"e3",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(6),sequence_status:"unresolved",censoring_status:"right_censored",entry_price:100,range_low:90,range_high:110,vpoc_distance:8},
 {event_id:"e4",direction:"short",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(3),invalidation_decision_timestamp_utc:D(3),
  observation_end_timestamp_utc:D(20),sequence_status:"ambiguous",censoring_status:"resolved",entry_price:100,range_low:95,range_high:105,vpoc_distance:2},
 {event_id:"e5",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(5),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved",entry_price:100,range_low:90,range_high:110,vpoc_distance:4},
 {event_id:"e6",direction:"long",entry_timestamp_utc:null,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"unresolved",censoring_status:"right_censored",entry_price:100,range_low:90,range_high:110,vpoc_distance:5},
 {event_id:"e7",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(2),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved",entry_price:100,range_low:90,range_high:110,vpoc_distance:3},
];

const candidates=[
 {event_id:"e1",candidate_id:"c1a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(6),
  actual_dte_days:5,entry_quality:"green",execution_mode:"taker",spread_synchronization_minutes:0.4,structure_type:"bull_put_credit"},
 {event_id:"e1",candidate_id:"c1b",target_horizon_days:14,eligible_dte_range:{min:11,max:18},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(3),
  actual_dte_days:2,entry_quality:"yellow",execution_mode:"taker",spread_synchronization_minutes:1.1,structure_type:"bull_put_credit"},
 {event_id:"e2",candidate_id:"c2a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(11),
  actual_dte_days:10,entry_quality:"yellow",execution_mode:"taker",spread_synchronization_minutes:0.6,structure_type:"bear_call_credit"},
 {event_id:"e3",candidate_id:"c3a",target_horizon_days:30,eligible_dte_range:{min:24,max:38},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(21),
  actual_dte_days:20,entry_quality:"red",execution_mode:"maker",spread_synchronization_minutes:2.5,structure_type:"bull_put_credit"},
 {event_id:"e4",candidate_id:"c4a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(9),
  actual_dte_days:8,entry_quality:"green",execution_mode:"maker",spread_synchronization_minutes:0.3,structure_type:"bear_call_credit"},
 {event_id:"e5",candidate_id:"c5a",target_horizon_days:14,eligible_dte_range:{min:11,max:18},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:null,
  actual_dte_days:null,entry_quality:"green",execution_mode:"taker",spread_synchronization_minutes:0.8,structure_type:"bull_put_credit"},
 {event_id:"e6",candidate_id:"c6a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:null,expiry_timestamp_utc:D(8),
  actual_dte_days:7,entry_quality:"green",execution_mode:"taker",spread_synchronization_minutes:0.2,structure_type:"bull_put_credit"},
];

const availability=[
 {event_id:"e1",candidate_id:"c1a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e1",candidate_id:"c1b",target_horizon_days:14,is_selected:true,status:"priced",entry_quality:"yellow"},
 {event_id:"e2",candidate_id:"c2a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"yellow"},
 {event_id:"e3",candidate_id:"c3a",target_horizon_days:30,is_selected:true,status:"priced",entry_quality:"red"},
 {event_id:"e4",candidate_id:"c4a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e5",candidate_id:"c5a",target_horizon_days:14,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e6",candidate_id:"c6a",target_horizon_days:7,is_selected:false,status:"unavailable",entry_quality:null},
 {event_id:"e7",candidate_id:"c7x",target_horizon_days:7,is_selected:false,status:"unavailable",entry_quality:null},
];

const outcomes=[
 {event_id:"e1",candidate_id:"c1a",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(4),net_pnl_usd:500},
 {event_id:"e1",candidate_id:"c1a",outcome_type:"credit_capture_50",status:"priced",trigger_timestamp_utc:D(2)},
 {event_id:"e1",candidate_id:"c1a",outcome_type:"credit_capture_70",status:"not_reached",trigger_timestamp_utc:null},
 {event_id:"e2",candidate_id:"c2a",outcome_type:"invalidation",status:"priced",trigger_timestamp_utc:D(2),net_pnl_usd:-300},
 {event_id:"e3",candidate_id:"c3a",outcome_type:"settlement",status:"priced",trigger_timestamp_utc:D(21),net_pnl_usd:50},
 {event_id:"e4",candidate_id:"c4a",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(3),net_pnl_usd:200},
 {event_id:"e4",candidate_id:"c4a",outcome_type:"invalidation",status:"priced",trigger_timestamp_utc:D(3),net_pnl_usd:-200},
 {event_id:"e5",candidate_id:"c5a",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(5),net_pnl_usd:100},
];

const valuations=[
 {event_id:"e1",candidate_id:"c1a",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-150},
 {event_id:"e1",candidate_id:"c1a",timestamp_utc:D(1,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-50},
 {event_id:"e1",candidate_id:"c1a",timestamp_utc:D(4,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-999},
 {event_id:"e1",candidate_id:"c1a",timestamp_utc:D(1,6),pricing_track:"iv_normalized",valuation_status:"priced",net_pnl_usd:-9999},
];

const margin_scenarios=[
 {event_id:"e1",candidate_id:"c1a",margin_status:"available",maximum_loss_usd:1000},
 {event_id:"e4",candidate_id:"c4a",margin_status:"available",maximum_loss_usd:1000},
];

const dataset={filename:"f.zip",schemaVersion:"2.1.0",migratedFrom:null,run:{dataset_id:"ds",bundle_id:"b"},
 tables:{events,candidates,availability,outcomes,valuations,margin_scenarios},
 counts:{selectedCandidates:candidates.length,denominator:availability.length},venues:["deribit"],sourceRuns:[],
 eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;

const all=normalizeDteCandidates(dataset);
const byId=(id:string)=>all.find(c=>c.candidateId===id)!;
const report=buildDurationDteReport(dataset);
const overviewFor=(nominal:number)=>report.overview.find(r=>r.horizon.nominalDays===nominal)!;
const outcomeRowFor=(nominal:number)=>report.outcomeBeforeExpiry.find(r=>r.horizon.nominalDays===nominal)!;

test("A: actual DTE is read per candidate; horizon grouping never overwrites it",()=>{
 assert.equal(byId("c1a").actualDteDays,5);
 assert.equal(byId("c1b").actualDteDays,2);
 assert.equal(byId("c2a").actualDteDays,10);
 // Same nominal horizon (7), three different actual DTEs -- the median must
 // reflect all three, not collapse to one representative value.
 const h7=overviewFor(7)!;
 assert.equal(h7.actualDte!.n,3);
 assert.equal(h7.actualDte!.median,8);
 assert.equal(h7.actualDte!.min,5);
 assert.equal(h7.actualDte!.max,10);
});

test("A: a missing actual DTE stays null, never a fabricated horizon average",()=>{
 assert.equal(byId("c5a").actualDteDays,null);
 assert.equal(byId("c5a").resolvedBeforeExpiry,null,"not determinable without a DTE");
 assert.equal(byId("c5a").outcomeBeforeExpiry,null);
});

test("B: an ineligible underlying event excludes its candidate from every denominator",()=>{
 const c6=byId("c6a");
 assert.notEqual(c6.ineligibilityReason,null);
 assert.equal(report.excludedIneligible,1);
 const h7=overviewFor(7)!;
 assert.equal(h7.selectedN,3,"c6a is excluded, leaving c1a/c2a/c4a");
});

test("B: availability funnel counts distinct events, not candidate rows, and separates generated from priced",()=>{
 const h7=report.availability.find(a=>a.nominalDays===7)!;
 assert.equal(h7.totalEvents,7,"all seven events in the bundle");
 assert.equal(h7.candidatesGenerated,5,"e1,e2,e4,e6,e7 attempted a horizon-7 candidate");
 assert.equal(h7.priced,3,"only e1,e2,e4 priced per availability.jsonl; e6 and e7 stayed unavailable");
 // "selected"/"taker executable" describe STRUCTURE availability from candidates.jsonl,
 // independent of whether the underlying event later turns out eligible for
 // time-to-event analysis -- c6a's structure was genuinely priced and selected
 // even though its underlying event is missing an entry timestamp. That
 // eligibility gate applies to the resolution-coverage metrics, not this funnel.
 assert.equal(h7.selected,4,"c1a, c2a, c4a and c6a all have a candidates.jsonl row at horizon 7");
 assert.equal(h7.takerExecutable,3,"c1a, c2a and c6a selected taker");
 assert.equal(h7.makerOpportunity,1,"c4a selected maker");
 assert.equal(h7.entryQuality.green,2);
 assert.equal(h7.entryQuality.yellow,1);
});

test("B: structure-level availability and underlying-event eligibility are two separate gates",()=>{
 // c6a is counted in the funnel above (its structure was selected/executable)
 // but excluded from every resolution-coverage denominator, because its
 // underlying event cannot support time-to-event analysis.
 const h7=overviewFor(7)!;
 assert.equal(h7.selectedN,3,"c6a is excluded here even though it is counted in the funnel");
});

test("C: resolution coverage compares T_resolution against THIS candidate's actual DTE, independently per horizon",()=>{
 // e1 resolves at +3d: covered at horizon 7 (dte 5) but NOT at horizon 14 (dte 2).
 assert.equal(byId("c1a").resolvedBeforeExpiry,true);
 assert.equal(byId("c1a").outcomeBeforeExpiry,"vpoc_before_expiry");
 assert.equal(byId("c1b").resolvedBeforeExpiry,false);
 assert.equal(byId("c1b").outcomeBeforeExpiry,"no_resolution_before_expiry");
 const h7=overviewFor(7)!,h14=overviewFor(14)!;
 assert.equal(h7.resolutionCoverageShare,1,"c1a, c2a, c4a all covered at horizon 7");
 assert.ok(h14.resolutionCoverageShare!<1,"c1b is not covered at horizon 14");
});

test("C: an unresolved (censored) candidate is a determinate no-resolution-before-expiry, not a failure",()=>{
 const c3=byId("c3a");
 assert.equal(c3.underlyingOutcome,"unresolved");
 assert.equal(c3.resolvedBeforeExpiry,false);
 assert.equal(c3.outcomeBeforeExpiry,"no_resolution_before_expiry");
 const h30=outcomeRowFor(30)!;
 assert.equal(h30.counts.no_resolution_before_expiry,1);
 assert.equal(h30.counts.vpoc_before_expiry+h30.counts.invalidation_before_expiry+h30.counts.ambiguous_before_expiry,0);
});

test("C: ambiguous first resolution gets its own bucket, never folded into VPOC or invalidation",()=>{
 assert.equal(byId("c4a").outcomeBeforeExpiry,"ambiguous_before_expiry");
 const h7=outcomeRowFor(7)!;
 assert.equal(h7.counts.ambiguous_before_expiry,1);
});

test("RECONCILIATION: outcome-before-expiry buckets sum to the determinate population at every horizon",()=>{
 for(const row of report.outcomeBeforeExpiry){
  const sum=row.counts.vpoc_before_expiry+row.counts.invalidation_before_expiry+row.counts.ambiguous_before_expiry+row.counts.no_resolution_before_expiry;
  assert.equal(sum,row.determinateN,`${row.horizon.label} must reconcile`);
 }
 const h14=outcomeRowFor(14)!;
 assert.equal(h14.determinateN,1,"only c1b; c5a has no determinable DTE");
 assert.equal(h14.notDeterminableN,1,"c5a");
});

test("D: DTE buffer is signed and retains the negative (expiry-before-resolution) tail",()=>{
 assert.equal(byId("c1a").dteBufferDays,2,"5 - 3");
 assert.equal(byId("c1b").dteBufferDays,-1,"2 - 3, expiry occurred before resolution");
 assert.equal(byId("c5a").dteBufferDays,null,"not computable without an actual DTE");
 assert.equal(byId("c3a").dteBufferDays,null,"unresolved has no first-resolution time to buffer against");
});

test("E: credit capture distinguishes reached, not-reached, and structurally absent",()=>{
 const c1a=byId("c1a");
 assert.equal(c1a.capture50!.reached,true);
 assert.equal(c1a.capture50!.timeToCaptureDays,1,"entry to +1d trigger");
 assert.equal(c1a.capture50!.beforeVpoc,true,"captured at +1d, VPOC at +3d");
 assert.equal(c1a.capture70!.reached,false);
 assert.equal(c1a.capture70!.timeToCaptureDays,null,"never zero for a threshold not reached");
 assert.equal(byId("c2a").capture50,null,"no capture row at all -- structurally absent, distinct from not-reached");
});

test("E: before-VPOC/before-invalidation is null when the event never touched that endpoint",()=>{
 // c1a's underlying event never had an invalidation trigger.
 assert.equal(byId("c1a").capture50!.beforeInvalidation,null);
});

test("F: PnL and worst-adverse are read only from priced canonical evidence, never fabricated",()=>{
 assert.equal(byId("c1a").pnlAtVpocUsd,500);
 assert.equal(byId("c2a").pnlAtInvalidationUsd,-300);
 assert.equal(byId("c3a").pnlAtSettlementUsd,50);
 assert.equal(byId("c5a").pnlAtInvalidationUsd,null,"no invalidation outcome row for c5a");
});

test("F: worst-adverse excludes post-resolution valuations and the modeled track",()=>{
 // c1a resolves at +3d. The -999 mark sits at +4.5d (after resolution) and the
 // -9999 mark is on the iv_normalized track; neither may win.
 assert.equal(byId("c1a").worstAdverseUsd,-150);
});

test("F: ambiguous resolution never receives a single realized PnL or capital-day return",()=>{
 const c4=byId("c4a");
 assert.equal(c4.pnlAtVpocUsd,200,"raw per-endpoint PnL is still readable");
 assert.equal(c4.pnlAtInvalidationUsd,-200);
 assert.equal(c4.capitalDayReturn,null,"ambiguous has no single realized outcome to divide by capital-days");
 const bucketed=report.pnlByOutcome.flatMap(r=>r.buckets).some(b=>b.pnlUsd.includes(200)||b.pnlUsd.includes(-200));
 assert.equal(bucketed,false,"c4a must not appear in the VPOC-first or invalidation-first PnL buckets");
});

test("G: capital-day return is Unavailable per-candidate unless a canonical margin scenario is genuinely available",()=>{
 assert.equal(byId("c2a").requiredCapitalUsd,null,"e2/c2a has no margin_scenarios row at all");
 assert.equal(byId("c2a").capitalDayReturn,null);
 assert.equal(byId("c1a").requiredCapitalUsd,1000);
 assert.ok(Math.abs(byId("c1a").capitalDayReturn!-500/(1000*3))<1e-9,"500 pnl / (1000 usd * 3 days)");
});

test("G: the capital-time summary aggregates only candidates with a genuinely usable return",()=>{
 // c1a is the only candidate with BOTH an available margin scenario and a
 // single realized outcome to divide by it -- c4a has available margin too,
 // but its ambiguous resolution has no realized PnL, so it must not appear.
 assert.equal(report.capitalTime.available,true);
 assert.equal(report.capitalTime.points.length,1);
 assert.equal(report.capitalTime.points[0]!.actualDteDays,5);
 assert.equal(report.capitalTime.medianHoldingDays,3);
 assert.ok(Math.abs(report.capitalTime.medianCapitalDayReturn!-500/(1000*3))<1e-9);
});

test("G: capital-time is honestly Unavailable when no candidate anywhere has a usable return",()=>{
 const noMargin={...dataset,tables:{...dataset.tables,margin_scenarios:[]}} as unknown as AnalysisDataset;
 const r=buildDurationDteReport(noMargin);
 assert.equal(r.capitalTime.available,false);
 assert.match(r.capitalTime.reason!,/margin/i);
 assert.equal(r.capitalTime.medianCapitalDayReturn,null);
});

test("J: rebuilding the report from the same dataset is deterministic regardless of any UI-only slicing",()=>{
 const rebuilt=buildDurationDteReport(dataset);
 assert.deepEqual(rebuilt.overview,report.overview);
 assert.deepEqual(rebuilt.outcomeBeforeExpiry,report.outcomeBeforeExpiry);
 assert.deepEqual(rebuilt.headline,report.headline);
 const page1=report.candidates.slice(0,2),page2=report.candidates.slice(2,4);
 assert.notDeepEqual(page1,page2);
});

test("data sufficiency: horizon families are read from canonical data, never invented",()=>{
 const families=buildHorizonFamilies(dataset);
 assert.deepEqual(families.map(f=>f.nominalDays),[7,14,30]);
 assert.deepEqual(families[0]!.eligibleDteRange,{min:5,max:10});
});

test("data sufficiency: an empty bundle produces zero candidates and no fabricated stats",()=>{
 const empty={...dataset,tables:{events:[],candidates:[],availability:[],outcomes:[],valuations:[],margin_scenarios:[]}} as unknown as AnalysisDataset;
 const r=buildDurationDteReport(empty);
 assert.equal(r.candidates.length,0);
 assert.equal(r.horizons.length,0);
 assert.equal(r.headline.medianActualDteDays,null);
 assert.equal(r.capitalTime.available,false);
});

test("normalize: buildHorizonAvailability is independent of buildDurationDteReport's own aggregation",()=>{
 const families=buildHorizonFamilies(dataset),availabilityDirect=buildHorizonAvailability(dataset,families);
 assert.deepEqual(availabilityDirect,report.availability);
});
