import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {buildHorizonAvailability,buildHorizonFamilies,normalizeDteCandidates} from "../app/lib/duration-dte/normalize.ts";
import {buildDurationDteReport} from "../app/lib/duration-dte/report.ts";
import {buildEntryDelayReport} from "../app/lib/duration-dte/entry-delay.ts";
import {share} from "../app/lib/duration-dte/statistics.ts";

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const ENTRY=D(1);

/**
 * Canonical-shaped events covering every reconciling state:
 *  e1 vpoc_first @ +3d      -- horizon 7 (dte 5, covered) AND horizon 14 (dte 2, NOT covered)
 *  e2 invalidation_first @ +1d -- horizon 7 (dte 10, covered), evaluated under BOTH scenarios
 *  e3 unresolved (censored @ +5d) -- horizon 30 (dte 20, no-resolution via censoring)
 *  e4 ambiguous @ +2d       -- horizon 7, TWO width variants (c4a, c4b) of one event
 *  e5 vpoc_first @ +4d, actual DTE missing on its only candidate -- horizon 14
 *  e6 ineligible for Underlying Resolution (missing entry_timestamp_utc) -- horizon 7
 *  e7 vpoc_first @ +1d, generated-but-never-priced candidate only (no candidates.jsonl row)
 *  e8 vpoc_first @ +1d, but its structure was entered on day 5 -- PRE-ENTRY VPOC
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
 {event_id:"e8",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(2),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(20),sequence_status:"vpoc_first",censoring_status:"resolved",entry_price:100,range_low:90,range_high:110,vpoc_distance:3},
];

/** Structural identity shared by a structure's maker and taker rows. */
const structural=(over:Record<string,unknown>)=>({strike_method:"delta_15",option_type:"P",structure_type:"bull_put_credit",actual_strikes:{short:100,long:99,width:1000},...over});

