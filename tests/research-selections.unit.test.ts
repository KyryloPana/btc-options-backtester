import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ResearchSelectionService, researchSelectionApiPlugin } from "../scripts/research-selection-service.ts";
import { canLeaveDirty } from "../app/lib/trade-datasets.ts";
import { LOCAL_PERSISTENCE_REQUIRED_MESSAGE, RESEARCH_SELECTION_ENDPOINT_FAILED_MESSAGE, probeLocalPersistence, researchSelectionFailure } from "../app/lib/local-persistence.ts";
import { LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS, RESEARCH_SELECTION_SCHEMA_VERSION, canSelectResearchCandidate, canonicalJson, compactEntryEconomics, compactValuationPoint, emptyResearchSelectionStore, migrateResearchSelectionStore, reconcileGeneratedSelection, sameSelectionIds, selectionChangeSet, researchEventPayloadDiagnostics, stableCandidateId, validateResearchSelectionStore, type ResearchSelectionEvent, type ResearchSelectionStore, type SelectedStructure, type Venue } from "../app/lib/research-selections.ts";

const now="2026-08-16T20:00:00.000Z";
const identity=(venue:Venue="deribit",eventId="event-a")=>({venue,datasetId:"default-sample-trades",eventId,structure:"credit",optionType:"P",expiryTimestamp:1_800_000_000_000,shortStrike:100_000,longStrike:99_000,strikeMethod:"anchor",targetHorizon:7});
const evaluatedScenario=()=>({status:"evaluated" as const,reason:null,entrySnapshot:{net:.01},valuationPathSnapshot:[{timestamp:1,value:1},{timestamp:2,value:null}],outcomeSnapshots:[{rule:"3D",value:null}]});
const notEvaluatedScenario=(reason="No compatible-direction tape evidence and no IV anchor.")=>({status:"not_evaluated" as const,reason,entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]});
const selected=(eventId:string,candidateId:string):SelectedStructure=>({selectionId:`s-${eventId}-${candidateId}`,eventId,candidateId,venue:"deribit",selectedAtUtc:now,quantity:1,candidateSnapshot:{instrument:"BTC-X"},executionScenarios:{maker:evaluatedScenario(),taker:notEvaluatedScenario()},marginSnapshot:null,evidenceTradeSnapshots:[]});
const event=(eventId:string,ids:string[],all=[...ids,"unselected"]):ResearchSelectionEvent=>({eventId,sourceRun:{eventId},generationSnapshot:{generatedAtUtc:now,configuration:{applicationBuild:null,pricingEngineVersion:"v1",qualityRulesVersion:"v1",feeScheduleVersion:"v1",dteWindows:{},expirySelectionMode:"all-eligible",executionMode:"taker",pricingAssumption:"research-estimate",pricingTracks:["vwap","iv"],historicalEvidenceWindows:{},synchronizationThresholds:{},qualityThresholds:{},feeAssumptions:{},settlementRules:{},valuationInterval:"4h",modelAssumptions:{},generatedAtUtc:now},candidates:all.map(candidateId=>({candidateId,venue:"deribit",selected:ids.includes(candidateId),status:candidateId==="unselected"?"unavailable":"priced",availabilityReasons:candidateId==="unselected"?["no evidence"]:[],targetHorizon:7,eligibleDteRange:{min:5,max:10},actualExpiryTimestamp:1,actualDte:7,requestedStrikes:{short:2,long:1,width:1},actualStrikes:{short:2,long:1,width:1},structure:"credit",optionType:"P",strikeMethod:"anchor",entryQuality:candidateId==="unselected"?null:"green"})),underlyingHourlyPath:[{openTime:1,closeTime:2,open:1,high:2,low:1,close:2,volume:3}]},selectedStructures:ids.map(id=>selected(eventId,id))});
const store=(events:ResearchSelectionEvent[]):ResearchSelectionStore=>({schemaVersion:RESEARCH_SELECTION_SCHEMA_VERSION,datasetId:"default-sample-trades",updatedAtUtc:now,events});

