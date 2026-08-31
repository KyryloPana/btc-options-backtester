import test from "node:test";
import assert from "node:assert/strict";
import {buildResearchBundle,validateResearchBundle,RESEARCH_BUNDLE_SCHEMA_VERSION} from "../app/lib/research-bundle.ts";
import {migrateResearchSelectionStore} from "../app/lib/research-selections.ts";
import {CANONICAL_TRACKS,describeCanonicalTracks} from "../app/lib/research-tracks.ts";
import {store,now,referenceOnlyFixture,ts} from "./fixtures/research-selection-store.ts";

/**
 * Economic valuation and outcomes must follow the STRUCTURE, with execution
 * evidence overlaid separately. These tests pin the property that used to be
 * violated: a structurally resolved candidate whose immediate maker and taker
 * evidence are both unavailable still exports its economics.
 */

const parse=(text:string)=>text.trim()?text.trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>):[];

/** A reference-valued structure whose immediate execution is entirely absent. */

test("DECOUPLING: a candidate with no immediate maker or taker evidence still exports its economics",()=>{
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 const economics=parse(bundle.files["structure_economics.jsonl"]);
 const valuations=parse(bundle.files["valuations.jsonl"]);
 const outcomes=parse(bundle.files["outcomes.jsonl"]);

 // Exactly one scenario-independent economic record.
 assert.equal(economics.length,1,"one economic structure record per candidate_id");
 assert.equal(economics[0]!.candidate_id,"deribit~a");

 // A reference valuation path exists despite both execution scenarios failing.
 const referencePath=valuations.filter(r=>r.analytics_track==="reference_fair_value");
 assert.ok(referencePath.length>0,"reference valuation path is exported without any fill evidence");
 assert.ok(referencePath.every(r=>r.execution_scenario===null),"reference economics claim no execution scenario");

 // And the full supported reference outcome set is present.
 const referenceOutcomes=outcomes.filter(r=>r.analytics_track==="reference_fair_value");
 assert.ok(referenceOutcomes.length>0,"reference outcomes exist with no executable rows at all");
 for(const kind of ["vpoc","settlement"])
  assert.ok(referenceOutcomes.some(r=>r.outcome_type===kind),`${kind} is exported on the reference track`);
 // Strict tracks correctly contribute nothing, which is the point: their
 // absence no longer suppresses the economics.
 assert.equal(valuations.filter(r=>String(r.analytics_track).startsWith("strict")).length,0);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
});

test("DECOUPLING: immediate execution availability does not determine whether reference economics exist",()=>{
 const withoutExecution=buildResearchBundle(referenceOnlyFixture(),now);
 const withExecution=buildResearchBundle(migrateResearchSelectionStore(structuredClone(store)),now);
 const referenceOf=(files:Record<string,string>,file:"valuations.jsonl"|"outcomes.jsonl")=>
  parse(files[file]).filter(r=>r.analytics_track==="reference_fair_value").length;
 // The reference track's presence is a property of the reference engine, not
 // of whether anything was fillable.
 assert.ok(referenceOf(withoutExecution.files,"valuations.jsonl")>0);
 assert.ok(referenceOf(withoutExecution.files,"outcomes.jsonl")>0);
 assert.equal(validateResearchBundle(withExecution.files).ok,true);
});

