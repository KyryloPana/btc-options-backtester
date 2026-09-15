import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ResearchSelectionService} from "../scripts/research-selection-service.ts";
import {structuralDifferences, structuralIdentityOf} from "../app/lib/research-identity.ts";
import {CURRENT_RESEARCH_ENGINE_VERSIONS, diagnoseDerivedStaleness, type DerivedResearchOutput} from "../app/lib/research-refresh.ts";
import {comparativeMaterializationId,generationAttemptIdentity,generationStructuralConfiguration,migrateResearchSelectionStore, type ResearchSelectionStore} from "../app/lib/research-selections.ts";
import {store as fixtureStore, ts} from "./fixtures/research-selection-store.ts";
import {eventRecomputeUniverse} from "../scripts/research-recompute-engine.ts";
import {createResearchRecomputeEngine} from "../scripts/research-recompute-engine.ts";
import {recomputeSelectedResearch} from "../app/lib/research-refresh.ts";
import {validateResearchSelectionStore} from "../app/lib/research-selections.ts";
import {priceInverseOption} from "../app/lib/inverse-option-pricing.ts";

/**
 * The recompute driver.
 *
 * The property that matters is not that recomputation happens -- it is that it
 * CANNOT reselect. Structural identity comes from the saved selection and the
 * engine only ever supplies derived fields, so these tests spend most of their
 * effort trying to make a recompute change identity and asserting that it does
 * not, and that a failure leaves the saved store byte-identical.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function withStore<T>(run: (ctx: {
  service: ResearchSelectionService; directory: string; id: string;
  saved: ResearchSelectionStore;
}) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "recompute-"));
  const service = new ResearchSelectionService(directory);
  const migrated = migrateResearchSelectionStore(clone(fixtureStore));
  // The legacy fixture carries no resolved contract metadata, and store
  // validation requires a selected candidate to retain a valid analytical
  // track. Resolving it here is test setup, not the behaviour under test.
  const saved: ResearchSelectionStore = {...migrated, events: migrated.events.map(event => ({
    ...event,
    selectedStructures: event.selectedStructures.map(structure => ({
      ...structure,
      contractResolution: {
        status: "exact_resolved", reason: null,
        short: {instrumentName: "BTC-FIXTURE-SHORT", strike: 100, optionType: "P",
          expirationTimestamp: ts + 86_400_000, contractSize: 1, creationTimestamp: ts - 86_400_000,
          source: "deribit-instrument-metadata", retrievedAtUtc: new Date(ts).toISOString(), authoritative: true},
        long: {instrumentName: "BTC-FIXTURE-LONG", strike: 99, optionType: "P",
          expirationTimestamp: ts + 86_400_000, contractSize: 1, creationTimestamp: ts - 86_400_000,
          source: "deribit-instrument-metadata", retrievedAtUtc: new Date(ts).toISOString(), authoritative: true},
      },
    })),
  }))};
  // The service refuses a save whose dataset id disagrees with the payload.
  const id = saved.datasetId;
  await service.save(id, saved);
  try { return await run({service, directory, id, saved}); }
  finally { await rm(directory, {recursive: true, force: true}); }
}

/**
 * A derived output that is recognisably fresh and carries no structural fields.
 *
 * The Reference track is `valued`, because store validation requires a selected
 * candidate to retain at least one valid analytical track -- a recompute that
 * left every track unavailable would be refused, which is the correct behaviour
 * and not what these tests are probing.
 */
const derivedOutput = (marker: string): DerivedResearchOutput => ({
  executionScenarios: {
    maker: {status: "unavailable", reason: `recomputed ${marker}`, entrySnapshot: null,
      valuationPathSnapshot: [], outcomeSnapshots: []},
    taker: {status: "unavailable", reason: `recomputed ${marker}`, entrySnapshot: null,
      valuationPathSnapshot: [], outcomeSnapshots: []},
  },
  referenceValuation: {
    status: "valued", reason: `recomputed ${marker}`, source: "same_expiry_linear_interpolation",
    entrySnapshot: {
      valuationMode: "research-estimate", status: "priced", targetTimestamp: ts,
      valuationTimestamp: ts, entryTargetIndex: 100, amount: 1,
      grossSpreadBtcPerContract: 0.01, grossSpreadBtc: 0.01,
      openingFeesBtc: 0.0001, netOpeningCashFlowBtc: 0.0099,
      estimateQuality: "red",
      sold: {instrumentName: "sold", economicSide: "sold", priceBtcPerContract: 0.02},
      bought: {instrumentName: "bought", economicSide: "bought", priceBtcPerContract: 0.01},
    },
    valuationPathSnapshot: [], outcomeSnapshots: [],
    provenance: {executionIndependent: true},
  },
  delayedExecution: {status: "unavailable", reason: `recomputed ${marker}`},
  modeledExecution: null,
  marginSnapshot: {status: "unavailable", reason: `recomputed ${marker}`},
  statusLayers: null,
  evidenceTradeSnapshots: [],
  evidenceUsages: [],
  versions: {...CURRENT_RESEARCH_ENGINE_VERSIONS},
});

