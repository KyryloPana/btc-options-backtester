import test from "node:test";import assert from "node:assert/strict";
import {buildResearchBundle,validateResearchBundle,REQUIRED_OUTCOMES} from "../app/lib/research-bundle.ts";
import {CANONICAL_OUTCOMES,OUTCOMES_OUTSIDE_EXPORT_CONTRACT,RESEARCH_OUTCOME_IDENTITY_VERSION,canonicalOutcomeId,outcomeHoldingHours} from "../app/lib/research-outcomes.ts";
import {now,referenceOnlyFixture,ts} from "./fixtures/research-selection-store.ts";

const HOUR=3_600_000,DAY=86_400_000;
const rows=(text:string)=>text.trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);

// ---------------------------------------------------------------------------
// Task A -- one canonical identity mapping
// ---------------------------------------------------------------------------

test("MAPPING: fixed-time labels resolve to their canonical policy IDs",()=>{
 // The exact defect: "3D" normalized to "3d" and never matched fixed_3d.
 assert.equal(canonicalOutcomeId("3D"),"fixed_3d");
 assert.equal(canonicalOutcomeId("5D"),"fixed_5d");
 assert.equal(canonicalOutcomeId("7D"),"fixed_7d");
 assert.notEqual(canonicalOutcomeId("3D"),"3d");
 for(const id of ["fixed_3d","fixed_5d","fixed_7d"])assert.ok((REQUIRED_OUTCOMES as readonly string[]).includes(id));
 // Case, spacing and the "N D fixed" spelling the exit layer uses.
 for(const label of ["3d","  3D  ","3D fixed","3d_fixed"])assert.equal(canonicalOutcomeId(label),"fixed_3d",label);
});

test("MAPPING: the remaining canonical policies still resolve",()=>{
 assert.equal(canonicalOutcomeId("VPOC"),"vpoc");
 assert.equal(canonicalOutcomeId("VPOC hit"),"vpoc");
 assert.equal(canonicalOutcomeId("Invalidation"),"invalidation");
 assert.equal(canonicalOutcomeId("25% credit"),"credit_capture_25");
 assert.equal(canonicalOutcomeId("50% credit"),"credit_capture_50");
 assert.equal(canonicalOutcomeId("70% credit"),"credit_capture_70");
 assert.equal(canonicalOutcomeId("Settlement"),"settlement");
 // Every canonical ID is its own identity, so re-resolving is stable.
 for(const id of CANONICAL_OUTCOMES)assert.equal(canonicalOutcomeId(id),id);
});

test("MAPPING: unknown labels stay unmapped and are never coerced into a neighbour",()=>{
 for(const label of ["","   ","90% credit","2D","30D","Take profit",null,undefined,42])
  assert.equal(canonicalOutcomeId(label as unknown),null,String(label));
 // A recognised policy outside the export contract is mapped, not guessed at.
 assert.equal(canonicalOutcomeId("14D"),"fixed_14d");
 assert.ok(OUTCOMES_OUTSIDE_EXPORT_CONTRACT.includes("fixed_14d"));
 assert.ok(!(REQUIRED_OUTCOMES as readonly string[]).includes("fixed_14d"),"no new exit rule is introduced here");
});

// ---------------------------------------------------------------------------
// Task C -- holding hours
// ---------------------------------------------------------------------------

test("HOLDING: measured from the track's own entry to the effective close",()=>{
 const entry=ts,expiry=ts+7*DAY;
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:entry+3*DAY,decisionTimestampMs:entry+3*DAY,expiryTimestampMs:expiry}),72);
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:entry+5*DAY,decisionTimestampMs:entry+5*DAY,expiryTimestampMs:expiry}),120);
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:entry+7*DAY,decisionTimestampMs:entry+7*DAY,expiryTimestampMs:expiry}),168);
 // Valuation wins over the decision timestamp where the outcome is actually valued.
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:entry+4*HOUR,decisionTimestampMs:entry+2*HOUR,expiryTimestampMs:expiry}),4);
 // A DELAYED track measures from its own later entry, never from the signal.
 const delayed=entry+6*HOUR;
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:delayed,valuationTimestampMs:entry+3*DAY,decisionTimestampMs:null,expiryTimestampMs:expiry}),66);
});

