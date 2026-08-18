import test from "node:test";
import assert from "node:assert/strict";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {normalizeMrEvents} from "../app/lib/underlying-resolution/normalize.ts";
import {buildUnderlyingResolutionReport} from "../app/lib/underlying-resolution/report.ts";

const D=(day:number,hour=0)=>new Date(Date.UTC(2026,0,day,hour)).toISOString();
const ENTRY=D(1);

/**
 * Canonical-shaped fixture covering every outcome state, a bullish/bearish
 * split, both distance cohorts, one event with no observation window and one
 * event with a stored hourly path.
 */
const events=[
 // Bullish, VPOC first at +2d. Distance 8 / range 20 = 0.4x -> near cohort.
 {event_id:"e1",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(3),invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(11),sequence_status:"vpoc_first",censoring_status:"resolved",
  entry_price:100,range_low:90,range_high:110,vpoc_distance:8},
 // Bearish, invalidation first at +1d. Distance 30 / range 40 = 0.75x -> far.
 {event_id:"e2",direction:"short",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:D(2),
  observation_end_timestamp_utc:D(11),sequence_status:"invalidation_first",censoring_status:"resolved",
  entry_price:200,range_low:180,range_high:220,vpoc_distance:-30},
 // Bullish, never resolved -> right-censored at +5d. Distance 12 / 20 = 0.6x -> far.
 {event_id:"e3",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:D(6),sequence_status:"unresolved",censoring_status:"right_censored",
  entry_price:100,range_low:90,range_high:110,vpoc_distance:12},
 // Bearish, both levels touched at the same timestamp -> ambiguous. 2/10 = 0.2x -> near.
 {event_id:"e4",direction:"short",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:D(4),invalidation_decision_timestamp_utc:D(4),
  observation_end_timestamp_utc:D(11),sequence_status:"ambiguous",censoring_status:"resolved",
  entry_price:100,range_low:95,range_high:105,vpoc_distance:2},
 // No stored path collapses observation end onto entry -> no observation window.
 {event_id:"e5",direction:"long",entry_timestamp_utc:ENTRY,vpoc_trigger_timestamp_utc:null,invalidation_decision_timestamp_utc:null,
  observation_end_timestamp_utc:ENTRY,sequence_status:"unresolved",censoring_status:"right_censored",
  entry_price:100,range_low:90,range_high:110,vpoc_distance:5},
];

// Only e1 has an hourly path, so only e1 can produce MFE/MAE. e1 resolves at
// +2d, so the D(5) candle is deliberately after resolution and must be ignored.
const underlying_path=[
 {event_id:"e1",timestamp_utc:D(1,1),high:104,low:99},
 {event_id:"e1",timestamp_utc:D(2,1),high:109,low:97},
 {event_id:"e1",timestamp_utc:D(5,1),high:999,low:1},
];

const dataset={filename:"f.zip",schemaVersion:"2.1.0",migratedFrom:null,run:{dataset_id:"ds",bundle_id:"b"},
 tables:{events,underlying_path},counts:{selectedCandidates:0,denominator:5},venues:["deribit"],sourceRuns:[],
 eventUniverseComplete:true,capabilities:[]} as unknown as AnalysisDataset;

const report=buildUnderlyingResolutionReport(dataset);
const byId=(id:string)=>normalizeMrEvents(dataset).find(e=>e.eventId===id)!;

test("A: outcome ordering is read from canonical sequence_status",()=>{
 assert.equal(byId("e1").outcome,"vpoc_first");
 assert.equal(byId("e2").outcome,"invalidation_first");
 assert.equal(byId("e3").outcome,"unresolved");
 assert.equal(byId("e4").outcome,"ambiguous");
});

test("B: timing is derived from canonical timestamps in days",()=>{
 assert.equal(byId("e1").timeToVpocDays,2);
 assert.equal(byId("e1").timeToResolutionDays,2);
 assert.equal(byId("e2").timeToInvalidationDays,1);
 assert.equal(byId("e2").timeToResolutionDays,1);
 assert.equal(byId("e4").timeToResolutionDays,3,"first resolution is min of the two");
 assert.equal(byId("e3").observationDays,5,"censoring time");
});