/* ==================== identity is preserved ==================== */

test("RECOMPUTE: derived layers refresh while every structural field is preserved", async () => {
  await withStore(async ({service, id, saved}) => {
    const before = structuralIdentityOf(saved);
    assert.ok(before.length > 0, "the fixture must carry selected structures");

    const result = await service.recompute(id, {kind: "all"}, async () => derivedOutput("v2"));
    assert.equal(result.refreshed, before.length);

    const after = structuralIdentityOf(result.store);
    assert.deepEqual(structuralDifferences(before, after), [],
      "a recompute must not move a single structural field");

    // Derived fields genuinely changed.
    const structure = result.store.events.flatMap(e => e.selectedStructures)[0]!;
    assert.match(String((structure.referenceValuation as {reason?: string}).reason), /recomputed v2/);
    assert.equal(structure.derivedVersions?.referenceValuation,
      CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation);
  });
});

test("RECOMPUTE: an engine that tries to return different structure is ignored", async () => {
  await withStore(async ({service, id, saved}) => {
    const before = structuralIdentityOf(saved);
    // A hostile engine returning extra structural-looking fields. The refresh
    // seam accepts only derived output, so none of it can land.
    const result = await service.recompute(id, {kind: "all"}, async () => ({
      ...derivedOutput("hostile"),
      candidateId: "some-other-candidate",
      candidateSnapshot: {shortStrike: 1, longStrike: 2},
      quantity: 999,
    } as unknown as DerivedResearchOutput));
    const after = structuralIdentityOf(result.store);
    assert.deepEqual(structuralDifferences(before, after), []);
    assert.deepEqual(after.map(r => r.candidateId), before.map(r => r.candidateId));
    assert.deepEqual(after.map(r => r.quantity), before.map(r => r.quantity));
  });
});

test("RECOMPUTE: unchanged selections are genuinely recomputed, not skipped", async () => {
  await withStore(async ({service, id, saved}) => {
    // Nothing about the selection set changes -- that is exactly the case the
    // save flow cannot serve, because it only builds derived data for additions.
    const seen: string[] = [];
    const result = await service.recompute(id, {kind: "all"}, async input => {
      seen.push(input.structure.candidateId);
      return derivedOutput("fresh");
    });
    assert.equal(seen.length, structuralIdentityOf(saved).length);
    assert.equal(result.refreshed, seen.length);
    for (const structure of result.store.events.flatMap(e => e.selectedStructures))
      assert.match(String((structure.referenceValuation as {reason?: string}).reason), /recomputed fresh/);
  });
});

test("RECOMPUTE: market-resolution universe includes only selected and comparative economics candidates",()=>{
 const saved=migrateResearchSelectionStore(clone(fixtureStore)),event=saved.events[0]!,base=clone(event.selectedStructures[0]!);
 event.selectedStructures=[];
 event.researchStructures=[{...base,selectionId:"comparative",researchRole:"comparative_economics",structuralConfigurationId:"structural-configuration-v2:test",attemptCandidateIds:[base.candidateId]},{...base,selectionId:"technical",researchRole:"short_strike_technical"}];
 assert.deepEqual(eventRecomputeUniverse(event).map(row=>row.selectionId),["comparative"]);
 assert.equal(event.selectedStructures.length,0,"the comparative candidate remains unselected");
});

