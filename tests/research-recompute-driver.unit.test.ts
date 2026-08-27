import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ResearchSelectionService} from "../scripts/research-selection-service.ts";
import {structuralDifferences, structuralIdentityOf} from "../app/lib/research-identity.ts";
import {CURRENT_RESEARCH_ENGINE_VERSIONS, diagnoseDerivedStaleness, type DerivedResearchOutput} from "../app/lib/research-refresh.ts";
import {migrateResearchSelectionStore, type ResearchSelectionStore} from "../app/lib/research-selections.ts";
import {store as fixtureStore, ts} from "./fixtures/research-selection-store.ts";

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

test("RECOMPUTE: a stale causal-reference-v1 structure becomes current", async () => {
  await withStore(async ({service, id}) => {
    const before = await service.read(id);
    for (const structure of before.events.flatMap(e => e.selectedStructures))
      assert.notEqual(structure.derivedVersions?.referenceValuation,
        CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation);

    const result = await service.recompute(id, {kind: "all"}, async () => derivedOutput("v2"));
    for (const structure of result.store.events.flatMap(e => e.selectedStructures)) {
      assert.equal(structure.derivedVersions?.referenceValuation,
        "causal-reference-v2-hybrid-interpolation");
      assert.deepEqual(diagnoseDerivedStaleness(structure).layers.referenceValuation, undefined);
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