test("SEPARATION: modeled conservative execution is never a relabelled reference entry",()=>{
 const fixture=referenceOnlyFixture();
 const s=fixture.events[0]!.selectedStructures[0]! as Record<string,unknown>;
 const referenceEntry=(s.referenceValuation as Record<string,unknown>).entrySnapshot as Record<string,unknown>;
 (s as Record<string,unknown>).modeledExecution={
  conservative:{status:"evaluated",reason:null,source:"conservative_penalty",modelVersion:"modeled-execution-v5-empirical-taker",
   penaltyBps:25,entryTimestamp:ts,
   // Its OWN opening ledger: a worse net credit than the reference entry.
   entrySnapshot:{...referenceEntry,grossSpreadBtc:.0055,netOpeningCashFlowBtc:.0050},
   outcomeSnapshots:[{label:"Settlement",status:"estimated",decisionTimestamp:ts+7*864e5,valuationTimestamp:ts+7*864e5,estimatedNetPnlBtc:.0025,conversionIndex:102,estimateQuality:"red"}],
   provenance:{executionIndependent:false}},
  expected:{status:"unavailable",reason:"Calibration sample below the promotion threshold.",calibrationCount:3},
 };
 const bundle=buildResearchBundle(fixture,now);
 const economics=parse(bundle.files["structure_economics.jsonl"])[0]!;
 assert.equal(economics.modeled_conservative_status,"evaluated");
 assert.notEqual(economics.modeled_conservative_net_native,economics.net_reference_opening_cash_flow_native,
  "the modeled opening ledger is preserved, not copied from the reference entry");
 const tracks=economics.tracks as {track:string;status:string;entry_basis:string;valuation_basis:string;execution_evidence:string}[];
 const modeled=tracks.find(t=>t.track==="modeled_conservative")!;
 assert.equal(modeled.status,"available");
 assert.equal(modeled.entry_basis,"modeled_opening_ledger","its own ledger");
 assert.equal(modeled.valuation_basis,"reference_marks","valued against reference marks, as persisted");
 assert.equal(modeled.execution_evidence,"modeled_assumption","never observed execution evidence");
 const reference=tracks.find(t=>t.track==="reference_fair_value")!;
 assert.equal(reference.entry_basis,"reference_fair_value_entry");
 assert.equal(reference.execution_evidence,"none_reference_only");
});

test("CALIBRATION: modeled_expected stays unavailable with an explicit reason when calibration is insufficient",()=>{
 const fixture=referenceOnlyFixture();
 const s=fixture.events[0]!.selectedStructures[0]! as Record<string,unknown>;
 s.modeledExecution={expected:{status:"unavailable",reason:"Calibration sample below the promotion threshold.",calibrationCount:3},
  conservative:{status:"unavailable",reason:"Not evaluated."}};
 const bundle=buildResearchBundle(fixture,now);
 const tracks=(parse(bundle.files["structure_economics.jsonl"])[0]!.tracks as {track:string;status:string;reason_code:string;reason:string}[]);
 const expected=tracks.find(t=>t.track==="modeled_expected")!;
 assert.equal(expected.status,"unavailable");
 assert.equal(expected.reason_code,"modeled_calibration_insufficient");
 assert.match(expected.reason,/promotion threshold/i);
 // And no expected path is manufactured to fill the table.
 assert.equal(parse(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="modeled_expected").length,0);
});

test("CONTRACT: every canonical track carries an explicit status, never a silent omission",()=>{
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 const tracks=(parse(bundle.files["structure_economics.jsonl"])[0]!.tracks as {track:string;status:string;reason_code:string}[]);
 assert.deepEqual(tracks.map(t=>t.track),[...CANONICAL_TRACKS],"all seven tracks in canonical order");
 for(const t of tracks)assert.ok(t.status==="available"||t.status==="unavailable");
 // The unavailable ones say why, in stable codes.
 assert.equal(tracks.find(t=>t.track==="strict_maker")!.reason_code,"immediate_execution_unavailable");
 assert.equal(tracks.find(t=>t.track==="strict_taker")!.reason_code,"immediate_execution_not_evaluated");
});