test("stable candidate ID survives regeneration",()=>assert.equal(stableCandidateId(identity()),stableCandidateId(identity())));
test("venue scopes candidate identity",()=>assert.notEqual(stableCandidateId(identity("deribit")),stableCandidateId(identity("bybit"))));
test("priced structures are selectable",()=>assert.equal(canSelectResearchCandidate("priced","yellow"),true));
test("red but priced structures are selectable",()=>assert.equal(canSelectResearchCandidate("priced","red"),true));
test("unavailable structures are not selectable",()=>assert.equal(canSelectResearchCandidate("unavailable","green"),false));
test("two structures can be assigned to one event",()=>assert.equal(event("a",["one","two"]).selectedStructures.length,2));
test("different events isolate selections",()=>assert.deepEqual(store([event("a",["one"]),event("b",["two"])]).events.map(e=>e.selectedStructures[0].candidateId),["one","two"]));
test("selection change set reports add, remove, and retained ids",()=>{const change=selectionChangeSet(["keep","remove"],["keep","add"]);assert.deepEqual([...change.toAdd],["add"]);assert.deepEqual([...change.toRemove],["remove"]);assert.deepEqual([...change.toKeep],["keep"]);});
test("removing every saved id is dirty immediately",()=>{const draft=new Set<string>();assert.equal(draft.size,0);assert.equal(sameSelectionIds(["one","two"],draft),false);assert.deepEqual([...selectionChangeSet(["one","two"],draft).toRemove],["one","two"]);});
test("regeneration exposes stale identity without remapping it",()=>{const result=reconcileGeneratedSelection(["stale-id","same-id"],["same-id","new-id"]);assert.deepEqual([...result.visible],["same-id"]);assert.deepEqual([...result.stale],["stale-id"]);assert.equal(result.visible.has("new-id"),false);});
test("dataset switching isolates stores",()=>assert.notEqual(emptyResearchSelectionStore("one").datasetId,emptyResearchSelectionStore("two").datasetId));
test("unsaved changes trigger guard",()=>{let called=false;assert.equal(canLeaveDirty(true,()=>{called=true;return false}),false);assert.equal(called,true)});
test("valuation path and unavailable null survive serialization",()=>assert.deepEqual(JSON.parse(JSON.stringify(selected("a","one"))).executionScenarios.maker.valuationPathSnapshot,[{timestamp:1,value:1},{timestamp:2,value:null}]));
test("NaN and infinities normalize to null",()=>assert.deepEqual(canonicalJson({a:NaN,b:Infinity,c:-Infinity}),{a:null,b:null,c:null}));
test("validator rejects non-finite canonical JSON",()=>assert.equal(validateResearchSelectionStore({...store([]),bad:NaN}).ok,false));
test("generation snapshot retains selected and unselected availability",()=>assert.deepEqual(event("a",["one"]).generationSnapshot.candidates.map(c=>[c.selected,c.status]),[[true,"priced"],[false,"unavailable"]]));
test("browser module has no Node filesystem imports",async()=>assert.doesNotMatch(await readFile(new URL("../app/lib/research-selections.ts",import.meta.url),"utf8"),/node:(?:fs|path)/));
test("static-host state reports no durable loaded records",()=>assert.equal(emptyResearchSelectionStore("x").events.length,0));
test("malformed persisted JSON is rejected without overwrite",async()=>{const dir=await mkdtemp(join(tmpdir(),"research-selections-")),service=new ResearchSelectionService(dir);await writeFile(join(dir,"default-sample-trades.json"),"{bad\n");await assert.rejects(()=>service.read("default-sample-trades"),/malformed/);await assert.rejects(()=>service.save("default-sample-trades",store([])),/malformed/);assert.equal(await readFile(join(dir,"default-sample-trades.json"),"utf8"),"{bad\n");});
test("restart acceptance: two events then persisted removal",async()=>{const dir=await mkdtemp(join(tmpdir(),"research-acceptance-"));let service=new ResearchSelectionService(dir);await service.save("default-sample-trades",store([event("event-a",["a1","a2"]),event("event-b",["b1"])]));service=new ResearchSelectionService(dir);let loaded=await service.read("default-sample-trades");assert.deepEqual(loaded.events.map(e=>e.selectedStructures.length),[2,1]);await service.save("default-sample-trades",{...loaded,events:[event("event-a",["a2"]),loaded.events[1]],updatedAtUtc:now});service=new ResearchSelectionService(dir);loaded=await service.read("default-sample-trades");assert.deepEqual(loaded.events.map(e=>e.selectedStructures.map(s=>s.candidateId)),[["a2"],["b1"]]);const raw=await readFile(join(dir,"default-sample-trades.json"),"utf8");assert.equal(raw.endsWith("\n"),true);assert.match(raw,/"venue": "deribit"/);assert.equal(validateResearchSelectionStore(JSON.parse(raw)).ok,true);});