const candidates=[
 // c1a and c1b are the SAME structural variant of e1 at two horizons: the only
 // matched pair a controlled DTE comparison may use in this fixture.
 structural({event_id:"e1",candidate_id:"c1a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(6),
  actual_dte_days:5,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.4}),
 // The maker scenario of the SAME structure was assessed and found unsupported.
 structural({event_id:"e1",candidate_id:"c1a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:null,expiry_timestamp_utc:D(6),
  actual_dte_days:null,entry_quality:null,execution_scenario:"maker",execution_scenario_status:"not_evaluated",
  execution_scenario_reason:"No maker-consistent tape print inside the evidence window.",spread_synchronization_minutes:null}),
 structural({event_id:"e1",candidate_id:"c1b",target_horizon_days:14,eligible_dte_range:{min:11,max:18},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(3),
  actual_dte_days:2,entry_quality:"yellow",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:1.1}),
 // c2a is genuinely evaluated under BOTH scenarios: the only matched execution pair.
 structural({event_id:"e2",candidate_id:"c2a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(11),
  actual_dte_days:10,entry_quality:"yellow",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.6,structure_type:"bear_call_credit",option_type:"C"}),
 structural({event_id:"e2",candidate_id:"c2a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(11),
  actual_dte_days:10,entry_quality:"green",execution_scenario:"maker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.2,structure_type:"bear_call_credit",option_type:"C"}),
 structural({event_id:"e3",candidate_id:"c3a",target_horizon_days:30,eligible_dte_range:{min:24,max:38},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(21),
  actual_dte_days:20,entry_quality:"red",execution_scenario:"maker",execution_scenario_status:"evaluated",spread_synchronization_minutes:2.5}),
 structural({event_id:"e3",candidate_id:"c3a",target_horizon_days:30,eligible_dte_range:{min:24,max:38},structure_entry_timestamp_utc:null,expiry_timestamp_utc:D(21),
  actual_dte_days:null,entry_quality:null,execution_scenario:"taker",execution_scenario_status:"not_evaluated",
  execution_scenario_reason:"No taker-consistent tape print inside the evidence window.",spread_synchronization_minutes:null}),
 // c4a and c4b are TWO WIDTH VARIANTS of one event at one horizon.
 structural({event_id:"e4",candidate_id:"c4a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(9),
  actual_dte_days:8,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.3,structure_type:"bear_call_credit",option_type:"C"}),
 structural({event_id:"e4",candidate_id:"c4b",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:D(9),
  actual_dte_days:8,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.5,structure_type:"bear_call_credit",option_type:"C",
  actual_strikes:{short:100,long:97,width:3000}}),
 structural({event_id:"e5",candidate_id:"c5a",target_horizon_days:14,eligible_dte_range:{min:11,max:18},structure_entry_timestamp_utc:ENTRY,expiry_timestamp_utc:null,
  actual_dte_days:null,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.8}),
 structural({event_id:"e6",candidate_id:"c6a",target_horizon_days:7,eligible_dte_range:{min:5,max:10},structure_entry_timestamp_utc:null,expiry_timestamp_utc:D(8),
  actual_dte_days:7,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.2}),
 // c8a was entered on day 5, four days AFTER its event reached VPOC on day 2.
 structural({event_id:"e8",candidate_id:"c8a",target_horizon_days:14,eligible_dte_range:{min:11,max:18},structure_entry_timestamp_utc:D(5),expiry_timestamp_utc:D(12),
  actual_dte_days:7,entry_quality:"green",execution_scenario:"taker",execution_scenario_status:"evaluated",spread_synchronization_minutes:0.9}),
];

const availability=[
 {event_id:"e1",candidate_id:"c1a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e1",candidate_id:"c1b",target_horizon_days:14,is_selected:true,status:"priced",entry_quality:"yellow"},
 {event_id:"e2",candidate_id:"c2a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"yellow"},
 {event_id:"e3",candidate_id:"c3a",target_horizon_days:30,is_selected:true,status:"priced",entry_quality:"red"},
 {event_id:"e4",candidate_id:"c4a",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e4",candidate_id:"c4b",target_horizon_days:7,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e5",candidate_id:"c5a",target_horizon_days:14,is_selected:true,status:"priced",entry_quality:"green"},
 {event_id:"e6",candidate_id:"c6a",target_horizon_days:7,is_selected:false,status:"unavailable",entry_quality:null},
 {event_id:"e7",candidate_id:"c7x",target_horizon_days:7,is_selected:false,status:"unavailable",entry_quality:null},
 {event_id:"e8",candidate_id:"c8a",target_horizon_days:14,is_selected:true,status:"priced",entry_quality:"green"},
];

const outcomes=[
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(4),net_pnl_usd:500},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",outcome_type:"credit_capture_50",status:"priced",trigger_timestamp_utc:D(2)},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",outcome_type:"credit_capture_70",status:"not_reached",trigger_timestamp_utc:null},
 {event_id:"e1",candidate_id:"c1b",execution_scenario:"taker",outcome_type:"settlement",status:"priced",trigger_timestamp_utc:D(3),net_pnl_usd:-100},
 {event_id:"e2",candidate_id:"c2a",execution_scenario:"taker",outcome_type:"invalidation",status:"priced",trigger_timestamp_utc:D(2),net_pnl_usd:-300},
 {event_id:"e2",candidate_id:"c2a",execution_scenario:"maker",outcome_type:"invalidation",status:"priced",trigger_timestamp_utc:D(2),net_pnl_usd:-280},
 {event_id:"e3",candidate_id:"c3a",execution_scenario:"maker",outcome_type:"settlement",status:"priced",trigger_timestamp_utc:D(21),net_pnl_usd:50},
 {event_id:"e4",candidate_id:"c4a",execution_scenario:"taker",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(3),net_pnl_usd:200},
 {event_id:"e4",candidate_id:"c4a",execution_scenario:"taker",outcome_type:"invalidation",status:"priced",trigger_timestamp_utc:D(3),net_pnl_usd:-200},
 {event_id:"e5",candidate_id:"c5a",execution_scenario:"taker",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(5),net_pnl_usd:100},
 // c8a's VPOC outcome exists in the bundle but predates the structure entirely.
 {event_id:"e8",candidate_id:"c8a",execution_scenario:"taker",outcome_type:"vpoc",status:"priced",trigger_timestamp_utc:D(2),net_pnl_usd:400},
 {event_id:"e8",candidate_id:"c8a",execution_scenario:"taker",outcome_type:"settlement",status:"priced",trigger_timestamp_utc:D(12),net_pnl_usd:60},
];

const valuations=[
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",timestamp_utc:D(2),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-150},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",timestamp_utc:D(1,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-50},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",timestamp_utc:D(3,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:20},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",timestamp_utc:D(4,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-999},
 {event_id:"e1",candidate_id:"c1a",execution_scenario:"taker",timestamp_utc:D(1,6),pricing_track:"iv_normalized",valuation_status:"priced",net_pnl_usd:-9999},
 // Maker and taker marks for the SAME structure must never populate each other.
 {event_id:"e2",candidate_id:"c2a",execution_scenario:"maker",timestamp_utc:D(1,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-80},
 {event_id:"e2",candidate_id:"c2a",execution_scenario:"taker",timestamp_utc:D(1,12),pricing_track:"raw_vwap",valuation_status:"priced",net_pnl_usd:-120},
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
/** A structure's rows differ only by scenario, so tests name the pair explicitly. */
const row=(id:string,scenario:"maker"|"taker")=>all.find(c=>c.candidateId===id&&c.executionScenario===scenario)!;
const byId=(id:string)=>all.find(c=>c.candidateId===id&&c.executionScenarioStatus==="evaluated")??all.find(c=>c.candidateId===id)!;
const report=buildDurationDteReport(dataset,"taker");
const makerReport=buildDurationDteReport(dataset,"maker");
const overviewFor=(nominal:number)=>report.overview.find(r=>r.horizon.nominalDays===nominal)!;
const outcomeRowFor=(nominal:number)=>report.outcomeBeforeExpiry.find(r=>r.horizon.nominalDays===nominal)!;
const availabilityFor=(nominal:number)=>report.availability.find(a=>a.nominalDays===nominal)!;

test("A: actual DTE is read per candidate; horizon grouping never overwrites it",()=>{
 assert.equal(byId("c1a").actualDteDays,5);
 assert.equal(byId("c1b").actualDteDays,2);
 assert.equal(byId("c2a").actualDteDays,10);
 // Same nominal horizon (7), several actual DTEs -- the summary must reflect
 // all of them, not collapse to one representative value.
 const h7=overviewFor(7);
 assert.equal(h7.actualDte!.n,4,"c1a, c2a and both width variants of e4");
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
 assert.notEqual(byId("c6a").ineligibilityReason,null);
 assert.equal(report.excludedIneligible,1);
 assert.equal(overviewFor(7).structuresN,4,"c6a excluded, leaving c1a/c2a/c4a/c4b");
});

test("GRANULARITY: several width variants of one event never multiply the MR observation",()=>{
 const h7=availabilityFor(7);
 assert.equal(h7.totalEvents,8,"all eight events in the bundle");
 // e4 generated TWO horizon-7 structures (c4a and c4b) but is still one MR
 // opportunity: the funnel counts distinct events, never candidate rows.
 assert.equal(h7.eligibleEvents,5,"e1,e2,e4,e6,e7 attempted a horizon-7 candidate");
 assert.equal(h7.candidatesGenerated,5,"e4's two width variants stay one event-level observation");
 assert.equal(h7.priced,3,"only e1,e2,e4 priced per availability.jsonl; e6 and e7 stayed unavailable");
 assert.equal(h7.selected,4,"e1,e2,e4,e6 each have at least one candidates.jsonl row at horizon 7");
 // The structure count does grow with widths -- the point is that the EVENT-level
 // availability figure above does not.
 assert.equal(overviewFor(7).structuresN,4);
 assert.equal(overviewFor(7).eventsN,3,"c1a/c2a/c4a/c4b span only e1, e2 and e4");
 assert.equal(h7.entryQuality.green,2);
 assert.equal(h7.entryQuality.yellow,1);
});

test("B: structure-level availability and underlying-event eligibility are two separate gates",()=>{
 // c6a is counted in the funnel (its structure was selected and taker-evaluated)
 // but excluded from every resolution-coverage denominator, because its
 // underlying event cannot support time-to-event analysis.
 assert.equal(availabilityFor(7).taker.events,4,"e1,e2,e4,e6 all have an evaluated taker row at horizon 7");
 assert.equal(overviewFor(7).structuresN,4,"c6a is excluded here even though it is counted in the funnel");
});

test("C: resolution coverage compares the post-entry resolution against THIS candidate's expiry",()=>{
 // e1 resolves at +3d: covered at horizon 7 (expiry +5d) but NOT at horizon 14 (expiry +2d).
 assert.equal(byId("c1a").resolvedBeforeExpiry,true);
 assert.equal(byId("c1a").outcomeBeforeExpiry,"vpoc_before_expiry");
 assert.equal(byId("c1b").resolvedBeforeExpiry,false);
 assert.equal(byId("c1b").outcomeBeforeExpiry,"no_resolution_before_expiry");
 assert.equal(overviewFor(7).resolutionCoverageShare,1,"c1a, c2a and both e4 variants are covered at horizon 7");
 assert.ok(overviewFor(14).resolutionCoverageShare!<1,"c1b is not covered at horizon 14");
});

test("C: an unresolved (censored) candidate is a determinate no-resolution-before-expiry, not a failure",()=>{
 const c3=byId("c3a");
 assert.equal(c3.underlyingOutcome,"unresolved");
 assert.equal(c3.resolvedBeforeExpiry,false);
 assert.equal(c3.outcomeBeforeExpiry,"no_resolution_before_expiry");
 const h30=makerReport.outcomeBeforeExpiry.find(r=>r.horizon.nominalDays===30)!;
 assert.equal(h30.counts.no_resolution_before_expiry,1);
 assert.equal(h30.counts.vpoc_before_expiry+h30.counts.invalidation_before_expiry+h30.counts.ambiguous_before_expiry,0);
});

test("C: ambiguous first resolution gets its own bucket, never folded into VPOC or invalidation",()=>{
 assert.equal(byId("c4a").outcomeBeforeExpiry,"ambiguous_before_expiry");
 assert.equal(outcomeRowFor(7).counts.ambiguous_before_expiry,2,"both width variants of e4");
});

test("NO-RESOLUTION SPLIT: resolved-later and still-censored are diagnosed separately, never merged",()=>{
 // c1b's event DID resolve, three days after this structure expired.
 assert.equal(byId("c1b").outcomeBeforeExpiry,"no_resolution_before_expiry");
 assert.equal(byId("c1b").noResolutionDetail,"resolved_later");
 // c3a's event never resolved by canonical observation end.
 assert.equal(byId("c3a").noResolutionDetail,"still_unresolved");
 const h14=outcomeRowFor(14),h30=makerReport.outcomeBeforeExpiry.find(r=>r.horizon.nominalDays===30)!;
 assert.equal(h14.noResolutionDetail.resolved_later,1);
 assert.equal(h14.noResolutionDetail.still_unresolved,0);
 assert.equal(h30.noResolutionDetail.still_unresolved,1);
 assert.equal(h30.noResolutionDetail.resolved_later,0);
 // The visible category stays whole: the split reconciles back to its bucket.
 for(const r of [...report.outcomeBeforeExpiry,...makerReport.outcomeBeforeExpiry])
  assert.equal(r.noResolutionDetail.resolved_later+r.noResolutionDetail.still_unresolved,r.counts.no_resolution_before_expiry,`${r.horizon.label} split must reconcile`);
});

test("RECONCILIATION: outcome-before-expiry buckets sum to the determinate population at every horizon",()=>{
 for(const r of report.outcomeBeforeExpiry){
  const sum=r.counts.vpoc_before_expiry+r.counts.invalidation_before_expiry+r.counts.ambiguous_before_expiry+r.counts.no_resolution_before_expiry+r.counts.vpoc_before_structure_entry;
  assert.equal(sum,r.determinateN,`${r.horizon.label} must reconcile`);
 }
 const h14=outcomeRowFor(14);
 assert.equal(h14.determinateN,2,"c1b and c8a; c5a has no determinable DTE");
 assert.equal(h14.notDeterminableN,1,"c5a");
});

test("D: DTE buffer is signed and retains the negative (expiry-before-resolution) tail",()=>{
 assert.equal(byId("c1a").dteBufferDays,2,"expiry +5d minus resolution +3d");
 assert.equal(byId("c1b").dteBufferDays,-1,"expiry +2d minus resolution +3d");
 assert.equal(byId("c5a").dteBufferDays,null,"not computable without an expiry");
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

test("F: ambiguous resolution keeps its own bucket and never receives a capital-day return",()=>{
 const c4=byId("c4a");
 assert.equal(c4.pnlAtVpocUsd,200,"raw per-endpoint PnL is still readable");
 assert.equal(c4.pnlAtInvalidationUsd,-200);
 assert.equal(c4.capitalDayReturn,null,"ambiguous has no single realized outcome to divide by capital-days");
 const buckets=report.pnlByOutcome.flatMap(r=>r.buckets);
 assert.equal(buckets.find(b=>b.outcome==="vpoc_before_expiry"&&b.n>0)?.medianPnlUsd,500,"only c1a is a VPOC-before-expiry result");
 const ambiguous=buckets.find(b=>b.outcome==="ambiguous_before_expiry"&&b.n>0)!;
 assert.equal(ambiguous.n,2,"both e4 width variants land in the ambiguous bucket, not the VPOC or invalidation ones");
});

test("PNL BUCKETS: a structure is priced at the outcome that happened while it existed",()=>{
 // c1b's event reached VPOC three days AFTER this structure expired, so it is a
 // settlement result -- it must never appear as a PnL-at-VPOC observation.
 const h14=report.pnlByOutcome.find(r=>r.horizon.nominalDays===14)!;
 const settlement=h14.buckets.find(b=>b.outcome==="no_resolution_before_expiry")!;
 assert.equal(settlement.n,1,"c1b");
 assert.equal(settlement.medianPnlUsd,-100,"settlement PnL, not the +500 VPOC print of its event");
 assert.equal(h14.buckets.find(b=>b.outcome==="vpoc_before_expiry")!.n,0);
});

test("PRE-ENTRY VPOC: a VPOC that predates the structure is its own state, never a post-entry outcome",()=>{
 const c8=byId("c8a");
 assert.equal(c8.vpocBeforeStructureEntry,true);
 assert.equal(c8.outcomeBeforeExpiry,"vpoc_before_structure_entry");
 assert.notEqual(c8.outcomeBeforeExpiry,"vpoc_before_expiry");
 assert.equal(c8.pnlAtVpocUsd,null,"pricing VPOC here would value an outcome before the position existed");
 assert.equal(c8.dteBufferDays,null,"no buffer against a resolution that preceded entry");
 assert.equal(c8.postEntryResolutionDays,null);
});

test("PRE-ENTRY VPOC: such a structure stays fully inside availability, execution and holding analysis",()=>{
 const c8=byId("c8a");
 assert.equal(c8.executionScenarioStatus,"evaluated","still a genuine taker evaluation");
 assert.equal(c8.pnlAtSettlementUsd,60,"settlement analysis is still valid");
 assert.equal(c8.holdingDays,7,"entry day 5 to expiry day 12");
 assert.equal(c8.heldToExpiry,true);
 assert.ok(availabilityFor(14).taker.events>=1,"e8 still counts toward taker executable coverage");
 const bucket=report.pnlByOutcome.find(r=>r.horizon.nominalDays===14)!.buckets.find(b=>b.outcome==="vpoc_before_structure_entry")!;
 assert.equal(bucket.n,1);
 assert.equal(bucket.medianPnlUsd,null,"no post-entry PnL at VPOC exists for it");
 assert.match(bucket.note!,/preceded this structure's entry/i);
});

test("EXECUTION-INDEPENDENT: switching scenario never changes a structural fact",()=>{
 const takerRow=row("c1a","taker"),makerRow=row("c1a","maker");
 assert.equal(makerRow.executionScenarioStatus,"not_evaluated");
 // Every execution-independent field is identical on both rows, even though the
 // maker scenario was never evaluated.
 for(const key of ["actualDteDays","expiryTimestampMs","structureEntryMs","resolvedBeforeExpiry","outcomeBeforeExpiry","dteBufferDays","holdingDays","timeToResolutionDays"] as const)
  assert.deepEqual(makerRow[key],takerRow[key],`${key} must not depend on the execution scenario`);
 // ...and the execution-dependent ones are genuinely absent, not borrowed.
 assert.equal(makerRow.entryQuality,null);
 assert.equal(makerRow.synchronizationMinutes,null);
 assert.equal(makerRow.worstAdverseUsd,null);
 assert.equal(makerRow.adversePath.status,"scenario_not_evaluated");
});

test("EXECUTION-INDEPENDENT: report-level structural statistics are identical under both scenarios",()=>{
 assert.deepEqual(report.outcomeBeforeExpiry,makerReport.outcomeBeforeExpiry,"outcome buckets are a property of the structure");
 assert.deepEqual(report.dteBuffer,makerReport.dteBuffer);
 assert.deepEqual(report.holdingPeriod,makerReport.holdingPeriod);
 assert.deepEqual(report.actualDteAll,makerReport.actualDteAll);
 assert.equal(report.headline.medianActualDteDays,makerReport.headline.medianActualDteDays);
});

test("COVERAGE: not evaluated, unavailable and a genuine share are three distinct states",()=>{
 // No maker row at all at horizon 14 -- never assessed.
 assert.equal(availabilityFor(14).maker.status,"not_evaluated");
 assert.equal(availabilityFor(14).maker.share,null,"never rendered as 0%");
 assert.match(availabilityFor(14).maker.reason!,/not a 0% result/i);
 // Horizon 30 has a taker row, but it is not_evaluated: assessed, unsupported.
 assert.equal(availabilityFor(30).taker.status,"unavailable");
 assert.equal(availabilityFor(30).taker.share,null);
 assert.match(availabilityFor(30).taker.reason!,/not_evaluated/);
 // Horizon 7 has genuinely evaluated maker evidence, so a share is meaningful.
 assert.equal(availabilityFor(7).maker.status,"measured");
 assert.equal(availabilityFor(7).maker.events,1,"only e2 has an evaluated maker row at horizon 7");
 assert.equal(availabilityFor(7).maker.share,share(1,5));
});

test("HEADLINE: maker and taker coverage are event-level and measured independently",()=>{
 // Denominator is eligible MR events (events that generated a candidate): e1..e8.
 assert.equal(report.headline.taker.eligibleEvents,8);
 // Taker-evaluated events: e1, e2, e4, e5, e6, e8. e3's taker row is not_evaluated.
 assert.equal(report.headline.taker.status,"measured");
 assert.equal(report.headline.taker.events,6);
 assert.equal(report.headline.taker.share,share(6,8));
 // Maker-evaluated events: e2 and e3 only. e1's maker row is not_evaluated.
 assert.equal(report.headline.maker.events,2);
 assert.equal(report.headline.maker.share,share(2,8));
 // The headline is a property of the bundle, not of the selected view.
 assert.deepEqual(makerReport.headline.taker,report.headline.taker);
 assert.notEqual(report.headline.taker.share,1,"never a configured-run artefact of 100%");
});

test("SCENARIO: the report body is scoped to one scenario, and a not_evaluated row is never economics",()=>{
 assert.equal(report.scenario,"taker");
 assert.ok(report.candidates.every(c=>c.executionScenario==="taker"));
 assert.ok(makerReport.candidates.every(c=>c.executionScenario==="maker"));
 // c3a appears in the taker report as an explicitly not-evaluated row...
 const c3aTaker=report.candidates.find(c=>c.candidateId==="c3a")!;
 assert.equal(c3aTaker.executionScenarioStatus,"not_evaluated");
 assert.match(c3aTaker.executionScenarioReason!,/taker-consistent/);
 // ...and is counted as such rather than dropped or scored as zero.
 const h30=report.overview.find(r=>r.horizon.nominalDays===30)!;
 assert.equal(h30.notEvaluatedN,1);
 assert.equal(h30.medianTimeToCapture50Days,null,"a not_evaluated row contributes no economics");
});

test("MATCHED EXECUTION: maker vs taker is compared only on structures evaluated under both",()=>{
 const h7=report.matchedExecution.find(r=>r.horizon.nominalDays===7)!;
 assert.equal(h7.matchedN,1,"only c2a has both scenarios genuinely evaluated");
 assert.equal(h7.medianPnlDragUsd,20,"maker −280 minus taker −300");
 assert.equal(h7.medianWorstAdverseDragUsd,40,"maker −80 minus taker −120");
 // c1a is taker-only at horizon 7 and must be reported, not silently compared.
 assert.equal(h7.takerOnlyN,3,"c1a, c4a and c4b are taker-only");
 assert.equal(h7.makerOnlyN,0);
 // Horizon 14 has no structure with both scenarios, so no drag may be invented.
 const h14=report.matchedExecution.find(r=>r.horizon.nominalDays===14)!;
 assert.equal(h14.matchedN,0);
 assert.equal(h14.medianPnlDragUsd,null);
 // The comparison is a property of the bundle, identical in either view.
 assert.deepEqual(makerReport.matchedExecution,report.matchedExecution);
});

test("MATCHED EXECUTION: one scenario's marks never populate the other's",()=>{
 assert.equal(row("c2a","maker").worstAdverseUsd,-80);
 assert.equal(row("c2a","taker").worstAdverseUsd,-120);
});

test("MATCHED DTE: economics are compared only across identical structural variants",()=>{
 // c1a (h7) and c1b (h14) are the same event, strike method, width, structure
 // and option type -- the only legitimate DTE comparison in this fixture.
 const pair=report.matchedDte.find(r=>r.shorter.nominalDays===7&&r.longer.nominalDays===14)!;
 assert.equal(pair.matchedVariants,1);
 assert.equal(pair.medianDteDeltaDays,-3,"2d minus 5d");
 assert.equal(pair.medianPnlDeltaUsd,-600,"c1b settlement −100 minus c1a VPOC +500");
 assert.equal(pair.medianHoldingDeltaDays,-1);
 // c4a and c4b differ in width, so they are different variants and are never
 // compared to each other as if duration were the difference.
 assert.notEqual(byId("c4a").structuralVariantKey,byId("c4b").structuralVariantKey);
 assert.equal(byId("c1a").structuralVariantKey,byId("c1b").structuralVariantKey);
});

test("G: capital-day return is Unavailable per-candidate unless a canonical margin scenario is genuinely available",()=>{
 assert.equal(byId("c2a").requiredCapitalUsd,null,"e2/c2a has no margin_scenarios row at all");
 assert.equal(byId("c2a").capitalDayReturn,null);
 assert.equal(byId("c1a").requiredCapitalUsd,1000);
 assert.ok(Math.abs(byId("c1a").capitalDayReturn!-500/(1000*3))<1e-9,"500 pnl / (1000 usd * 3 holding days)");
});

test("G: the capital-time summary aggregates only candidates with a genuinely usable return",()=>{
 assert.equal(report.capitalTime.available,true);
 assert.equal(report.capitalTime.points.length,1,"c1a only: c4a has margin but no single realized outcome");
 assert.equal(report.capitalTime.points[0]!.actualDteDays,5);
 assert.ok(Math.abs(report.capitalTime.medianCapitalDayReturn!-500/(1000*3))<1e-9);
});

test("G: capital-time is honestly Unavailable when no candidate anywhere has a usable return",()=>{
 const noMargin={...dataset,tables:{...dataset.tables,margin_scenarios:[]}} as unknown as AnalysisDataset;
 const r=buildDurationDteReport(noMargin,"taker");
 assert.equal(r.capitalTime.available,false);
 assert.match(r.capitalTime.reason!,/margin/i);
 assert.equal(r.capitalTime.medianCapitalDayReturn,null);
});

test("HOLDING: T_hold works with no margin data at all and never uses a pre-entry resolution",()=>{
 const noMargin=buildDurationDteReport({...dataset,tables:{...dataset.tables,margin_scenarios:[]}} as unknown as AnalysisDataset,"taker");
 assert.equal(noMargin.capitalTime.available,false,"capital is genuinely unavailable...");
 assert.deepEqual(noMargin.holdingPeriod,report.holdingPeriod,"...yet holding-period analysis is unaffected");
 // resolution before expiry -> hold to resolution; expiry first -> hold to expiry.
 assert.equal(byId("c1a").holdingDays,3,"resolved at +3d, expiry +5d");
 assert.equal(byId("c1a").heldToExpiry,false);
 assert.equal(byId("c1b").holdingDays,2,"expiry +2d arrives before the +3d resolution");
 assert.equal(byId("c1b").heldToExpiry,true);
 assert.equal(byId("c3a").holdingDays,20,"never resolved: held to expiry");
 assert.equal(byId("c8a").holdingDays,7,"pre-entry VPOC is not a holding endpoint");
 const h7=noMargin.holdingPeriod.find(r=>r.horizon.nominalDays===7)!;
 assert.equal(h7.n,4);
 assert.ok(h7.medianHoldingDays!>0);
 assert.ok(h7.p80HoldingDays!>=h7.medianHoldingDays!);
 assert.notEqual(h7.heldToSettlementShare,null);
});

test("RESOLUTION SPEED: cohorts come from the observed distribution and keep unresolved explicit",()=>{
 const rs=report.resolutionSpeed;
 assert.equal(rs.available,true);
 assert.ok(rs.boundaries.p25Days!<=rs.boundaries.p75Days!);
 assert.equal(rs.boundaries.unresolvedEventsN,1,"e3 never resolved");
 for(const r of rs.rows)for(const cell of r.cells){
  assert.ok(["fast","normal","slow","unresolved"].includes(cell.cohort));
  if(cell.n===0)assert.equal(cell.medianPnlUsd,null,"an empty cohort cell is never a zero");
 }
 // Unresolved is a cohort of its own, never folded into "slow".
 const cohorts=rs.rows.flatMap(r=>r.cells.filter(c=>c.n>0).map(c=>c.cohort));
 assert.ok(!cohorts.includes("unresolved")||rs.boundaries.unresolvedEventsN>0);
});

test("RESOLUTION SPEED: an insufficient sample is reported, never cut with invented thresholds",()=>{
 const single={...dataset,tables:{...dataset.tables,events:[events[0]!]}} as unknown as AnalysisDataset;
 const r=buildDurationDteReport(single,"taker");
 assert.equal(r.resolutionSpeed.available,false);
 assert.match(r.resolutionSpeed.reason!,/at least two resolved/i);
 assert.deepEqual(r.resolutionSpeed.rows,[]);
});

test("ENTRY DELAY: causal support is detected from raw evidence, never assumed",()=>{
 const ed=buildEntryDelayReport(dataset);
 // c1a's taker track carries raw marks out to +3.5d, so every offset is covered
 // by genuinely later evidence rather than by reusing the original fill.
 assert.equal(ed.supported,true);
 assert.deepEqual(ed.rows.map(r=>r.delayHours),[0,4,8,12]);
 assert.ok(ed.rows.every(r=>r.structuresWithRawEvidence.taker>0));
 assert.equal(ed.requiredCanonicalInputs.length,0);
});

test("ENTRY DELAY: without raw marks the section is explicitly unsupported, never fabricated",()=>{
 // The real canonical export prices only the model track, so the raw track
 // carries no mark to reconstruct a delayed entry from.
 const modelOnly={...dataset,tables:{...dataset.tables,
  valuations:valuations.map(v=>({...v,valuation_status:v.pricing_track==="raw_vwap"?"unavailable":v.valuation_status}))}} as unknown as AnalysisDataset;
 const ed=buildEntryDelayReport(modelOnly);
 assert.equal(ed.supported,false);
 assert.match(ed.reason!,/not supported by current canonical export/i);
 assert.ok(ed.requiredCanonicalInputs.length>0,"the missing canonical inputs are named");
 assert.ok(ed.rows.every(r=>r.structuresWithRawEvidence.maker===0&&r.structuresWithRawEvidence.taker===0));
 const r=buildDurationDteReport(modelOnly,"taker");
 assert.equal(r.entryDelay.supported,false);
});

test("ADVERSE PATH: a missing worst-adverse always carries an inspectable, non-zero reason",()=>{
 const d=report.adverseDiagnostics;
 assert.equal(d.totalRows,report.candidates.length);
 assert.ok(d.withValue>0&&d.withValue<d.totalRows,"this fixture has both kinds");
 // c2a's taker row has raw marks; c4a has none at all.
 assert.equal(byId("c4a").worstAdverseUsd,null);
 assert.equal(byId("c4a").adversePath.status,"no_raw_marks");
 assert.match(byId("c4a").adversePath.reason!,/raw-VWAP/);
 assert.equal(row("c1a","maker").adversePath.status,"scenario_not_evaluated");
 assert.ok(d.dominantReason!==null);
 // Statuses partition the population exactly.
 assert.equal(Object.values(d.byStatus).reduce((a,b)=>a+b,0),d.totalRows);
});

test("ADVERSE PATH: MAE-before-profit is reported only where the path genuinely turned profitable",()=>{
 // c1a's raw track runs −50, −150, +20 before resolution: profit observed, and
 // the worst mark up to that point is −150.
 const c1a=byId("c1a");
 assert.equal(c1a.adversePath.profitObserved,true);
 assert.equal(c1a.adversePath.maeBeforeProfitUsd,-150);
 // c2a's taker track never turns profitable, so the metric is absent, not zero.
 const c2a=byId("c2a");
 assert.equal(c2a.adversePath.profitObserved,false);
 assert.equal(c2a.adversePath.maeBeforeProfitUsd,null);
 assert.equal(c2a.worstAdverseUsd,-120,"worst adverse is still reported");
});

test("SYNCHRONIZATION: median and P95 are kept, per execution scenario, never pooled",()=>{
 const h7=report.synchronization.find(r=>r.horizon.nominalDays===7)!;
 // Synchronization is structure-level entry evidence, so it is NOT gated on the
 // underlying event's time-to-event eligibility: c6a counts here too.
 assert.equal(h7.n,5,"taker-evaluated rows at horizon 7: c1a, c2a, c4a, c4b, c6a");
 assert.notEqual(h7.medianMinutes,null);
 assert.notEqual(h7.p95Minutes,null);
 assert.ok(h7.p95Minutes!>=h7.medianMinutes!);
 // The maker view reports the maker gaps only -- c2a's 0.2m, not the taker set.
 const makerH7=makerReport.synchronization.find(r=>r.horizon.nominalDays===7)!;
 assert.equal(makerH7.n,1);
 assert.equal(makerH7.medianMinutes,0.2);
});

test("J: rebuilding the report from the same dataset is deterministic regardless of any UI-only slicing",()=>{
 const rebuilt=buildDurationDteReport(dataset,"taker");
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
 const r=buildDurationDteReport(empty,"taker");
 assert.equal(r.candidates.length,0);
 assert.equal(r.horizons.length,0);
 assert.equal(r.headline.medianActualDteDays,null);
 assert.equal(r.headline.maker.status,"not_evaluated");
 assert.equal(r.capitalTime.available,false);
 assert.equal(r.matchedDte.length,0);
});

test("normalize: buildHorizonAvailability is independent of buildDurationDteReport's own aggregation",()=>{
 const families=buildHorizonFamilies(dataset),availabilityDirect=buildHorizonAvailability(dataset,families);
 assert.deepEqual(availabilityDirect,report.availability);
});