test("CAUSALITY: no valuation point precedes its track's entry or follows expiry",()=>{
 // Defence in depth. The persistence layer refuses to store an out-of-bounds
 // reference point at all, so the guarantee holds before the exporter is
 // reached; the exporter additionally drops anything outside the window.
 const outOfBounds=referenceOnlyFixture();
 const reference=(outOfBounds.events[0]!.selectedStructures[0]! as unknown as Record<string,unknown>).referenceValuation as Record<string,unknown>;
 (reference.valuationPathSnapshot as unknown[]).push({timestamp:ts-36e5,status:"priced",targetIndex:99,estimatedNetPnlBtc:-.05});
 assert.throws(()=>buildResearchBundle(outOfBounds,now),/outside entry-to-expiry bounds/i,
  "a pre-entry reference mark cannot even be persisted");

 // And every point the exporter does emit sits inside its own track window.
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 const economics=parse(bundle.files["structure_economics.jsonl"])[0]!;
 const entry=Date.parse(String(economics.reference_entry_timestamp_utc));
 const expiry=Date.parse(String(economics.expiry_timestamp_utc));
 const rows=parse(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="reference_fair_value");
 assert.ok(rows.length>0);
 for(const r of rows){
  const t=Date.parse(String(r.timestamp_utc));
  assert.ok(t>=entry,`valuation ${r.timestamp_utc} must not precede the track entry`);
  assert.ok(t<=expiry,`valuation ${r.timestamp_utc} must not follow expiry`);
 }
 assert.equal(validateResearchBundle(bundle.files).ok,true);
});
test("CAUSALITY: a delayed track keeps its real delayed opening timestamp and is never backdated",()=>{
 const fixture=referenceOnlyFixture();
 const s=fixture.events[0]!.selectedStructures[0]! as Record<string,unknown>;
 const delayedEntryMs=ts+8*36e5;
 s.delayedExecution={maker:{status:"evaluated",reason:null,source:"observed_delayed_tape",
  entrySnapshot:{valuationTimestamp:delayedEntryMs,targetTimestamp:delayedEntryMs,delayHours:8,
   grossSpreadBtc:.0052,openingFeesBtc:.0004,netOpeningCashFlowBtc:.0048},
  valuationPathSnapshot:[{timestamp:delayedEntryMs,status:"priced",targetIndex:101,estimatedNetPnlBtc:.0009}],
  outcomeSnapshots:[{label:"Settlement",status:"estimated",decisionTimestamp:ts+7*864e5,valuationTimestamp:ts+7*864e5,estimatedNetPnlBtc:.002,conversionIndex:102}],
  provenance:{executionIndependent:false}},
  taker:{status:"not_evaluated",reason:"Not attempted."}};
 const bundle=buildResearchBundle(fixture,now);
 const tracks=(parse(bundle.files["structure_economics.jsonl"])[0]!.tracks as {track:string;status:string;entry_timestamp_utc:string;entry_basis:string}[]);
 const delayed=tracks.find(t=>t.track==="delayed_maker")!;
 assert.equal(delayed.status,"available");
 assert.equal(delayed.entry_basis,"observed_delayed_fill");
 assert.equal(Date.parse(delayed.entry_timestamp_utc),delayedEntryMs,"the real delayed opening timestamp survives");
 const referenceEntry=Date.parse(tracks.find(t=>t.track==="reference_fair_value")!.entry_timestamp_utc);
 assert.ok(Date.parse(delayed.entry_timestamp_utc)>referenceEntry,"never backdated to the reference entry");
 // Its own path point is not dropped for preceding the reference entry.
 const rows=parse(bundle.files["valuations.jsonl"]).filter(r=>r.analytics_track==="delayed_maker");
 assert.equal(rows.length,1);
 assert.equal(Date.parse(String(rows[0]!.timestamp_utc)),delayedEntryMs);
});

test("STRUCTURE: exactly one economic record per candidate ID, with requested and actual geometry preserved",()=>{
 const bundle=buildResearchBundle(migrateResearchSelectionStore(structuredClone(store)),now);
 const economics=parse(bundle.files["structure_economics.jsonl"]);
 const candidates=parse(bundle.files["candidates.jsonl"]);
 const ids=economics.map(r=>String(r.candidate_id));
 assert.equal(new Set(ids).size,ids.length,"never duplicated once for maker and once for taker");
 // candidates.jsonl still carries one row per (structure, scenario)...
 assert.ok(candidates.length>economics.length,"execution rows overlay the economic record");
 // ...and every structure has exactly one economic record.
 assert.deepEqual([...new Set(candidates.map(r=>String(r.candidate_id)))].sort(),[...ids].sort());
 for(const r of economics){
  assert.ok("requested_short_strike" in r&&"actual_short_strike" in r);
  assert.ok("requested_long_strike" in r&&"actual_long_strike" in r);
  assert.ok("requested_width" in r&&"actual_width" in r);
  assert.equal(typeof r.width_substituted,"boolean");
 }
});

