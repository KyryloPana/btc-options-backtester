import test from "node:test";
import assert from "node:assert/strict";
import type {BacktestEvent} from "../app/lib/backtester.ts";
import {validateTradeDataset,type TradeDataset} from "../app/lib/trade-datasets.ts";
import {
 buildResearchBundle,validateResearchBundle,
} from "../app/lib/research-bundle.ts";
import {
 deleteResearchSelectionEvent,renameResearchSelectionEvent,stableCandidateId,stableSelectionId,
 validateResearchSelectionStore,type ResearchSelectionEvent,type ResearchSelectionStore,type SelectedStructure,
} from "../app/lib/research-selections.ts";

/**
 * Event editing and deletion across the two stores that own an event: the trade
 * dataset (the canonical JSON the user edits and exports) and the research
 * selection store (which owns every derived research record for that event).
 */

const DATASET_ID="lifecycle-ds";

/** Every JSON-backed field on the canonical event model, populated. */
const fullEvent:BacktestEvent={
 id:"mr-01",label:"MR-01 · 2024-01-27",direction:"long",
 entryDate:"2024-01-27",entryPrice:41800,
 entryTimestamp:Date.UTC(2024,0,27,9),entryTimeSource:"resolved",
 exitDate:"2024-03-05",exitPrice:59200,exitTimestamp:Date.UTC(2024,2,5,12),
 extremePrice:38500,vpocPrice:43710,vpocDate:"2024-01-30",vpocTimestamp:Date.UTC(2024,0,30,8),
 invalidationPrice:38500,rangeLow:38000,rangeHigh:44000,notes:"Trail upward into new range",
};
const otherEvent:BacktestEvent={id:"mr-02",label:"MR-02",direction:"short",entryDate:"2024-05-04",entryPrice:63700,invalidationPrice:66000};

const dataset=(trades:BacktestEvent[]):TradeDataset=>({schemaVersion:1,datasetId:DATASET_ID,name:"Lifecycle",updatedAt:"2026-08-19T00:00:00.000Z",trades});

/** The full set of keys the canonical model serializes, for exhaustiveness. */
const CANONICAL_FIELDS=["id","label","direction","entryDate","entryPrice","entryTimestamp","entryTimeSource",
 "exitDate","exitPrice","exitTimestamp","extremePrice","vpocPrice","vpocDate","vpocTimestamp",
 "invalidationPrice","rangeLow","rangeHigh","notes"] as const;

function candidateId(eventId:string,shortStrike=40000){
 return stableCandidateId({venue:"deribit",datasetId:DATASET_ID,eventId,structure:"bull_put_credit",optionType:"P",
  expiryTimestamp:Date.UTC(2024,1,2),shortStrike,longStrike:shortStrike-1000,strikeMethod:"anchor",targetHorizon:7});
}

function structure(eventId:string,shortStrike=40000):SelectedStructure{
 const id=candidateId(eventId,shortStrike);
 const scenario=(status:"evaluated"|"not_evaluated")=>({status,reason:status==="evaluated"?null:"No compatible tape.",
  entrySnapshot:status==="evaluated"?{targetTimestamp:Date.UTC(2024,0,27,9),valuationTimestamp:Date.UTC(2024,0,27,9),amount:1}:null,
  // An evaluated scenario must carry both pricing tracks for the bundle to be
  // complete; one in-window point emits a raw_vwap and an iv_normalized row.
  valuationPathSnapshot:status==="evaluated"
   ?[{timestamp:Date.UTC(2024,0,28),status:"priced",targetIndex:42000,estimateQuality:"green",estimatedNetPnlBtc:.001}]
   :[],
  outcomeSnapshots:[]});
 return {
  selectionId:stableSelectionId(eventId,"deribit",id),eventId,candidateId:id,venue:"deribit",
  selectedAtUtc:"2026-08-19T00:00:00.000Z",quantity:1,
  candidateSnapshot:{structure:"bull_put_credit",spreadKind:"bull_put_credit",optionType:"P",
   expiryTimestamp:Date.UTC(2024,1,2),actualDte:6,targetDte:7,strikeMethod:"anchor",
   shortStrike,longStrike:shortStrike-1000,actualWidth:1000},
  executionScenarios:{maker:scenario("evaluated"),taker:scenario("not_evaluated")},
  marginSnapshot:{status:"unavailable"},evidenceTradeSnapshots:[],
  evidenceUsages:[{evidenceId:"evidence~deribit~x~1",candidateId:id,role:"entry-pricing",valuationTimestamp:null,pricingTrack:null,leg:"short",executionScenario:"maker"}],
 };
}