test("C: an unresolved event is censored, is not a failure, and has no completion time",()=>{
 const e3=byId("e3");
 assert.equal(e3.censored,true);
 assert.equal(e3.timeToResolutionDays,null,"no manufactured completion time");
 assert.notEqual(e3.outcome,"invalidation_first");
 assert.equal(report.counts.invalidationFirst,1,"only e2 is a failure");
});

test("C: an event with no observation window is held out, not censored at zero",()=>{
 assert.equal(byId("e5").ineligibility,"no_observation_window");
 assert.equal(report.totalEvents,5);
 assert.equal(report.effectiveN,4);
 assert.deepEqual(report.excludedByReason,[{reason:"no_observation_window",count:1}]);
});

test("RECONCILIATION: outcomes sum to total eligible events",()=>{
 const c=report.counts;
 assert.equal(c.vpocFirst+c.invalidationFirst+c.ambiguous+c.unresolved,report.effectiveN);
 assert.equal(c.total,report.effectiveN);
});

test("F: directional rows reconcile individually and against the global total",()=>{
 const [bull,bear,total]=report.directional;
 assert.equal(bull!.effectiveN,2);
 assert.equal(bear!.effectiveN,2);
 for(const row of [bull!,bear!,total!]){
  const c=row.counts;
  assert.equal(c.vpocFirst+c.invalidationFirst+c.ambiguous+c.unresolved,row.effectiveN,`${row.label} must reconcile`);
 }
 assert.equal(bull!.effectiveN+bear!.effectiveN,total!.effectiveN);
 assert.deepEqual(total!.counts,report.counts,"total row matches the summary cards");
});

test("G: remaining distance is range-normalized and feeds the continuous plot",()=>{
 assert.equal(byId("e1").remainingDistanceRange,0.4);
 assert.equal(byId("e2").remainingDistanceRange,0.75);
 // Only events with BOTH a distance and an observed resolution can be plotted.
 assert.deepEqual(report.distanceVsResolution.map(p=>p.eventId).sort(),["e1","e2","e4"]);
 assert.equal(report.distanceVsResolution.find(p=>p.eventId==="e1")!.resolutionDays,2);
 assert.equal(report.distanceMissing,0);
});

test("G: an unusable range width yields a null distance rather than zero",()=>{
 const flat={...dataset,tables:{events:[{...events[0],range_low:100,range_high:100}],underlying_path:[]}} as unknown as AnalysisDataset;
 assert.equal(normalizeMrEvents(flat)[0]!.remainingDistanceRange,null);
 assert.equal(normalizeMrEvents(flat)[0]!.remainingDistanceUsd,8,"USD distance survives");
});

test("PERCENTILES: VPOC percentiles use only VPOC-first observed times",()=>{
 const vpoc=report.endpoints.find(b=>b.endpoint==="vpoc")!;
 assert.equal(vpoc.method,"observed conditional");
 assert.equal(vpoc.observed,1,"only e1 is VPOC-first; e4 is ambiguous");
 // A single observation returns that value at every percentile, never 0.
 for(const p of vpoc.percentiles)assert.equal(p.days,2);
});

test("PERCENTILES: invalidation percentiles use only invalidation-first observed times",()=>{
 const inv=report.endpoints.find(b=>b.endpoint==="invalidation")!;
 assert.equal(inv.method,"observed conditional");
 assert.equal(inv.observed,1,"only e2");
 for(const p of inv.percentiles)assert.equal(p.days,1);
});

test("PERCENTILES: ambiguous is never assigned to the success or failure endpoint",()=>{
 const vpoc=report.endpoints.find(b=>b.endpoint==="vpoc")!,inv=report.endpoints.find(b=>b.endpoint==="invalidation")!;
 assert.equal(vpoc.observed+inv.observed,2,"e4 contributes to neither");
 assert.equal(report.counts.ambiguous,1,"but it is still counted");
});

test("PERCENTILES: an endpoint with no observations is Not estimable with a reason",()=>{
 const noFailures={...dataset,tables:{events:[events[0]],underlying_path:[]}} as unknown as AnalysisDataset;
 const inv=buildUnderlyingResolutionReport(noFailures).endpoints.find(b=>b.endpoint==="invalidation")!;
 assert.equal(inv.observed,0);
 for(const p of inv.percentiles)assert.equal(p.days,null,"never zero");
 assert.match(inv.emptyReason!,/No invalidation-first events/);
});