test("RECOMPUTE INTEGRATION: an unselected comparative-only candidate resolves and rebuilds Reference, Q50, and Q90",async()=>{
 const saved=migrateResearchSelectionStore(clone(fixtureStore)),event=saved.events[0]!,candidate=event.generationSnapshot.candidates[0]!,base=clone(event.selectedStructures[0]!);
 saved.events=[event];event.selectedStructures=[];event.generationSnapshot.candidates=[candidate];event.researchStructures=[{...base,selectionId:comparativeMaterializationId(event.eventId,generationStructuralConfiguration(candidate).id!),candidateId:candidate.candidateId,researchRole:"comparative_economics",structuralConfigurationId:generationStructuralConfiguration(candidate).id!,generationAttemptIdentities:[generationAttemptIdentity(candidate)],executionScenarios:{maker:{status:"not_evaluated",reason:"Research only.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},taker:{status:"not_evaluated",reason:"Research only.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}}}];
 const entry=Number((event.sourceRun as any).event.entryTimestamp),expiry=candidate.actualExpiryTimestamp!,requested:string[]=[];
 (event.sourceRun as any).event.vpocTimestamp=entry+864e5;(event.sourceRun as any).event.exitTimestamp=entry+2*864e5;
 const series=(instrumentName:string,strike:number,optionType:"P"|"C")=>{const priced=priceInverseOption({optionType:optionType==="P"?"put":"call",indexPrice:100,strike,valuationTimestamp:entry-1,expiryTimestamp:expiry,ivDecimal:.55,forwardPrice:102});if(priced.status!=="priced")throw new Error("fixture price unavailable");const price=priced.priceBtc;return{instrumentName,expiryTimestamp:expiry,expiryLabel:"2026-08-23",strike,optionType,trades:[{instrumentName,timestamp:entry-1,price,markPrice:price,amount:2,indexPrice:100,direction:"buy" as const,iv:55,ivApiPercent:55,ivDecimal:.55,tradeSeq:"1"},{instrumentName,timestamp:entry-1,price,markPrice:price,amount:2,indexPrice:100,direction:"sell" as const,iv:55,ivApiPercent:55,ivDecimal:.55,tradeSeq:"2"}],firstTradeTimestamp:entry-1,lastTradeTimestamp:entry-1,sourceFiles:["fixture"],creationTimestamp:entry-2}};
 const inventory=[80,85,90,95,100,105].flatMap(strike=>[series(`BTC-X-${strike}-P`,strike,"P"),series(`BTC-X-${strike}-C`,strike,"C")]),service={totalRequestCount:0,resolve:async(_entry:number,requests:any[])=>{requested.push(...requests.map(row=>row.requestId));service.totalRequestCount++;return{candidates:requests.map(row=>({...row,desiredSoldStrike:row.soldStrike,desiredBoughtStrike:row.boughtStrike,expiryTimestamp:expiry,expiryLabel:"2026-08-23",actualDte:7,soldInstrumentName:"BTC-X-100-P",boughtInstrumentName:"BTC-X-90-P",soldStrike:100,boughtStrike:90,soldCreationTimestamp:entry-2,boughtCreationTimestamp:entry-2,strikeResolutionSensible:true,strikeResolutionNote:"exact",dataStatus:"available"})),inventory,crossSection:{ladderInstrumentCount:inventory.length}}}};
 const calibration={artifact:{artifactHash:"fixture-calibration-v1",sourceDatasetFingerprint:"fixture",coverageStartMs:entry-30*864e5,coverageEndMs:entry-1,tradeCount:500},execution:()=>({fallbackLevel:"action_dte_amount" as const,tradeCount:500,calendarDayCount:10,expiryDayGroupCount:20,q50VolPoints:0,q90VolPoints:.1,dteBand:"7-14" as const,amountBand:"small" as const}),reference:()=>({fallbackLevel:"dte" as const,tradeCount:500,calendarDayCount:10,expiryDayGroupCount:20,q90VolPoints:.1,dteBand:"7-14" as const})};
 const diagnostics:any[]=[],created=createResearchRecomputeEngine({service:service as any,executionCalibration:calibration as any,diagnostics});created.prime(saved);const before=structuralIdentityOf(saved),result=await recomputeSelectedResearch(saved,{kind:"all"},created.engine),after=structuralIdentityOf(result.store),row=result.store.events[0]!.researchStructures![0]!;
 assert.deepEqual(requested,[event.researchStructures[0]!.selectionId]);assert.equal(result.store.events[0]!.selectedStructures.length,0);assert.deepEqual(structuralDifferences(before,after),[]);assert.equal(row.researchRole,"comparative_economics");assert.equal(row.referenceValuation?.status,"valued");assert.doesNotMatch(String(row.referenceValuation?.reason??""),/Exact contracts/);assert.equal((row.modeledExecution as any).expected.status,"evaluated");assert.equal((row.modeledExecution as any).conservative.status,"evaluated");assert.equal(row.executionScenarios.maker.status,"not_evaluated");assert.equal(row.executionScenarios.taker.status,"not_evaluated");const validation=validateResearchSelectionStore(result.store);assert.equal(validation.ok,true,JSON.stringify(validation.errors));assert.equal(diagnostics[0]?.status,"recomputed");
});