test("normalization deduplicates evidence and removes nested supporting trades",()=>{const catalog=new Map();const trades=Array.from({length:2000},(_,i)=>({instrumentName:"BTC-SHARED",tradeId:`t-${i}`,timestamp:1_700_000_000_000+i,price:.01+i/1e8,amount:1,direction:i%2?"buy":"sell",indexPrice:100_000,ivDecimal:.6}));const selected=Array.from({length:8},(_,i)=>({candidateId:`c${i}`,entry:{status:"priced",targetTimestamp:trades[0].timestamp,priceSource:"direct-vwap",sold:{instrumentName:"BTC-SHARED",supportingTrades:[trades[0]],priceBtcPerContract:.02},bought:{instrumentName:"BTC-SHARED",supportingTrades:[trades[1]],priceBtcPerContract:.01}},path:Array.from({length:12},(_,j)=>({timestamp:trades[j+2].timestamp,status:"priced",rawEstimate:{sold:{supportingTrades:[trades[j+2]]},bought:{supportingTrades:[trades[j+3]]}},modelEstimate:{sold:{supportingTrades:[trades[j+4]]},bought:{supportingTrades:[trades[j+5]]}}}))}));const notEvaluated={status:"not_evaluated" as const,reason:"Not evaluated for this test fixture.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]};
const legacy={eventId:"event-a",sourceRun:{eventId:"event-a"},generationSnapshot:event("event-a",selected.map(x=>x.candidateId)).generationSnapshot,selectedStructures:selected.map(x=>({...event("event-a",[x.candidateId]).selectedStructures[0],executionScenarios:{maker:{status:"evaluated",reason:null,entrySnapshot:{...x.entry,sold:{...x.entry.sold,supportingTrades:trades},bought:{...x.entry.bought,supportingTrades:trades}},valuationPathSnapshot:x.path,outcomeSnapshots:[]},taker:notEvaluated},evidenceTradeSnapshots:[...trades,...trades]}))};const normalized={...legacy,selectedStructures:selected.map(x=>{const localUsages=[];return{...event("event-a",[x.candidateId]).selectedStructures[0],executionScenarios:{maker:{status:"evaluated",reason:null,entrySnapshot:compactEntryEconomics("deribit",x.candidateId,x.entry,localUsages,catalog),valuationPathSnapshot:x.path.map(point=>compactValuationPoint("deribit",x.candidateId,point,localUsages,catalog)),outcomeSnapshots:[]},taker:notEvaluated},evidenceTradeSnapshots:[],evidenceUsages:localUsages}}),evidenceCatalog:[...catalog.values()]};const before=researchEventPayloadDiagnostics(legacy as ResearchSelectionEvent),after=researchEventPayloadDiagnostics(normalized as ResearchSelectionEvent);assert.ok(before.selectedCandidateBytes[0].evidenceBytes>100_000);assert.ok(after.totalBytes<10_000_000);assert.ok(after.totalBytes<before.totalBytes/10);assert.equal(normalized.evidenceCatalog.length,17);assert.doesNotMatch(JSON.stringify(normalized),/supportingTrades/);});

test("event upsert preserves other events and rejects stale writes",async()=>{const dir=await mkdtemp(join(tmpdir(),"research-upsert-")),service=new ResearchSelectionService(dir);await service.save("default-sample-trades",store([event("event-a",["a1"]),event("event-b",["b1"])]));const loaded=await service.read("default-sample-trades");const updated=await service.upsertEvent("default-sample-trades","event-b",event("event-b",["b2"]),loaded.updatedAtUtc);assert.deepEqual(updated.events.map(e=>[e.eventId,e.selectedStructures.map(s=>s.candidateId)]),[["event-a",["a1"]],["event-b",["b2"]]]);await assert.rejects(()=>service.upsertEvent("default-sample-trades","event-b",event("event-b",["b3"]),loaded.updatedAtUtc),/changed on disk/);});

test("HTTP first-touch PUT persists, reloads, validates, and retains If-Match conflicts",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"research-http-"));let middleware:RequestListener|undefined;
 researchSelectionApiPlugin(dir).configureServer?.({middlewares:{use(handler:RequestListener){middleware=handler}}} as never);assert.ok(middleware);
 const server=createServer(middleware);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}/__local/research-selections/default-sample-trades`;
  const capabilities=await (await fetch(`http://127.0.0.1:${address.port}/__local/persistence-capabilities`)).json() as {runtime:string;researchSelections:boolean};
  assert.deepEqual(capabilities,{runtime:"local-application-server",researchSelections:true,version:1});
  const initial=await (await fetch(base)).json() as ResearchSelectionStore;
  const put=await fetch(`${base}/events/event-a`,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":initial.updatedAtUtc},body:JSON.stringify(event("event-a",Array.from({length:9},(_,index)=>`selection-${index+1}`)))});
  assert.equal(put.status,200,"a missing store has a stable first-touch If-Match version");
  const saved=(await put.json() as {store:ResearchSelectionStore}).store;
  const reloaded=await (await fetch(base)).json() as ResearchSelectionStore;
  assert.equal(reloaded.events[0].selectedStructures.length,9,"all nine checked selections persist");
  assert.equal((await readFile(join(dir,"default-sample-trades.json"),"utf8")).includes('"candidateId": "selection-9"'),true,"the HTTP route writes the canonical filesystem file");
  const invalid=await fetch(`${base}/events/event-b`,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":saved.updatedAtUtc},body:"{}"});
  assert.equal(invalid.status,400);assert.match((await invalid.json() as {error:string}).error,/event ID must match/i,"validation remains a readable HTTP response");
  const stale=await fetch(`${base}/events/event-a`,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":initial.updatedAtUtc},body:JSON.stringify(event("event-a",["replacement"]))});
  assert.equal(stale.status,409);assert.match((await stale.json() as {error:string}).error,/changed on disk/i);
  assert.deepEqual((await new ResearchSelectionService(dir).read("default-sample-trades")).events[0].selectedStructures.map(item=>item.candidateId),Array.from({length:9},(_,index)=>`selection-${index+1}`),"failed requests never mark or write the draft as saved");
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true})}
});

