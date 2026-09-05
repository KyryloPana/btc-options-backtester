import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {contractGenerationKey,researchStateDirtiness} from "../app/lib/research-state.ts";
import {diagnoseMethodologyStaleness} from "../app/lib/configuration-identity.ts";
import {buildResearchBundle,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {ResearchSelectionService} from "../scripts/research-selection-service.ts";
import {store as baseStore} from "./fixtures/research-selection-store.ts";
import {modelHistoricalEvidenceWindows} from "../app/lib/research-valuation.ts";
import {EXECUTION_TIMING_METADATA} from "../app/lib/execution-policy.ts";
import type {GenerationSnapshot,ResearchSelectionEvent} from "../app/lib/research-selections.ts";

const newer="2026-08-23T12:00:00.000Z";
test("contract generation health identity changes with event, request geometry, or runtime configuration",()=>{
 const ts=Date.parse(newer);
 const request={requestId:"credit-7-1000-96000",targetDte:7,minDte:5,maxDte:9,soldStrike:96000,boughtStrike:97000,optionType:"C" as const};
 const a=contractGenerationKey("event-a",ts,[request],{executionMode:"maker"});
 assert.notEqual(a,contractGenerationKey("event-b",ts,[request],{executionMode:"maker"}));
 assert.notEqual(a,contractGenerationKey("event-a",ts,[{...request,boughtStrike:98000}],{executionMode:"maker"}));
 assert.notEqual(a,contractGenerationKey("event-a",ts,[request],{executionMode:"taker"}));
 assert.equal(a,contractGenerationKey("event-a",ts,[request],{executionMode:"maker"}));
});
test("core request and generation-health modules have no Short-Strike dependency",async()=>{
 const state=await readFile(new URL("../app/lib/research-state.ts",import.meta.url),"utf8"),requests=await readFile(new URL("../app/lib/history-requests.ts",import.meta.url),"utf8");
 assert.doesNotMatch(state,/short-strike/);assert.doesNotMatch(requests,/short-strike/);
});
function staleAndCurrent(empty:boolean){
 const current=structuredClone(baseStore.events[0]!.generationSnapshot);
 current.generatedAtUtc=newer;current.configuration={...current.configuration,generatedAtUtc:newer,historicalEvidenceWindows:modelHistoricalEvidenceWindows(),synchronizationThresholds:structuredClone(EXECUTION_TIMING_METADATA)};
 current.candidates=[{...current.candidates.at(-1)!,selected:false,status:"unavailable",availabilityReasons:["contracts unavailable in current generation"],entryQuality:null}];
 current.underlyingHourlyPath=[];delete current.futuresMarket;
 const stale=structuredClone(current);stale.generatedAtUtc="2025-01-01T00:00:00.000Z";stale.configuration={...stale.configuration,generatedAtUtc:stale.generatedAtUtc,historicalEvidenceWindows:{entryMinutes:[120]},synchronizationThresholds:{immediateFillSearchWindowsMs:[1]}};
 const selected=empty?[]:structuredClone(baseStore.events[0]!.selectedStructures.slice(0,1));
 return {stale,current,event:{...structuredClone(baseStore.events[0]!),generationSnapshot:stale,selectedStructures:selected} as ResearchSelectionEvent};
}

test("zero-selection generation refresh remains an event and clears strict methodology staleness",async()=>{
 const {stale,current,event}=staleAndCurrent(true),dir=await mkdtemp(join(tmpdir(),"research-state-")),service=new ResearchSelectionService(dir);
 try{
  const fixture=structuredClone(baseStore);fixture.events=[event,{...structuredClone(baseStore.events[1]!),generationSnapshot:{...structuredClone(baseStore.events[1]!.generationSnapshot),configuration:current.configuration}}];
  const initial=await service.save(fixture.datasetId,fixture);
  assert.equal(diagnoseMethodologyStaleness(fixture.events.map(e=>({eventId:e.eventId,configuration:e.generationSnapshot.configuration}))).compatible,false);
  const dirty=researchStateDirtiness({eventId:event.eventId,savedSelectionIds:[],draftSelectionIds:[],savedGeneration:stale,completedGeneration:{eventId:event.eventId,snapshot:current}});
  assert.deepEqual({selectionDirty:dirty.selectionDirty,generationDirty:dirty.generationDirty,researchStateDirty:dirty.researchStateDirty},{selectionDirty:false,generationDirty:true,researchStateDirty:true});
  const saved=await service.upsertEvent(fixture.datasetId,event.eventId,{...event,generationSnapshot:current,selectedStructures:[]},initial.updatedAtUtc);
  assert.equal(saved.events[0]!.selectedStructures.length,0);assert.equal(saved.events.length,2);
  assert.equal(saved.events[0]!.generationSnapshot.generatedAtUtc,newer);
  assert.deepEqual(saved.events[0]!.generationSnapshot.configuration.historicalEvidenceWindows,{entryMinutes:[720]},"zero-valued and zero-selected generations persist the declared model horizon");
  assert.equal(diagnoseMethodologyStaleness(saved.events.map(e=>({eventId:e.eventId,configuration:e.generationSnapshot.configuration}))).compatible,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("unchanged non-empty IDs can refresh generation while an exact no-op cannot",()=>{
 const {stale,current,event}=staleAndCurrent(false),ids=event.selectedStructures.map(s=>s.candidateId);
 const refresh=researchStateDirtiness({eventId:event.eventId,savedSelectionIds:ids,draftSelectionIds:ids,savedGeneration:stale,completedGeneration:{eventId:event.eventId,snapshot:current}});
 assert.equal(refresh.selectionDirty,false);assert.equal(refresh.generationDirty,true);
 const noOp=researchStateDirtiness({eventId:event.eventId,savedSelectionIds:ids,draftSelectionIds:ids,savedGeneration:current,completedGeneration:{eventId:event.eventId,snapshot:current}});
 assert.equal(noOp.researchStateDirty,false);
});

test("metadata-only provenance laundering is not accepted as a completed regeneration",()=>{
 const {stale,current,event}=staleAndCurrent(true);
 const relabeled={...stale,configuration:current.configuration} as GenerationSnapshot;
 const dirty=researchStateDirtiness({eventId:event.eventId,savedSelectionIds:[],draftSelectionIds:[],savedGeneration:stale,completedGeneration:{eventId:event.eventId,snapshot:relabeled}});
 assert.equal(dirty.generationDirty,false,"the unchanged generation timestamp proves no new run completed");
});

test("unavailable-only denominator exports after genuine refresh while stale zero-selection blocks",()=>{
 const {current,event}=staleAndCurrent(true),fixture=structuredClone(baseStore);
 fixture.events=[event,{...structuredClone(baseStore.events[1]!),generationSnapshot:{...structuredClone(baseStore.events[1]!.generationSnapshot),configuration:current.configuration}}];
 assert.throws(()=>buildResearchBundle(fixture,newer),/Incompatible research methodologies/);
 fixture.events[0]={...event,generationSnapshot:current,selectedStructures:[]};
 const bundle=buildResearchBundle(fixture,newer),availability=bundle.files["availability.jsonl"].trim().split("\n").map(JSON.parse).filter(row=>row.event_id===event.eventId);
 assert.equal(availability.length,1);assert.equal(availability[0].status,"unavailable");
 assert.equal(bundle.files["valuations.jsonl"].split("\n").filter(line=>line.includes(`\"event_id\":\"${event.eventId}\"`)).length,0);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
});
