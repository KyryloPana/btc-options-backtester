import test from "node:test";import assert from "node:assert/strict";
import {buildResearchBundle,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {delayedEconomicPathAvailable,describeCanonicalTracks} from "../app/lib/research-tracks.ts";
import {canonicalOutcomeId,OUTCOMES_OUTSIDE_EXPORT_CONTRACT} from "../app/lib/research-outcomes.ts";
import {now,referenceOnlyFixture,ts} from "./fixtures/research-selection-store.ts";

const HOUR=3_600_000,DAY=86_400_000,EXPIRY=ts+7*DAY;
const rows=(text:string)=>text.trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);

/** A delayed post-entry point exactly as `analyzeDelayedExecution` persists one. */
const delayedPoint=(entryMs:number,offsetMs:number,pnl:number)=>({
 timestamp:entryMs+offsetMs,hoursFromEntry:offsetMs/HOUR,underlyingIndex:101,
 remainingDte:Math.max(0,(EXPIRY-(entryMs+offsetMs))/DAY),intrinsicSpreadBtc:0.004,
 estimatedPnlBtc:pnl,maxLossDays:0.1,
});

/** A delayed snapshot in the engine's own persisted shape. */
function delayedSnapshot(entryMs:number,points:unknown[],overrides:Record<string,unknown>={}){
 return{status:"evaluated",reason:null,source:"delayed conservative taker tape proxy",
  entrySnapshot:{valuationTimestamp:entryMs,targetTimestamp:entryMs,delayHours:(entryMs-ts)/HOUR,
   requestedOrderTimestamp:entryMs-HOUR,actualDteRemaining:(EXPIRY-entryMs)/DAY,entryTargetIndex:101,
   grossSpreadBtc:0.009,openingFeesBtc:0.0005,netOpeningCashFlowBtc:0.0085,estimateQuality:"green",
   provenance:{observed:true,makerQueueFillClaimed:false,causalAfterRequestedOrder:true}},
  valuationPathSnapshot:points,
  outcomeSnapshots:points.length?[{label:"terminal delayed path",valuationTimestamp:(points.at(-1) as {timestamp:number}).timestamp,estimatedNetPnlBtc:0.006}]:[],
  preEntryResolution:"entered-before-vpoc",...overrides};
}

function fixtureWith(maker:unknown,taker:unknown){
 const fixture=referenceOnlyFixture();
 const structure=fixture.events[0]!.selectedStructures[0]! as unknown as Record<string,unknown>;
 (structure.candidateSnapshot as Record<string,unknown>).expiryTimestamp=EXPIRY;
 structure.delayedExecution={version:"entry-timing-v1",maker,taker};
 return fixture;
}
const tracksOf=(fixture:ReturnType<typeof referenceOnlyFixture>)=>
 describeCanonicalTracks(fixture.events[0]!.selectedStructures[0]! as unknown as Record<string,unknown>);
const trackOf=(fixture:ReturnType<typeof referenceOnlyFixture>,track:string)=>tracksOf(fixture).find(t=>t.track===track)!;

// ---------------------------------------------------------------------------
// The availability contract
// ---------------------------------------------------------------------------

test("CONTRACT: a delayed maker filling 4h after signal with a causal path is available",()=>{
 const entry=ts+4*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.004),delayedPoint(entry,2*DAY,0.006)]),
  {status:"unavailable",reason:"No qualifying taker tape."});
 const track=trackOf(fixture,"delayed_maker");
 assert.equal(track.status,"available");
 assert.equal(track.entryStatus,"available");
 assert.equal(track.pathStatus,"available");
 assert.equal(track.entryTimestampMs,entry,"the real delayed opening timestamp, never the signal");
 assert.notEqual(track.entryTimestampMs,ts);
 assert.equal(track.entryBasis,"observed_delayed_fill");
 // The post-entry path is a reconstruction, not observed executable closes.
 assert.equal(track.valuationBasis,"reconstructed_intrinsic_marks");
 assert.notEqual(track.valuationBasis,"observed_marks");
 // Maker and taker evidence stay separate.
 assert.equal(trackOf(fixture,"delayed_taker").status,"unavailable");
});

test("CONTRACT: a delayed taker filling 1d after signal is independently available",()=>{
 const entry=ts+DAY;
 const fixture=fixtureWith({status:"unavailable",reason:"No qualifying maker tape."},
  delayedSnapshot(entry,[delayedPoint(entry,4*HOUR,0.005)]));
 assert.equal(trackOf(fixture,"delayed_taker").status,"available");
 assert.equal(trackOf(fixture,"delayed_taker").entryTimestampMs,entry);
 assert.equal(trackOf(fixture,"delayed_maker").status,"unavailable");
 assert.equal(trackOf(fixture,"delayed_maker").entryStatus,"unavailable");
});