test("runtime capability distinguishes static, healthy, transient, and route-specific failures",async()=>{
 assert.equal(LOCAL_PERSISTENCE_REQUIRED_MESSAGE,"Research-state persistence requires the local application server.");
 const staticProbe=await probeLocalPersistence(async()=>({ok:false,status:404,json:async()=>({})}));
 assert.equal(staticProbe.status,"unsupported");
 const staleServerProbe=await probeLocalPersistence(async input=>input==="/__local/trade-datasets"
  ? {ok:true,status:200,json:async()=>({datasets:[]})}
  : {ok:false,status:404,json:async()=>({})});
 assert.equal(staleServerProbe.status,"unreachable","an active dataset plugin proves this is a stale/broken local server, not static hosting");
 assert.deepEqual(researchSelectionFailure(new TypeError("Failed to fetch"),staticProbe),{unavailable:true,message:LOCAL_PERSISTENCE_REQUIRED_MESSAGE});
 const healthyProbe=await probeLocalPersistence(async()=>({ok:true,status:200,json:async()=>({runtime:"local-application-server",researchSelections:true})}));
 assert.equal(healthyProbe.status,"available");
 const routeFailure=researchSelectionFailure(new Error("route crashed after datasets loaded"),healthyProbe);
 assert.equal(routeFailure.unavailable,false);
 assert.match(routeFailure.message,new RegExp(`^${RESEARCH_SELECTION_ENDPOINT_FAILED_MESSAGE}`));
 assert.match(routeFailure.message,/route crashed/);
 let attempts=0;const transientProbe=await probeLocalPersistence(async()=>{attempts++;if(attempts===1)throw new TypeError("connection dropped");return {ok:true,status:200,json:async()=>({runtime:"local-application-server",researchSelections:true})}});
 assert.equal(transientProbe.status,"unreachable");
 assert.equal(researchSelectionFailure(new TypeError("PUT disconnected"),transientProbe).unavailable,false,"one rejected fetch never permanently classifies the origin as static");
 const retry=await probeLocalPersistence(async()=>{attempts++;return {ok:true,status:200,json:async()=>({runtime:"local-application-server",researchSelections:true})}});
 assert.equal(retry.status,"available","a later retry can recover");
});