test("RECOMPUTE: a stale causal-reference-v1 structure becomes current", async () => {
  await withStore(async ({service, id}) => {
    const before = await service.read(id);
    for (const structure of before.events.flatMap(e => e.selectedStructures))
      assert.notEqual(structure.derivedVersions?.referenceValuation,
        CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation);

    const result = await service.recompute(id, {kind: "all"}, async () => derivedOutput("v2"));
    for (const structure of result.store.events.flatMap(e => e.selectedStructures)) {
      assert.equal(structure.derivedVersions?.referenceValuation,
        CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation);
      assert.deepEqual(diagnoseDerivedStaleness(structure).layers.referenceValuation, undefined);
    }
  });
});

test("RECOMPUTE: v4 modeled snapshots are replaced before the v5 aggregate version is persisted",async()=>{
 await withStore(async({service,id})=>{
  const current=await service.read(id);
  for(const structure of current.events.flatMap(e=>e.selectedStructures)){
   structure.derivedVersions={...CURRENT_RESEARCH_ENGINE_VERSIONS,modeledExecution:"modeled-execution-v4-empirical-taker"};
   structure.modeledExecution={expected:{status:"evaluated",modelVersion:"modeled-execution-v4-empirical-taker"},conservative:{status:"unavailable",reason:"Empirical modeled execution produces nonpositive credit after authoritative fees.",modelVersion:null,provenance:null}};
  }
  await service.save(id,current);
  const provenance={artifactHash:"fake-v5",datasetFingerprint:"fake-calibration"};
  const result=await service.recompute(id,{kind:"all"},async()=>({...derivedOutput("v5"),modeledExecution:{
   expected:{status:"evaluated",reason:null,modelVersion:CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution,provenance,entrySnapshot:{netOpeningCashFlowBtc:.01},outcomeSnapshots:[]},
   conservative:{status:"unavailable",reasonCode:"empirical_nonpositive_credit_after_fees",reason:"Empirical modeled execution produces nonpositive credit after authoritative fees.",modelVersion:CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution,provenance,attemptedEntrySnapshot:{grossSpreadBtc:-.001,openingFeesBtc:.0001,netOpeningCashFlowBtc:-.0011},outcomeSnapshots:[]},
  }}));
  for(const structure of result.store.events.flatMap(e=>e.selectedStructures)){
   const modeled=structure.modeledExecution as Record<string,Record<string,unknown>>;
   assert.equal(structure.derivedVersions?.modeledExecution,CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution);
   assert.equal(modeled.expected.modelVersion,CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution);
   assert.equal(modeled.conservative.modelVersion,CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution);
   assert.equal(modeled.conservative.reasonCode,"empirical_nonpositive_credit_after_fees");
   assert.ok(modeled.conservative.provenance);
   assert.ok(modeled.conservative.attemptedEntrySnapshot);
  }
 });
});

/* ==================== failure safety ==================== */

test("ATOMICITY: a failing engine leaves the saved store byte-identical", async () => {
  await withStore(async ({service, directory, id}) => {
    const path = join(directory, `${id}.json`);
    const original = await readFile(path, "utf8");

    await assert.rejects(
      service.recompute(id, {kind: "all"}, async () => { throw new Error("Deribit retrieval failed"); }),
      /Deribit retrieval failed/);

    assert.equal(await readFile(path, "utf8"), original,
      "a failed recompute must not touch the persisted store at all");
  });
});

test("ATOMICITY: a mid-run failure after some structures succeed still writes nothing", async () => {
  await withStore(async ({service, directory, id}) => {
    const path = join(directory, `${id}.json`);
    const original = await readFile(path, "utf8");
    let calls = 0;
    await assert.rejects(service.recompute(id, {kind: "all"}, async () => {
      calls += 1;
      if (calls > 1) throw new Error("second structure failed");
      return derivedOutput("partial");
    }), /second structure failed/);
    assert.ok(calls > 1, "the fixture must have several structures for this to mean anything");
    assert.equal(await readFile(path, "utf8"), original,
      "a partial success must not be persisted");
  });
});