function selectionEvent(eventId:string,structures=1):ResearchSelectionEvent{
 return {
  eventId,
  sourceRun:{event:{id:eventId,label:"MR",direction:"long",entryDate:"2024-01-27",entryPrice:41800},savedAtUtc:"2026-08-19T00:00:00.000Z"},
  generationSnapshot:{
   generatedAtUtc:"2026-08-19T00:00:00.000Z",
   configuration:{applicationBuild:null,pricingEngineVersion:"v1",qualityRulesVersion:"v1",feeScheduleVersion:"v1",
    dteWindows:{},expirySelectionMode:"nearest",executionMode:"maker",pricingAssumption:"research-estimate",pricingTracks:["raw_vwap"],
    historicalEvidenceWindows:{},synchronizationThresholds:{},qualityThresholds:{},feeAssumptions:{},settlementRules:{},
    valuationInterval:"4h",modelAssumptions:{},generatedAtUtc:"2026-08-19T00:00:00.000Z"},
   candidates:Array.from({length:structures},(_,i)=>({candidateId:candidateId(eventId,40000+i*1000),venue:"deribit" as const,selected:true,
    status:"priced" as const,availabilityReasons:[],targetHorizon:7,eligibleDteRange:{min:5,max:10},
    actualExpiryTimestamp:Date.UTC(2024,1,2),actualDte:6,requestedStrikes:{short:40000+i*1000,long:39000+i*1000,width:1000},
    actualStrikes:{short:40000+i*1000,long:39000+i*1000,width:1000},structure:"bull_put_credit",optionType:"P",
    strikeMethod:"anchor",entryQuality:"green" as const})),
   underlyingHourlyPath:[],
  },
  selectedStructures:Array.from({length:structures},(_,i)=>structure(eventId,40000+i*1000)),
  evidenceCatalog:[{evidenceId:"evidence~deribit~x~1",venue:"deribit",instrument:"BTC-2FEB24-40000-P",tradeId:"t1",
   timestamp:Date.UTC(2024,0,27,9),direction:"buy",price:.01,amount:1,indexPrice:41800,ivApiPercent:50,ivDecimal:.5,blockTradeId:null,rfqId:null}],
 };
}

const store=(events:ResearchSelectionEvent[]):ResearchSelectionStore=>({schemaVersion:"1.3.0",datasetId:DATASET_ID,updatedAtUtc:"2026-08-19T00:00:00.000Z",events});

/* ---------------- editing ---------------- */

test("EDIT: every canonical JSON-backed field round-trips through validation and export",()=>{
 const checked=validateTradeDataset(dataset([fullEvent]));
 assert.equal(checked.ok,true);
 const exported=JSON.parse(JSON.stringify((checked as {ok:true;dataset:TradeDataset}).dataset));
 for(const field of CANONICAL_FIELDS)
  assert.deepEqual(exported.trades[0][field],fullEvent[field],`${field} must survive validation and JSON export`);
});

test("EDIT: a text field change is what the exported JSON contains",()=>{
 const edited={...fullEvent,label:"MR-01 · renamed",notes:"Second attempt"};
 const checked=validateTradeDataset(dataset([edited]));
 assert.equal(checked.ok,true);
 const out=JSON.parse(JSON.stringify(dataset([edited])));
 assert.equal(out.trades[0].label,"MR-01 · renamed");
 assert.equal(out.trades[0].notes,"Second attempt");
});

test("EDIT: numeric, enum and timestamp fields keep their types",()=>{
 const edited:BacktestEvent={...fullEvent,entryPrice:42250.5,direction:"short",entryTimeSource:"manual",
  vpocTimestamp:Date.UTC(2024,0,31,4),exitTimestamp:Date.UTC(2024,2,6,1)};
 const checked=validateTradeDataset(dataset([edited]));
 assert.equal(checked.ok,true,JSON.stringify(checked));
 const out=JSON.parse(JSON.stringify(dataset([edited])));
 assert.equal(typeof out.trades[0].entryPrice,"number");
 assert.equal(out.trades[0].direction,"short");
 assert.equal(out.trades[0].entryTimeSource,"manual");
 assert.equal(out.trades[0].vpocTimestamp,Date.UTC(2024,0,31,4));
 assert.equal(out.trades[0].exitTimestamp,Date.UTC(2024,2,6,1));
});

test("EDIT: optional fields stay representable as absent, not coerced to zero",()=>{
 const cleared:BacktestEvent={id:"mr-01",label:"Minimal",direction:"long",entryDate:"2024-01-27",entryPrice:41800};
 const checked=validateTradeDataset(dataset([cleared]));
 assert.equal(checked.ok,true);
 const out=JSON.parse(JSON.stringify(dataset([cleared])));
 for(const field of ["exitPrice","vpocPrice","rangeLow","notes","entryTimeSource","vpocTimestamp","exitTimestamp"])
  assert.equal(field in out.trades[0],false,`${field} must be absent rather than a fabricated value`);
});