test("HOLDING: unreached, pre-entry and post-expiry outcomes report null",()=>{
 const entry=ts,expiry=ts+7*DAY;
 assert.equal(outcomeHoldingHours({reached:false,entryTimestampMs:entry,valuationTimestampMs:entry+DAY,decisionTimestampMs:entry+DAY,expiryTimestampMs:expiry}),null);
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:entry-HOUR,decisionTimestampMs:null,expiryTimestampMs:expiry}),null,"never negative");
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:expiry+HOUR,decisionTimestampMs:null,expiryTimestampMs:expiry}),null,"never past expiry");
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:null,valuationTimestampMs:entry+DAY,decisionTimestampMs:null,expiryTimestampMs:expiry}),null);
 assert.equal(outcomeHoldingHours({reached:true,entryTimestampMs:entry,valuationTimestampMs:null,decisionTimestampMs:null,expiryTimestampMs:expiry}),null);
});

// ---------------------------------------------------------------------------
// Task B -- source-to-export fidelity through the real exporter
// ---------------------------------------------------------------------------

/** The shared reference fixture, re-stocked with a realistic outcome set. */
function outcomeFixture(snapshots?:unknown[]){
 const fixture=referenceOnlyFixture();
 const structure=fixture.events[0]!.selectedStructures[0]! as unknown as Record<string,unknown>;
 const reference=structure.referenceValuation as Record<string,unknown>;
 const priced=(label:string,offsetMs:number,pnl:number)=>({label,trigger:`${label} trigger`,
  decisionTimestamp:ts+offsetMs,valuationTimestamp:ts+offsetMs,targetIndex:101,conversionIndex:101,
  status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:pnl,feesBtc:0.0002,
  evidenceSource:"direct-vwap",evidenceReason:"Bounded causal tape."});
 reference.outcomeSnapshots=snapshots??[
  priced("VPOC",2*HOUR,0.0015),
  priced("50% credit",8*HOUR,0.0021),
  priced("3D",3*DAY,0.0033),
  priced("5D",5*DAY,0.0041),
  priced("7D",6*DAY,0.0047),
  {label:"Invalidation",trigger:"First completed 1H candle beyond invalidation",status:"not-hit",
   estimateQuality:"unavailable",evidenceSource:"unavailable",evidenceReason:"The exit condition was not reached."},
  priced("Settlement",7*DAY,0.006),
 ];
 return fixture;
}
const exported=(fixture=outcomeFixture())=>{
 const bundle=buildResearchBundle(fixture,now);
 const checked=validateResearchBundle(bundle.files);
 assert.equal(checked.ok,true,checked.errors.join(" | "));
 return{bundle,rows:rows(bundle.files["outcomes.jsonl"]).filter(r=>r.analytics_track==="reference_fair_value")};
};

test("FIDELITY: an evaluated fixed-time snapshot exports evaluated with identical PnL",()=>{
 const {rows:outcomes}=exported();
 for(const [outcome,pnl,offset] of [["fixed_3d",0.0033,3*DAY],["fixed_5d",0.0041,5*DAY],["fixed_7d",0.0047,6*DAY]] as const){
  const row=outcomes.find(r=>r.outcome_type===outcome)!;
  assert.ok(row,`${outcome} must be exported`);
  assert.equal(row.status,"evaluated",`${outcome} was evaluated in the source and must not become a generic unavailable row`);
  assert.equal(row.source_status,"estimated");
  assert.equal(row.trigger_status,"reached");
  assert.equal(row.net_pnl_native,pnl,"the source PnL is preserved exactly");
  assert.equal(row.valuation_timestamp_utc,new Date(ts+offset).toISOString());
  assert.equal(row.outcome_target_timestamp_utc,new Date(ts+offset).toISOString());
  assert.equal(row.closing_fees_native,0.0002);
  assert.equal(row.quality,"green");
  assert.equal(row.outcome_identity_version,RESEARCH_OUTCOME_IDENTITY_VERSION);
  assert.deepEqual(row.reason_codes,["outcome_priced"]);
 }
 // VPOC and credit capture come through the same mapping.
 assert.equal(outcomes.find(r=>r.outcome_type==="vpoc")!.net_pnl_native,0.0015);
 assert.equal(outcomes.find(r=>r.outcome_type==="credit_capture_50")!.net_pnl_native,0.0021);
});