test("ATOMICITY: output that fails validation preserves the previous state", async () => {
  await withStore(async ({service, directory, id}) => {
    const path = join(directory, `${id}.json`);
    const original = await readFile(path, "utf8");
    await assert.rejects(service.recompute(id, {kind: "all"}, async () => ({
      // Structurally malformed derived output.
      executionScenarios: "not-an-object",
      marginSnapshot: null, versions: {},
    } as unknown as DerivedResearchOutput)));
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("ATOMICITY: a concurrent edit is refused rather than overwritten", async () => {
  await withStore(async ({service, id}) => {
    const current = await service.read(id);
    await assert.rejects(
      service.recompute(id, {kind: "all"}, async () => derivedOutput("v2"),
        new Date(Date.parse(current.updatedAtUtc) - 1000).toISOString()),
      /changed on disk/);
  });
});

/* ==================== scope ==================== */

test("SCOPE: a single-structure recompute leaves every other structure untouched", async () => {
  await withStore(async ({service, id, saved}) => {
    const target = saved.events.flatMap(e => e.selectedStructures.map(s => ({eventId: e.eventId, structure: s})))[0]!;
    const result = await service.recompute(id,
      {kind: "structure", eventId: target.eventId, candidateId: target.structure.candidateId},
      async () => derivedOutput("scoped"));
    assert.equal(result.refreshed, 1);

    for (const event of result.store.events) for (const structure of event.selectedStructures) {
      const reason = String((structure.referenceValuation as {reason?: string} | undefined)?.reason ?? "");
      if (structure.candidateId === target.structure.candidateId)
        assert.match(reason, /recomputed scoped/);
      else assert.doesNotMatch(reason, /recomputed scoped/);
    }
    assert.deepEqual(structuralDifferences(structuralIdentityOf(saved), structuralIdentityOf(result.store)), []);
  });
});

/* ==================== the identity check itself ==================== */

test("IDENTITY CHECK: it detects a moved strike, a lost candidate and an added one", () => {
  const before = structuralIdentityOf(migrateResearchSelectionStore(clone(fixtureStore)));
  assert.deepEqual(structuralDifferences(before, before), []);

  const movedStrike = clone(before);
  movedStrike[0]!.actualShort = (movedStrike[0]!.actualShort ?? 0) + 1000;
  assert.ok(structuralDifferences(before, movedStrike).some(d => d.includes("actualShort")));

  const dropped = before.slice(1);
  const problems = structuralDifferences(before, dropped);
  assert.ok(problems.some(d => d.includes("disappeared")));
  assert.ok(problems.some(d => d.includes("count changed")));

  const added = [...before, {...before[0]!, candidateId: "invented"}];
  assert.ok(structuralDifferences(before, added).some(d => d.includes("appeared")));

  const movedExpiry = clone(before);
  movedExpiry[0]!.expiryTimestamp = (movedExpiry[0]!.expiryTimestamp ?? 0) + 86_400_000;
  assert.ok(structuralDifferences(before, movedExpiry).some(d => d.includes("expiryTimestamp")));
});

test("IDENTITY CHECK: comparative materializations and normalized attempt provenance are guarded",()=>{
 const saved=migrateResearchSelectionStore(clone(fixtureStore)),event=saved.events[0]!,source=event.selectedStructures[0]!;
 event.researchStructures=[{...clone(source),selectionId:"research-comparative",researchRole:"comparative_economics",structuralConfigurationId:"structural-configuration-v2:test",attemptCandidateIds:["second","first"]}];
 const before=structuralIdentityOf(saved),reordered=clone(saved);reordered.events[0]!.researchStructures![0]!.attemptCandidateIds=["first","second"];
 assert.deepEqual(structuralDifferences(before,structuralIdentityOf(reordered)),[]);
 const moved=clone(saved);moved.events[0]!.researchStructures![0]!.quantity=(moved.events[0]!.researchStructures![0]!.quantity??1)+1;
 assert.ok(structuralDifferences(before,structuralIdentityOf(moved)).some(problem=>problem.includes("quantity")));
 assert.equal(saved.events[0]!.selectedStructures.length,event.selectedStructures.length,"comparative safety never promotes a Strategy selection");
});

/* ==================== route ==================== */

test("ROUTE: recompute is refused when no engine is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recompute-route-"));
  try {
    const {researchSelectionApiPlugin} = await import("../scripts/research-selection-service.ts");
    const plugin = researchSelectionApiPlugin(directory);
    assert.equal(plugin.name, "local-research-selections");
    // With no factory the route must decline rather than silently do nothing.
    const withFactory = researchSelectionApiPlugin(directory, () => async () => derivedOutput("route"));
    assert.equal(withFactory.name, "local-research-selections");
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("ROUTE: the store file is only replaced on success", async () => {
  await withStore(async ({service, directory, id}) => {
    const path = join(directory, `${id}.json`);
    await service.recompute(id, {kind: "all"}, async () => derivedOutput("ok"));
    const written = JSON.parse(await readFile(path, "utf8")) as ResearchSelectionStore;
    assert.match(String((written.events[0]!.selectedStructures[0]!.referenceValuation as {reason?: string}).reason),
      /recomputed ok/);
    // No temporary files left behind.
    const {readdir} = await import("node:fs/promises");
    const leftovers = (await readdir(directory)).filter(f => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
    await writeFile(join(directory, "keep"), "", "utf8");
  });
});