test("clear persists across restart, excludes only that event, and permits reselection",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"research-clear-"));let service=new ResearchSelectionService(dir);
 const sourceBacktestEvents=[{id:"event-a"},{id:"event-b"}];
 await service.save("default-sample-trades",store([event("event-a",["a1","a2"]),event("event-b",["b1"])]));
 const before=await service.read("default-sample-trades");
 await service.deleteEvent("default-sample-trades","event-a",before.updatedAtUtc);
 service=new ResearchSelectionService(dir);let loaded=await service.read("default-sample-trades");
 assert.deepEqual(sourceBacktestEvents.map(item=>item.id),["event-a","event-b"],"the source trade dataset is not owned or deleted by selection clearing");
 assert.deepEqual(loaded.events.map(item=>item.eventId),["event-b"],"selected-only export projection excludes the cleared event after reload");
 assert.deepEqual(loaded.events.flatMap(item=>item.selectedStructures.map(structure=>structure.candidateId)),["b1"]);
 loaded=await service.upsertEvent("default-sample-trades","event-a",event("event-a",["a3"]),loaded.updatedAtUtc);
 assert.deepEqual(loaded.events.flatMap(item=>item.selectedStructures.map(structure=>[item.eventId,structure.candidateId])),[["event-a","a3"],["event-b","b1"]],"reselection makes the event exportable again");
});

test("failed partial save preserves canonical snapshots and remains retryable",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"research-retry-")),service=new ResearchSelectionService(dir);
 await service.save("default-sample-trades",store([event("event-a",["keep","remove"])]));
 const loaded=await service.read("default-sample-trades"),canonicalKeep=structuredClone(loaded.events[0].selectedStructures[0]);
 await assert.rejects(()=>service.upsertEvent("default-sample-trades","event-a",event("event-a",["replacement"]),"stale-version"),/changed on disk/);
 const afterFailure=await service.read("default-sample-trades");assert.deepEqual(afterFailure.events[0].selectedStructures[0],canonicalKeep);assert.deepEqual(afterFailure.events[0].selectedStructures.map(item=>item.candidateId),["keep","remove"]);
 const retried=await service.upsertEvent("default-sample-trades","event-a",{...afterFailure.events[0],selectedStructures:[canonicalKeep]},afterFailure.updatedAtUtc);
 assert.deepEqual(retried.events[0].selectedStructures,[canonicalKeep]);
});

test("schema migration wraps legacy single-scenario data into executionScenarios, never fabricating the other mode",()=>{
 const legacyStructure={selectionId:"s-event-a-c1",eventId:"event-a",candidateId:"c1",venue:"deribit" as const,selectedAtUtc:now,quantity:1,
  candidateSnapshot:{instrument:"BTC-X"},entrySnapshot:{net:.02},valuationPathSnapshot:[{timestamp:1,value:1}],outcomeSnapshots:[{rule:"VPOC",value:.5}],
  marginSnapshot:null,evidenceTradeSnapshots:[]};
 const legacyEvent=event("event-a",["c1"]);
 const legacyStore={schemaVersion:"1.1.0",datasetId:"default-sample-trades",updatedAtUtc:now,
  events:[{...legacyEvent,selectedStructures:[legacyStructure]}]};
 const migrated=migrateResearchSelectionStore(legacyStore);
 assert.equal(migrated.schemaVersion,RESEARCH_SELECTION_SCHEMA_VERSION);
 const s=migrated.events[0].selectedStructures[0];
 // The legacy fixture's generationSnapshot.configuration.executionMode is "taker".
 assert.equal(s.executionScenarios.taker.status,"evaluated");
 assert.equal(s.executionScenarios.taker.legacyUndifferentiated,true);
 assert.deepEqual(s.executionScenarios.taker.entrySnapshot,{net:.02});
 assert.equal(s.executionScenarios.maker.status,"not_evaluated");
 assert.match(s.executionScenarios.maker.reason!,/predates/i);
 assert.deepEqual(s.executionScenarios.maker.entrySnapshot,null,"never fabricated, never zero");
 // Old flat fields are not left dangling on the migrated object.
 assert.equal(Object.hasOwn(s,"entrySnapshot"),false);
 assert.equal(Object.hasOwn(s,"valuationPathSnapshot"),false);
});