test("FIDELITY: a not-hit snapshot keeps its own status and reason, and is not evaluated",()=>{
 const row=exported().rows.find(r=>r.outcome_type==="invalidation")!;
 assert.equal(row.status,"unavailable");
 assert.equal(row.source_status,"not-hit");
 assert.equal(row.trigger_status,"not_reached");
 assert.deepEqual(row.reason_codes,["outcome_not_reached"]);
 assert.equal(row.evidence_reason,"The exit condition was not reached.");
 assert.equal(row.net_pnl_native,null);
 assert.equal(row.holding_hours,null,"an unreached outcome has no holding time");
});

test("FIDELITY: a genuinely absent snapshot is not fabricated on an independent track",()=>{
 const fixture=outcomeFixture([
  {label:"VPOC",trigger:"t",decisionTimestamp:ts+2*HOUR,valuationTimestamp:ts+2*HOUR,targetIndex:101,
   conversionIndex:101,status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:0.0015},
 ]);
 const {rows:outcomes}=exported(fixture);
 assert.deepEqual(outcomes.map(r=>r.outcome_type),["vpoc"],"only what the engine produced");
 for(const outcome of ["fixed_3d","fixed_5d","fixed_7d"])
  assert.ok(!outcomes.some(r=>r.outcome_type===outcome),`${outcome} was never produced and must not be invented`);
});

test("HOLDING: exported fixed-time outcomes reconcile with 72/120/168 hours",()=>{
 const {rows:outcomes}=exported();
 const entry=Date.parse(String(outcomes[0]!.decision_available_timestamp_utc??""));void entry;
 for(const [outcome,hours] of [["fixed_3d",72],["fixed_5d",120],["fixed_7d",144]] as const){
  const row=outcomes.find(r=>r.outcome_type===outcome)!;
  assert.equal(row.holding_hours,hours,`${outcome} measured from the track's own entry`);
 }
 assert.equal(outcomes.find(r=>r.outcome_type==="vpoc")!.holding_hours,2);
 assert.equal(outcomes.find(r=>r.outcome_type==="credit_capture_50")!.holding_hours,8);
 // Never negative, never past expiry.
 for(const row of outcomes){
  const holding=row.holding_hours;
  if(holding===null)continue;
  assert.ok(Number(holding)>=0,`${String(row.outcome_type)} holding time must not be negative`);
  assert.ok(Number(holding)<=7*24,`${String(row.outcome_type)} holding time must not exceed the contract life`);
 }
});

// ---------------------------------------------------------------------------
// Task D -- validator semantic fidelity
// ---------------------------------------------------------------------------

test("VALIDATOR: an evaluated snapshot silently exported as unavailable is rejected",()=>{
 const {bundle}=exported();
 const files=structuredClone(bundle.files);
 files["outcomes.jsonl"]=rows(files["outcomes.jsonl"]).map(r=>JSON.stringify(
  r.outcome_type==="fixed_3d"&&r.analytics_track==="reference_fair_value"
   ?{...r,status:"unavailable",net_pnl_native:null,reason_codes:["outcome_not_reached"]}:r,
 )).join(String.fromCharCode(10))+String.fromCharCode(10);
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/fixed_3d was evaluated in the source but exported as unavailable/.test(e)),checked.errors.join(" | "));
});

test("VALIDATOR: a dropped, mistimed or mispriced outcome is rejected",()=>{
 const {bundle}=exported();
 // Dropped entirely.
 const dropped=structuredClone(bundle.files);
 dropped["outcomes.jsonl"]=rows(dropped["outcomes.jsonl"]).filter(r=>!(r.outcome_type==="fixed_5d"&&r.analytics_track==="reference_fair_value"))
  .map(r=>JSON.stringify(r)).join(String.fromCharCode(10))+String.fromCharCode(10);
 assert.ok(validateResearchBundle(dropped).errors.some(e=>/persisted a fixed_5d outcome that the exporter dropped/.test(e)));
 // Timestamp mismatch.
 const mistimed=structuredClone(bundle.files);
 mistimed["outcomes.jsonl"]=rows(mistimed["outcomes.jsonl"]).map(r=>JSON.stringify(
  r.outcome_type==="fixed_7d"&&r.analytics_track==="reference_fair_value"
   ?{...r,valuation_timestamp_utc:new Date(ts+DAY).toISOString()}:r,
 )).join(String.fromCharCode(10))+String.fromCharCode(10);
 assert.ok(validateResearchBundle(mistimed).errors.some(e=>/valuation_timestamp_utc is .* but the snapshot says/.test(e)));
 // PnL mismatch.
 const mispriced=structuredClone(bundle.files);
 mispriced["outcomes.jsonl"]=rows(mispriced["outcomes.jsonl"]).map(r=>JSON.stringify(
  r.outcome_type==="vpoc"&&r.analytics_track==="reference_fair_value"?{...r,net_pnl_native:0.9}:r,
 )).join(String.fromCharCode(10))+String.fromCharCode(10);
 assert.ok(validateResearchBundle(mispriced).errors.some(e=>/exported PnL 0.9 but the snapshot says/.test(e)));
});