test("CONTRACT: delayed entry evidence without a usable path is entry-only, never available",()=>{
 const entry=ts+6*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[]),{status:"not_evaluated",reason:"Skipped."});
 const track=trackOf(fixture,"delayed_maker");
 assert.equal(track.status,"unavailable","the critical invariant: available must mean a usable PnL path");
 assert.equal(track.reasonCode,"delayed_entry_available_path_unavailable");
 assert.equal(track.entryStatus,"available","the delayed opening evidence is still visible");
 assert.equal(track.pathStatus,"unavailable");
 assert.equal(track.entryTimestampMs,entry);
 assert.notEqual(track.entrySnapshot,null,"the opening ledger is retained, not discarded");
 assert.match(String(track.reason),/entry-only evidence/);
});

test("CONTRACT: no delayed execution evidence at all stays unavailable with its own reason",()=>{
 const fixture=fixtureWith({status:"unavailable",reason:"No complete two-leg scenario before the configured maximum delay."},
  {status:"not_evaluated",reason:"Taker was intentionally skipped."});
 assert.equal(trackOf(fixture,"delayed_maker").reasonCode,"delayed_execution_unavailable");
 assert.equal(trackOf(fixture,"delayed_taker").reasonCode,"delayed_execution_not_evaluated");
 for(const track of ["delayed_maker","delayed_taker"]){
  assert.equal(trackOf(fixture,track).entryStatus,"unavailable");
  assert.equal(trackOf(fixture,track).entryTimestampMs,null);
 }
});

// ---------------------------------------------------------------------------
// Causal safeguards
// ---------------------------------------------------------------------------

test("CAUSALITY: no delayed valuation before the delayed entry or after expiry",()=>{
 const entry=ts+4*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[
  delayedPoint(entry,-2*HOUR,0.001),   // before the delayed opening
  delayedPoint(entry,HOUR,0.004),
  delayedPoint(entry,8*DAY,0.009),      // after expiry
 ]),{status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const delayed=rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker");
 assert.equal(delayed.length,1,"only the causal in-window point survives");
 assert.equal(delayed[0]!.timestamp_utc,new Date(entry+HOUR).toISOString());
 assert.ok(Date.parse(String(delayed[0]!.timestamp_utc))>=entry);
 assert.ok(Date.parse(String(delayed[0]!.timestamp_utc))<=EXPIRY);
});

test("CAUSALITY: a pre-entry resolution keeps the delayed track unavailable",()=>{
 // The delayed engine marks these as missed-entry, so the snapshot never
 // reaches "evaluated"; hindsight selection is blocked upstream and the
 // canonical track must reflect that rather than reinstating the trade.
 for(const resolution of ["vpoc-occurred-before-entry","invalidation-occurred-before-entry","ambiguous-same-timestamp","expired-before-entry"]){
  const fixture=fixtureWith({status:"unavailable",reason:`Delayed entry rejected: ${resolution}.`,preEntryResolution:resolution},
   {status:"not_evaluated",reason:"Skipped."});
  const track=trackOf(fixture,"delayed_maker");
  assert.equal(track.status,"unavailable",resolution);
  assert.equal(track.reasonCode,"delayed_execution_unavailable");
  assert.match(String(track.reason),new RegExp(resolution));
 }
});

test("CAUSALITY: a delayed opening close to expiry keeps only its remaining window",()=>{
 const entry=EXPIRY-2*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.002),delayedPoint(entry,4*HOUR,0.003)]),
  {status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 const delayed=rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker");
 assert.equal(delayed.length,1,"the point past expiry is dropped, not clamped");
 assert.equal(trackOf(fixture,"delayed_maker").status,"available");
});

// ---------------------------------------------------------------------------
// Export fidelity
// ---------------------------------------------------------------------------

test("EXPORT: delayed valuation rows are priced from the delayed engine's own fields",()=>{
 const entry=ts+4*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.004),delayedPoint(entry,2*DAY,0.006)]),
  {status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const delayed=rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker");
 assert.equal(delayed.length,2);
 // The defect: the exporter read only estimatedNetPnlBtc/targetIndex, so every
 // delayed row was unavailable while the track claimed to be available.
 assert.ok(delayed.every(r=>r.valuation_status==="priced"),"a track cannot be available with zero usable points");
 assert.deepEqual(delayed.map(r=>r.net_pnl_native),[0.004,0.006]);
 assert.deepEqual(delayed.map(r=>r.target_underlying_index),[101,101]);
 assert.deepEqual(delayed.map(r=>r.net_pnl_usd),[0.004*101,0.006*101]);
 assert.ok(delayed.every(r=>r.track_entry_status==="available"&&r.track_path_status==="available"));
 assert.ok(delayed.every(r=>r.entry_timestamp_utc===new Date(entry).toISOString()),"anchored to the delayed opening");
 // Reference entry values are never substituted for the delayed ones.
 const reference=rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="reference_fair_value");
 assert.ok(reference.every(r=>r.entry_timestamp_utc!==new Date(entry).toISOString()));
});