test("PAYOFF: maximum economic loss states its units, reference index and method, and is never called margin",()=>{
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 const economics=parse(bundle.files["structure_economics.jsonl"])[0]!;
 assert.deepEqual(economics.maximum_structural_loss_units,{native:"BTC",quote:"USD",sign_convention:"positive_magnitude"});
 if(economics.maximum_structural_loss_native!==null){
  assert.notEqual(economics.maximum_structural_loss_reference_index,null,"the USD conversion states its index");
  assert.match(String(economics.maximum_structural_loss_method),/inverse-option expiry payoff/i);
  assert.match(String(economics.maximum_structural_loss_assumption),/not an unconditional terminal BTC loss/i,
   "the BTC figure is not presented as unconditional");
 }else assert.notEqual(economics.maximum_structural_loss_unavailable_reason,null,"an absent payoff says why");
 // The protective long's premium plus fees is never presented as margin.
 for(const key of Object.keys(economics))assert.ok(!/margin|required_balance/i.test(key),
  `structure economics must not name a capital requirement (${key}); margin lives in margin_scenarios.jsonl`);
});

test("VOLATILITY: per-leg IV and provenance survive export without changing execution quality",()=>{
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 const point=parse(bundle.files["valuations.jsonl"]).find(r=>r.analytics_track==="reference_fair_value"
  &&(r.short_leg_volatility as Record<string,unknown>).iv_decimal!==null)!;
 const short=point.short_leg_volatility as Record<string,unknown>,long=point.long_leg_volatility as Record<string,unknown>;
 assert.equal(short.iv_decimal,.55);
 assert.equal(short.iv_api_percentage,55);
 assert.equal(short.iv_units,"decimal");
 assert.equal(short.observation,"observed","a locally observed anchor is recorded as observed");
 assert.equal(long.observation,"reconstructed","a constant-entry-IV anchor is reconstructed, not observed");
 assert.notEqual(short.iv_source_timestamp_utc,null);
 // No spread-level IV is synthesised, and IV never upgrades execution evidence.
 assert.ok(!Object.keys(point).some(k=>/spread_iv|spread_volatility/i.test(k)));
 assert.equal(point.execution_evidence,"none_reference_only");
});

test("VERSIONING: the schema is bumped and old execution-gated bundles are not reinterpreted",()=>{
 assert.equal(RESEARCH_BUNDLE_SCHEMA_VERSION,"4.0.0");
 const bundle=buildResearchBundle(referenceOnlyFixture(),now);
 // A bundle claiming the previous version is rejected rather than silently
 // read as if its execution-gated rows were the new canonical economics.
 const stale={...bundle.files,"run.json":bundle.files["run.json"].replace('"4.0.0"','"3.6.0"')};
 assert.equal(validateResearchBundle(stale).ok,false);
 // Dropping the new table is a hard failure, not a silent downgrade.
 const withoutTable={...bundle.files,"structure_economics.jsonl":""};
 assert.equal(validateResearchBundle(withoutTable).ok,false);
});

test("TRACKS: the descriptor layer reports availability from each engine's own snapshot",()=>{
 const s=referenceOnlyFixture().events[0]!.selectedStructures[0]! as unknown as Record<string,unknown>;
 const tracks=describeCanonicalTracks(s);
 assert.deepEqual(tracks.map(t=>t.track),[...CANONICAL_TRACKS]);
 assert.equal(tracks.find(t=>t.track==="reference_fair_value")!.status,"available");
 assert.equal(tracks.find(t=>t.track==="strict_maker")!.status,"unavailable");
 assert.equal(tracks.find(t=>t.track==="delayed_taker")!.status,"unavailable");
 // A structure with no reference valuation at all yields an unavailable
 // reference track rather than throwing or inventing one.
 const bare=describeCanonicalTracks({});
 assert.equal(bare.find(t=>t.track==="reference_fair_value")!.status,"unavailable");
 assert.equal(bare.find(t=>t.track==="modeled_conservative")!.status,"unavailable");
});