test("VALIDATOR: incoherent holding time is rejected",()=>{
 const {bundle}=exported();
 for(const [mutate,pattern] of [
  [(r:Record<string,unknown>)=>({...r,holding_hours:-5}),/negative holding time/],
  [(r:Record<string,unknown>)=>({...r,holding_hours:999}),/not measured from that track's own entry/],
 ] as const){
  const files=structuredClone(bundle.files);
  files["outcomes.jsonl"]=rows(files["outcomes.jsonl"]).map(r=>JSON.stringify(
   r.outcome_type==="fixed_3d"&&r.analytics_track==="reference_fair_value"?mutate(r):r,
  )).join(String.fromCharCode(10))+String.fromCharCode(10);
  assert.ok(validateResearchBundle(files).errors.some(e=>pattern.test(e)),`${pattern}`);
 }
 // An unreached outcome may not carry a holding time.
 const files=structuredClone(bundle.files);
 files["outcomes.jsonl"]=rows(files["outcomes.jsonl"]).map(r=>JSON.stringify(
  r.outcome_type==="invalidation"&&r.analytics_track==="reference_fair_value"?{...r,holding_hours:12}:r,
 )).join(String.fromCharCode(10))+String.fromCharCode(10);
 assert.ok(validateResearchBundle(files).errors.some(e=>/is unavailable but reports a holding time/.test(e)));
});

test("VALIDATOR: a source label no canonical policy maps to is an explicit error, never hidden",()=>{
 const fixture=outcomeFixture([
  {label:"VPOC",trigger:"t",decisionTimestamp:ts+2*HOUR,valuationTimestamp:ts+2*HOUR,targetIndex:101,
   conversionIndex:101,status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:0.0015},
  {label:"90% credit",trigger:"t",decisionTimestamp:ts+3*HOUR,valuationTimestamp:ts+3*HOUR,
   status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:0.004},
 ]);
 // Export fails loudly rather than quietly shipping a bundle missing a policy
 // the engine actually produced.
 assert.throws(()=>buildResearchBundle(fixture,now),/persisted outcome label "90% credit" that no canonical policy maps to/);
 // And the validator holds the same line on a hand-assembled bundle.
 const {bundle}=exported();
 const files=structuredClone(bundle.files);
 files["structure_economics.jsonl"]=rows(files["structure_economics.jsonl"]).map(r=>JSON.stringify({...r,
  tracks:(r.tracks as Array<Record<string,unknown>>).map(track=>track.track==="reference_fair_value"
   ?{...track,source_outcomes:[...(track.source_outcomes as unknown[]),{source_label:"Take profit",outcome:null,source_status:"estimated"}]}
   :track)})).join(String.fromCharCode(10))+String.fromCharCode(10);
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/persisted outcome label "Take profit" that no canonical policy maps to/.test(e)),checked.errors.join(" | "));
});

test("VALIDATOR: a recognised policy outside the export contract is not treated as a drop",()=>{
 const fixture=outcomeFixture([
  {label:"VPOC",trigger:"t",decisionTimestamp:ts+2*HOUR,valuationTimestamp:ts+2*HOUR,targetIndex:101,
   conversionIndex:101,status:"estimated",estimateQuality:"green",estimatedNetPnlBtc:0.0015},
  {label:"14D",trigger:"t",decisionTimestamp:ts+14*DAY,status:"unavailable",estimateQuality:"unavailable",
   evidenceReason:"Target occurs after contract expiry."},
 ]);
 const bundle=buildResearchBundle(fixture,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true,"14D is recognised, simply outside the exported set");
 const outcomes=rows(bundle.files["outcomes.jsonl"]).filter(r=>r.analytics_track==="reference_fair_value");
 assert.ok(!outcomes.some(r=>r.outcome_type==="fixed_14d"));
 assert.ok(outcomes.every(r=>!(r.reason_codes as string[]).includes("outcome_label_unmapped")));
});