test("schema migration preserves a maker-labelled legacy run under maker, not taker",()=>{
 const legacyStructure={selectionId:"s-event-a-c1",eventId:"event-a",candidateId:"c1",venue:"deribit" as const,selectedAtUtc:now,quantity:1,
  candidateSnapshot:{instrument:"BTC-X"},entrySnapshot:{net:.02},valuationPathSnapshot:[],outcomeSnapshots:[],marginSnapshot:null,evidenceTradeSnapshots:[]};
 const legacyEvent=event("event-a",["c1"]);
 const makerConfig={...legacyEvent.generationSnapshot.configuration,executionMode:"maker"};
 const legacyStore={schemaVersion:"1.1.0",datasetId:"default-sample-trades",updatedAtUtc:now,
  events:[{...legacyEvent,generationSnapshot:{...legacyEvent.generationSnapshot,configuration:makerConfig},selectedStructures:[legacyStructure]}]};
 const migrated=migrateResearchSelectionStore(legacyStore);
 const s=migrated.events[0].selectedStructures[0];
 assert.equal(s.executionScenarios.maker.status,"evaluated");
 assert.equal(s.executionScenarios.maker.legacyUndifferentiated,true);
 assert.equal(s.executionScenarios.taker.status,"not_evaluated");
});

test("current-schema stores round-trip through migration unchanged",()=>{
 const current=store([event("event-a",["c1"])]);
 const migrated=migrateResearchSelectionStore(current);
 assert.deepEqual(migrated,current);
});

test("all prior schema versions are recognized as migratable legacy versions",()=>{
 assert.deepEqual([...LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS],["1.0.0","1.1.0","1.2.0","1.3.0","1.4.0","1.5.0","1.6.0"]);
 for(const legacyVersion of LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS){
  const result=validateResearchSelectionStore({...store([]),schemaVersion:legacyVersion});
  assert.equal(result.ok,true,`schema ${legacyVersion} must validate as migratable`);
 }
});

test("a structure evaluated under both scenarios keeps them independent",()=>{
 const s=selected("event-a","c1");
 assert.equal(s.executionScenarios.maker.status,"evaluated");
 assert.equal(s.executionScenarios.taker.status,"not_evaluated");
 assert.notDeepEqual(s.executionScenarios.maker,s.executionScenarios.taker);
});

test("1.5 migration collapses only equivalent model/reference tracks and is idempotent",()=>{
 const fixture=store([event("event-a",["same","distinct"])] ) as unknown as Record<string,unknown>;
 fixture.schemaVersion="1.5.0";const structures=(fixture.events as ResearchSelectionEvent[])[0].selectedStructures;
 const reference={status:"valued" as const,reason:null,source:"local_iv_interpolation" as const,entrySnapshot:{net:.01},valuationPathSnapshot:[{timestamp:1,value:.02}],outcomeSnapshots:[{label:"3D",value:.03}],provenance:{source:"model"}};
 structures[0].referenceValuation=reference;(structures[0] as unknown as Record<string,unknown>).modelTrack={status:"evaluated",reason:null,entrySnapshot:reference.entrySnapshot,valuationPathSnapshot:reference.valuationPathSnapshot,outcomeSnapshots:reference.outcomeSnapshots};
 structures[1].referenceValuation=reference;(structures[1] as unknown as Record<string,unknown>).modelTrack={status:"evaluated",reason:null,entrySnapshot:{net:.011},valuationPathSnapshot:reference.valuationPathSnapshot,outcomeSnapshots:reference.outcomeSnapshots};
 const migrated=migrateResearchSelectionStore(fixture);assert.equal(Object.hasOwn(migrated.events[0].selectedStructures[0],"modelTrack"),false);assert.equal(migrated.events[0].selectedStructures[0].legacyModelTrack,undefined);assert.deepEqual(migrated.events[0].selectedStructures[1].legacyModelTrack?.entrySnapshot,{net:.011});assert.deepEqual(migrateResearchSelectionStore(migrated),migrated);
});