test("EDIT: an invalid edit is rejected rather than silently persisted",()=>{
 const bad=validateTradeDataset(dataset([{...fullEvent,entryTimeSource:"guessed" as BacktestEvent["entryTimeSource"]}]));
 assert.equal(bad.ok,false);
 const badTimestamp=validateTradeDataset(dataset([{...fullEvent,exitTimestamp:fullEvent.entryTimestamp!-1}]));
 assert.equal(badTimestamp.ok,false,"exit cannot precede first touch");
});

test("EDIT: edits survive a save/reload round trip through the canonical validator",()=>{
 const edited={...fullEvent,label:"Reloaded",rangeHigh:44500};
 const serialized=JSON.stringify(dataset([edited,otherEvent]));
 const reloaded=validateTradeDataset(JSON.parse(serialized));
 assert.equal(reloaded.ok,true);
 const trades=(reloaded as {ok:true;dataset:TradeDataset}).dataset.trades;
 assert.equal(trades[0]!.label,"Reloaded");
 assert.equal(trades[0]!.rangeHigh,44500);
 assert.equal(trades[1]!.id,"mr-02","an unrelated event is untouched");
});

/* ---------------- identity ---------------- */

test("IDENTITY: renaming an event repoints every derived reference",()=>{
 const before=store([selectionEvent("mr-01"),selectionEvent("mr-02")]);
 const after=renameResearchSelectionEvent(before,"mr-01","mr-01-revised");
 const renamed=after.events.find(e=>e.eventId==="mr-01-revised")!;
 assert.ok(renamed,"the event itself is renamed");
 assert.equal(after.events.some(e=>e.eventId==="mr-01"),false,"no record keeps the old identity");
 for(const s of renamed.selectedStructures){
  assert.equal(s.eventId,"mr-01-revised");
  assert.ok(s.candidateId.includes("mr-01-revised"),"candidate id carries the new event id");
  assert.equal(s.candidateId.includes("~mr-01~"),false,"and no longer the old one");
  assert.equal(s.selectionId,stableSelectionId("mr-01-revised","deribit",s.candidateId),"selection id is recomputed from the canonical helper");
  for(const usage of s.evidenceUsages??[])assert.equal(usage.candidateId,s.candidateId,"evidence usages follow the structure");
 }
 const generated=renamed.generationSnapshot.candidates.map(c=>c.candidateId);
 assert.deepEqual(generated,renamed.selectedStructures.map(s=>s.candidateId),"the generated universe matches the selections");
 assert.deepEqual((renamed.sourceRun as {event:{id:string}}).event.id,"mr-01-revised","the stored event reference is updated");
});

test("IDENTITY: renaming leaves other events completely untouched",()=>{
 const before=store([selectionEvent("mr-01"),selectionEvent("mr-02")]);
 const after=renameResearchSelectionEvent(before,"mr-01","mr-99");
 assert.deepEqual(after.events.find(e=>e.eventId==="mr-02"),before.events.find(e=>e.eventId==="mr-02"));
});

test("IDENTITY: a rename that changes nothing, or targets a missing event, is a no-op",()=>{
 const before=store([selectionEvent("mr-01")]);
 assert.equal(renameResearchSelectionEvent(before,"mr-01","mr-01"),before);
 assert.equal(renameResearchSelectionEvent(before,"absent","other"),before);
});

test("IDENTITY: the renamed store still passes canonical validation",()=>{
 const after=renameResearchSelectionEvent(store([selectionEvent("mr-01",2)]),"mr-01","mr-renamed");
 const checked=validateResearchSelectionStore(after);
 assert.equal(checked.ok,true,JSON.stringify(checked));
});

/* ---------------- deletion ---------------- */

test("DELETE: an event without saved structures is removed cleanly",()=>{
 const before=store([{...selectionEvent("mr-01"),selectedStructures:[]},selectionEvent("mr-02")]);
 const after=deleteResearchSelectionEvent(before,"mr-01");
 assert.equal(after.events.length,1);
 assert.equal(after.events[0]!.eventId,"mr-02");
});

test("DELETE: an event WITH saved structures takes its whole research subtree with it",()=>{
 const before=store([selectionEvent("mr-01",3),selectionEvent("mr-02")]);
 const after=deleteResearchSelectionEvent(before,"mr-01");
 const remaining=JSON.stringify(after);
 assert.equal(after.events.some(e=>e.eventId==="mr-01"),false);
 assert.equal(remaining.includes("mr-01"),false,"no structure, candidate, evidence usage or source-run reference survives");
 assert.equal(after.events[0]!.selectedStructures.length,1,"the unrelated event keeps its own structures");
});

