import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_RESEARCH_ENGINE_VERSIONS, diagnoseDerivedStaleness, recomputeSelectedResearch, type DerivedResearchOutput } from "../app/lib/research-refresh.ts";
import type { ResearchSelectionStore, SelectedStructure } from "../app/lib/research-selections.ts";
const placeholder="Schema placeholder only; no search or modeled execution was performed.";
const structure=(eventId:string,candidateId:string):SelectedStructure=>({selectionId:`s-${candidateId}`,eventId,candidateId,venue:"deribit",selectedAtUtc:"2026-08-20T00:00:00.000Z",quantity:2,strategyVariantId:candidateId,candidateSnapshot:{expiryTimestamp:2,requestedStrikes:{short:60000,long:59000},actualStrikes:{short:60000,long:59000},instruments:{short:"BTC-S",long:"BTC-L"}},contractResolution:{status:"exact_resolved",reason:null,short:{instrumentName:"BTC-S",creationTimestamp:1,expirationTimestamp:2,strike:60000,optionType:"put",contractSize:1,source:"fixture",retrievedAtUtc:null,authoritative:true},long:{instrumentName:"BTC-L",creationTimestamp:1,expirationTimestamp:2,strike:59000,optionType:"put",contractSize:1,source:"fixture",retrievedAtUtc:null,authoritative:true}},referenceValuation:{status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:{grossSpreadBtc:.1},valuationPathSnapshot:[],outcomeSnapshots:[],provenance:{}},executionScenarios:{maker:{status:"unavailable",reason:"Attempted: no synchronized two-leg tape.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},taker:{status:"unavailable",reason:"Attempted: no synchronized two-leg tape.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}},delayedExecution:{status:"not_evaluated",reason:placeholder},modeledExecution:{expected:{status:"not_evaluated",reason:placeholder},conservative:{status:"not_evaluated",reason:placeholder}},marginSnapshot:{status:"unavailable",reason:"not calculated"}});
const store=():ResearchSelectionStore=>({schemaVersion:"1.7.0",datasetId:"fixture",updatedAtUtc:"2026-08-20T00:00:00.000Z",events:["e1","e2"].map(eventId=>({eventId,sourceRun:{event:{id:eventId}},generationSnapshot:{generatedAtUtc:"2026-08-20T00:00:00.000Z",configuration:{} as never,candidates:[],underlyingHourlyPath:[]},selectedStructures:[structure(eventId,`${eventId}-a`),structure(eventId,`${eventId}-b`)]}))});
const output=(s:SelectedStructure):DerivedResearchOutput=>({executionScenarios:s.executionScenarios,referenceValuation:s.referenceValuation,delayedExecution:{status:"unavailable",reason:"Evaluated: no qualifying causal window."},modeledExecution:{expected:{status:"unavailable",reason:"Evaluated: calibration evidence insufficient."},conservative:{status:"unavailable",reason:"Evaluated: calibration evidence insufficient."}},marginSnapshot:s.marginSnapshot,versions:{...CURRENT_RESEARCH_ENGINE_VERSIONS}});
test("placeholder is stale while versioned evaluated unavailable is current",()=>{const legacy=structure("e","c");assert.equal(diagnoseDerivedStaleness(legacy).stale,true);const evaluated={...legacy,...output(legacy),derivedVersions:output(legacy).versions} as SelectedStructure;assert.equal(diagnoseDerivedStaleness(evaluated).stale,false)});
test("v3 modeled execution snapshots are stale under v4",()=>{const saved=structure("e","c"),current=output(saved);saved.derivedVersions={...current.versions,modeledExecution:"modeled-execution-v3-empirical-taker"};assert.deepEqual(diagnoseDerivedStaleness(saved).layers.modeledExecution,["engine_version"]);assert.equal(CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution,"modeled-execution-v4-empirical-taker")});
test("legacy margin engine-not-run placeholder is stale but attempted unavailable is current",()=>{const legacy=structure("e","c");legacy.marginSnapshot={status:"unavailable",reason:"No margin result was produced."};legacy.derivedVersions=output(legacy).versions;assert.deepEqual(diagnoseDerivedStaleness(legacy).layers.margin,["placeholder_snapshot"]);legacy.marginSnapshot={status:"unavailable",reason:"A causal positive BTC index price is required.",reasonCode:"margin_missing_index",engineVersion:"deribit-standard-margin-v2"};assert.equal(diagnoseDerivedStaleness(legacy).layers.margin,undefined)});
test("one structure refresh preserves structural identity and exact contracts",async()=>{const before=store(),original=structuredClone(before.events[0]!.selectedStructures[0]!);const result=await recomputeSelectedResearch(before,{kind:"structure",eventId:"e1",candidateId:"e1-a"},async({structure:s})=>output(s),"2026-08-22T00:00:00.000Z"),after=result.store.events[0]!.selectedStructures[0]!;for(const key of ["selectionId","eventId","candidateId","strategyVariantId","venue","selectedAtUtc","quantity","candidateSnapshot","contractResolution"] as const)assert.deepEqual(after[key],original[key]);assert.equal(result.refreshed,1);assert.equal((after.delayedExecution as {status:string}).status,"unavailable")});
test("event and all scopes refresh deterministic counts",async()=>{assert.equal((await recomputeSelectedResearch(store(),{kind:"event",eventId:"e1"},async({structure:s})=>output(s))).refreshed,2);assert.equal((await recomputeSelectedResearch(store(),{kind:"all"},async({structure:s})=>output(s))).refreshed,4)});
test("failed recompute cannot mutate previous state",async()=>{const before=store(),bytes=JSON.stringify(before);await assert.rejects(recomputeSelectedResearch(before,{kind:"all"},async({structure:s})=>{if(s.candidateId==="e2-a")throw new Error("engine failed");return output(s)}),/engine failed/);assert.equal(JSON.stringify(before),bytes)});

/* ------- REGRESSION: the promoted methodology is a new identity ------- */

test("a structure priced under causal-reference-v1 is stale, not silently reinterpreted", () => {
  // The hybrid changes the economics, so an older structure must be reported as
  // needing regeneration rather than being read as if it had used the new
  // estimator. This is what keeps historical bundles honest about their own
  // provenance.
  const current = structure("e", "c");
  const onCurrent = {...current, ...output(current), derivedVersions: output(current).versions} as SelectedStructure;
  assert.equal(diagnoseDerivedStaleness(onCurrent).stale, false);

  const onLegacy = {...onCurrent, derivedVersions: {...output(current).versions,
    referenceValuation: "causal-reference-v1"}} as SelectedStructure;
  const diagnosis = diagnoseDerivedStaleness(onLegacy);
  assert.equal(diagnosis.stale, true);
  assert.deepEqual(diagnosis.layers.referenceValuation, ["engine_version_mismatch"]);
  assert.equal(CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation, "causal-reference-v3-expiry-forward-hybrid/repricing-v2");
  const buggyV3={...onCurrent,derivedVersions:{...output(current).versions,referenceValuation:"causal-reference-v3-expiry-forward-hybrid"}} as SelectedStructure;
  assert.deepEqual(diagnoseDerivedStaleness(buggyV3).layers.referenceValuation,["engine_version_mismatch"]);
});