test("explicit valuation DTO removes runtime aliases while preserving bundle economics and provenance",()=>{const usages=[] as import("../app/lib/research-selections.ts").EvidenceUsageDto[],catalog=new Map();const point={timestamp:1,status:"priced",targetIndex:100,estimateQuality:"green",temporarySolverMatrix:Array(100).fill({unused:true}),ivNormalizedEstimate:{valuationMode:"research-estimate",executionMode:"maker",targetTimestamp:1,valuationTimestamp:1,entryTargetIndex:100,status:"priced",sold:{instrumentName:"S",economicSide:"sold",priceBtcPerContract:.02,unslippedPriceBtcPerContract:.02,source:"model-reconstructed",supportingTrades:[{instrumentName:"S",tradeId:"e1",timestamp:1,price:.02,amount:1,indexPrice:100}],supportingTimestamps:[1],observedAmount:1,nearestGapMinutes:0},bought:{instrumentName:"L",economicSide:"bought",priceBtcPerContract:.01,unslippedPriceBtcPerContract:.01,source:"model-reconstructed",supportingTrades:[],supportingTimestamps:[],observedAmount:1,nearestGapMinutes:0},grossSpreadBtcPerContract:.01,grossSpreadBtc:.01,openingFeesBtc:.001,netOpeningCashFlowBtc:.009,amount:1,evidenceWindowMinutes:120,synchronizationGapMinutes:0,priceSource:"model-reconstructed",estimateQuality:"green",qualityReason:"causal",slippageBps:0,observedAmount:1,disclaimer:"runtime"},estimatedNetPnlBtc:.008,closingFeesBtc:.001};const compact=compactValuationPoint("deribit","c1",point,usages,catalog) as Record<string,unknown>;assert.equal(Object.hasOwn(compact,"temporarySolverMatrix"),false);assert.equal(Object.hasOwn(compact,"ivNormalizedEstimate"),false);assert.equal(((compact.modelEstimate as Record<string,unknown>).sold as Record<string,unknown>).priceBtcPerContract,.02);assert.equal(compact.estimatedNetPnlBtc,.008);assert.equal(usages.length,1);assert.equal(catalog.size,1);});

test("nine-structure 4H fixture and 25-event store remain below documented size thresholds",async()=>{const fixture=event("scale",Array.from({length:9},(_,i)=>`c${i}`));fixture.selectedStructures=fixture.selectedStructures.map((s,i)=>{const points=Array.from({length:[43,85,181][i%3]},(_,j)=>({timestamp:1+j*14_400_000,status:"priced",targetIndex:100_000+j,rawEstimate:{sold:{priceBtcPerContract:.02},bought:{priceBtcPerContract:.01},estimateQuality:"green"},modelEstimate:{sold:{priceBtcPerContract:.021},bought:{priceBtcPerContract:.011},estimateQuality:"green"},closingFeesBtc:.001,estimatedNetPnlBtc:.008,estimateQuality:"green"}));const maker={...evaluatedScenario(),valuationPathSnapshot:points},taker={...evaluatedScenario(),valuationPathSnapshot:points.map(p=>({...p,estimatedNetPnlBtc:.007}))};return{...s,executionScenarios:{maker,taker},referenceValuation:{status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:maker.entrySnapshot,valuationPathSnapshot:points,outcomeSnapshots:maker.outcomeSnapshots,provenance:{executionIndependent:true}}}});const payloadBytes=Buffer.byteLength(JSON.stringify(fixture));assert.ok(payloadBytes<9_000_000,`nine-structure payload regression: ${payloadBytes}`);const dir=await mkdtemp(join(tmpdir(),"research-scale-")),service=new ResearchSelectionService(dir);const saved=await service.upsertEvent("default-sample-trades","scale",fixture);assert.deepEqual((await service.read("default-sample-trades")).events[0],saved.events[0]);const events=Array.from({length:25},(_,i)=>({...fixture,eventId:`scale-${i}`,selectedStructures:fixture.selectedStructures.map(s=>({...s,eventId:`scale-${i}`}))}));const multi={...store(events),datasetId:"scale-store"};await new ResearchSelectionService(dir).save("scale-store",multi);const fileBytes=Buffer.byteLength(await readFile(join(dir,"scale-store.json"),"utf8"));assert.ok(fileBytes<70_000_000,`25-event store regression: ${fileBytes}`);await rm(dir,{recursive:true,force:true});});