test("DELETE: maker/taker scenario records go with the structure, both evaluated and not",()=>{
 const before=store([selectionEvent("mr-01")]);
 const scenarios=before.events[0]!.selectedStructures[0]!.executionScenarios;
 assert.equal(scenarios.maker.status,"evaluated");
 assert.equal(scenarios.taker.status,"not_evaluated","the fixture carries one of each so both paths are covered");
 const after=deleteResearchSelectionEvent(before,"mr-01");
 assert.equal(after.events.length,0);
 assert.equal(JSON.stringify(after).includes("not_evaluated"),false);
});

test("DELETE: deleting an absent event changes nothing and returns the same store",()=>{
 const before=store([selectionEvent("mr-01")]);
 assert.equal(deleteResearchSelectionEvent(before,"nope"),before);
});

test("DELETE: the surviving store still validates and exports a clean bundle",()=>{
 const before=store([selectionEvent("mr-01",2),selectionEvent("mr-02")]);
 const after=deleteResearchSelectionEvent(before,"mr-01");
 const checked=validateResearchSelectionStore(after);
 assert.equal(checked.ok,true,JSON.stringify(checked));
 // export -> validate: the availability universe is regenerated from the
 // remaining events, so no orphaned foreign key can survive the deletion.
 const bundle=buildResearchBundle(after,"2026-08-19T00:00:00.000Z");
 const validation=validateResearchBundle(bundle.files);
 assert.equal(validation.ok,true,validation.errors.join(" | "));
 for(const [name,contents] of Object.entries(bundle.files)){
  assert.equal(contents.includes("mr-01"),false,`${name} must not reference the deleted event`);
  if(name.endsWith(".jsonl")&&contents.trim())assert.ok(contents.includes("mr-02"),`${name} keeps the surviving event`);
 }
});

test("DELETE: deleting the last event still exports a structurally valid, empty bundle",()=>{
 const after=deleteResearchSelectionEvent(store([selectionEvent("mr-01")]),"mr-01");
 assert.equal(after.events.length,0);
 const bundle=buildResearchBundle(after,"2026-08-19T00:00:00.000Z");
 const validation=validateResearchBundle(bundle.files);
 assert.equal(validation.ok,true,validation.errors.join(" | "));
 assert.equal(bundle.files["candidates.jsonl"].trim(),"","no candidate rows remain");
 assert.equal(bundle.files["availability.jsonl"].trim(),"","the generated universe is regenerated, not left stale");
});

test("DELETE: the dataset side removes the event from ordinary JSON export",()=>{
 const remaining=dataset([fullEvent,otherEvent]).trades.filter(t=>t.id!=="mr-01");
 const checked=validateTradeDataset(dataset(remaining));
 assert.equal(checked.ok,true);
 const out=JSON.stringify(dataset(remaining));
 assert.equal(out.includes("mr-01"),false);
 assert.ok(out.includes("mr-02"));
});

/* ---------------- persistence service ---------------- */

test("SERVICE: deleting an event when no selections file exists succeeds instead of 409-ing",async()=>{
 // read() synthesizes an empty store with a fresh updatedAtUtc for a dataset
 // that has never saved selections, so a caller's If-Match can never match it.
 // A delete with nothing to remove must not fail on that.
 const {ResearchSelectionService}=await import("../scripts/research-selection-service.ts");
 const {mkdtemp,rm}=await import("node:fs/promises");
 const {tmpdir}=await import("node:os");
 const {join}=await import("node:path");
 const dir=await mkdtemp(join(tmpdir(),"selections-"));
 try{
  const service=new ResearchSelectionService(dir);
  const result=await service.deleteEvent(DATASET_ID,"never-saved","1999-01-01T00:00:00.000Z");
  assert.equal(result.events.length,0,"a no-op delete returns the store rather than throwing");
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("SERVICE: a genuine delete still enforces the optimistic-concurrency guard",async()=>{
 const {ResearchSelectionService}=await import("../scripts/research-selection-service.ts");
 const {mkdtemp,rm}=await import("node:fs/promises");
 const {tmpdir}=await import("node:os");
 const {join}=await import("node:path");
 const dir=await mkdtemp(join(tmpdir(),"selections-"));
 try{
  const service=new ResearchSelectionService(dir);
  const saved=await service.upsertEvent(DATASET_ID,"mr-01",selectionEvent("mr-01"));
  await assert.rejects(()=>service.deleteEvent(DATASET_ID,"mr-01","1999-01-01T00:00:00.000Z"),/changed on disk/i);
  const ok=await service.deleteEvent(DATASET_ID,"mr-01",saved.updatedAtUtc);
  assert.equal(ok.events.length,0,"deleting with the current version succeeds");
 }finally{await rm(dir,{recursive:true,force:true})}
});