test("EXPORT: the structure-economics descriptor reports entry and path status separately",()=>{
 const entry=ts+6*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[]),{status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const descriptor=(rows(bundle.files["structure_economics.jsonl"])[0]!.tracks as Array<Record<string,unknown>>)
  .find(t=>t.track==="delayed_maker")!;
 assert.equal(descriptor.status,"unavailable");
 assert.equal(descriptor.entry_status,"available");
 assert.equal(descriptor.path_status,"unavailable");
 assert.equal(descriptor.reason_code,"delayed_entry_available_path_unavailable");
 // No valuation or outcome rows are fabricated for an entry-only track.
 assert.equal(rows(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker").length,0);
 assert.equal(rows(bundle.files["outcomes.jsonl"]).filter(r=>r.analytics_track==="delayed_maker").length,0);
});

test("EXPORT: the terminal delayed path marker is recognised, not an unmapped label",()=>{
 assert.equal(canonicalOutcomeId("terminal delayed path"),"terminal_delayed_path");
 assert.ok(OUTCOMES_OUTSIDE_EXPORT_CONTRACT.includes("terminal_delayed_path"),
  "it marks the end of a path rather than naming an exit policy, so it is outside the exported set");
 const entry=ts+4*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.004)]),{status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true,"a delayed track does not fail export on its own path marker");
 assert.ok(!rows(bundle.files["outcomes.jsonl"]).some(r=>r.outcome_type==="terminal_delayed_path"));
});

test("VALIDATOR: a delayed track cannot claim available while every row is unavailable",()=>{
 const entry=ts+4*HOUR;
 const fixture=fixtureWith(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.004)]),{status:"not_evaluated",reason:"Skipped."});
 const bundle=buildResearchBundle(fixture,now);
 const files=structuredClone(bundle.files);
 files["valuations.jsonl"]=rows(files["valuations.jsonl"]).map(r=>JSON.stringify(
  r.analytics_track==="delayed_maker"?{...r,valuation_status:"unavailable",net_pnl_native:null,
   unavailable_reason_codes:["pricing_track_unavailable"],missing_field_codes:["missing_pricing_track"]}:r,
 )).join(String.fromCharCode(10))+String.fromCharCode(10);
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/entry-only delayed evidence must not be reported as a complete economic track/.test(e)),checked.errors.join(" | "));
 // And an available track whose descriptor admits an unavailable path is rejected.
 const inconsistent=structuredClone(bundle.files);
 inconsistent["structure_economics.jsonl"]=rows(inconsistent["structure_economics.jsonl"]).map(r=>JSON.stringify({...r,
  tracks:(r.tracks as Array<Record<string,unknown>>).map(t=>t.track==="delayed_maker"?{...t,path_status:"unavailable"}:t)}))
  .join(String.fromCharCode(10))+String.fromCharCode(10);
 assert.ok(validateResearchBundle(inconsistent).errors.some(e=>/is available while its path_status is unavailable/.test(e)));
});

test("ANALYTICS: entry-only delayed evidence is not selectable as a complete PnL cohort",()=>{
 const entry=ts+4*HOUR;
 assert.equal(delayedEconomicPathAvailable(delayedSnapshot(entry,[delayedPoint(entry,HOUR,0.004)]),EXPIRY),true);
 assert.equal(delayedEconomicPathAvailable(delayedSnapshot(entry,[]),EXPIRY),false,"entry-only");
 // A path that exists only before the delayed opening, or only after expiry.
 assert.equal(delayedEconomicPathAvailable(delayedSnapshot(entry,[delayedPoint(entry,-2*HOUR,0.001)]),EXPIRY),false);
 assert.equal(delayedEconomicPathAvailable(delayedSnapshot(entry,[delayedPoint(entry,9*DAY,0.001)]),EXPIRY),false);
 // A point carrying no economic value at all.
 assert.equal(delayedEconomicPathAvailable(delayedSnapshot(entry,[{timestamp:entry+HOUR,underlyingIndex:101}]),EXPIRY),false);
 assert.equal(delayedEconomicPathAvailable({status:"unavailable"},EXPIRY),false);
 // Reference fair value remains the primary economic baseline and is untouched.
 const fixture=fixtureWith(delayedSnapshot(entry,[]),{status:"not_evaluated",reason:"Skipped."});
 assert.equal(trackOf(fixture,"reference_fair_value").status,"available");
});