test("KM: first resolution stays censor-aware and separate from the conditional endpoints",()=>{
 const resolution=report.endpoints.find(b=>b.endpoint==="resolution")!;
 assert.equal(resolution.method,"kaplan-meier");
 assert.equal(resolution.observed,3,"e1, e2 and e4 resolved");
 assert.equal(resolution.censored,1,"e3 is right-censored");
 assert.equal(resolution.effectiveN,report.effectiveN);
});

test("I: MFE/MAE use entry -> first resolution and ignore post-resolution candles",()=>{
 const e1=byId("e1").excursion!;
 // e1 resolves at +2d; the extreme D(5) candle (999/1) must not contribute.
 assert.equal(e1.mfeUsd,9,"long: max high 109 - entry 100, pre-resolution only");
 assert.equal(e1.maeUsd,-3,"long: min low 97 - entry 100, pre-resolution only");
 assert.equal(byId("e1").resolutionTimestampMs,Date.parse(D(3)),"window ends at first resolution");
});

test("I: a censored event measures excursion to its censoring time",()=>{
 const censored={...dataset,tables:{events:[events[2]],
  underlying_path:[{event_id:"e3",timestamp_utc:D(3,1),high:106,low:94},
                   {event_id:"e3",timestamp_utc:D(9,1),high:500,low:2}]}} as unknown as AnalysisDataset;
 // e3 is censored at +5d, so the D(9) candle lies outside the window.
 const x=normalizeMrEvents(censored)[0]!.excursion!;
 assert.equal(x.mfeUsd,6,"max high 106 - entry 100");
 assert.equal(x.maeUsd,-6,"min low 94 - entry 100");
});

test("I: a missing path stays Unavailable rather than zero",()=>{
 assert.equal(byId("e2").excursion,null,"no path -> Unavailable, never 0");
 assert.equal(byId("e4").excursion,null);
 assert.equal(report.excursionOverall.available,1,"only e1 has a path");
 assert.equal(report.excursionOverall.total,report.effectiveN);
});

test("I: short-side excursion is measured in the direction of the thesis",()=>{
 const shortSide={...dataset,tables:{events:[{...events[1],event_id:"s1"}],
  underlying_path:[{event_id:"s1",timestamp_utc:D(1,1),high:210,low:190}]}} as unknown as AnalysisDataset;
 const x=normalizeMrEvents(shortSide)[0]!.excursion!;
 assert.equal(x.mfeUsd,10,"short: entry 200 - min low 190");
 assert.equal(x.maeUsd,-10,"short: entry 200 - max high 210");
});

test("J: analytics are independent of any table page the UI chooses to show",()=>{
 // The view model is a pure function of the dataset, so a paginated view can
 // only ever slice `report.events` after the fact.
 const page1=report.events.slice(0,2),page2=report.events.slice(2,4);
 assert.notDeepEqual(page1,page2);
 const rebuilt=buildUnderlyingResolutionReport(dataset);
 assert.deepEqual(rebuilt.counts,report.counts);
 assert.deepEqual(rebuilt.directional,report.directional);
 assert.deepEqual(rebuilt.endpoints,report.endpoints);
 assert.equal(rebuilt.effectiveN,report.effectiveN);
});

test("data sufficiency: an empty bundle produces zeroed counts and no estimates",()=>{
 const empty={...dataset,tables:{events:[],underlying_path:[]}} as unknown as AnalysisDataset;
 const r=buildUnderlyingResolutionReport(empty);
 assert.equal(r.totalEvents,0);
 assert.equal(r.effectiveN,0);
 for(const block of r.endpoints)for(const p of block.percentiles)assert.equal(p.days,null,"no percentile is estimable");
 assert.deepEqual(r.survival,[]);
});

test("data sufficiency: an all-unresolved bundle reports no resolutions and no percentiles",()=>{
 const censoredOnly={...dataset,tables:{events:[events[2]],underlying_path:[]}} as unknown as AnalysisDataset;
 const r=buildUnderlyingResolutionReport(censoredOnly);
 assert.equal(r.effectiveN,1);
 assert.equal(r.counts.unresolved,1);
 assert.equal(r.counts.invalidationFirst,0,"censored is never a failure");
 const resolution=r.endpoints.find(b=>b.endpoint==="resolution")!;
 assert.equal(resolution.observed,0);
 assert.equal(resolution.censored,1);
 for(const p of resolution.percentiles)assert.equal(p.days,null);
});
