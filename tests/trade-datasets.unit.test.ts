import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultDataset from "../data/trade-datasets/default-sample-trades.json" with { type: "json" };
import { mergeTradeDatasets, validateTradeDataset, type TradeDataset } from "../app/lib/trade-datasets.ts";
import { TradeDatasetService } from "../scripts/trade-dataset-service.ts";

const ids=["43e5f62c","d099f278","467ced0c","1c454ed4","5bebaf8f","653f11df","6b6e9aed","2a93d290","920cb392","f7a352c4","17339625","1656764f","fe7bba5f","3e29cf29","1f046e00"];
test("sample migration retains all values and ordering",()=>{assert.deepEqual(defaultDataset.trades.map(t=>t.id),ids);assert.equal(defaultDataset.trades[0].entryPrice,41800);assert.equal(defaultDataset.trades[14].exitPrice,64450);assert.equal(defaultDataset.trades[3].notes,"vPOC changed 22 Sep 2024; old high-volume node retained.");});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),"trade-datasets-"));const service=new TradeDatasetService(directory);const data=structuredClone(defaultDataset) as TradeDataset;await service.atomicWrite(data);return{directory,service,data};}
test("list, read, save, and first-touch persistence",async()=>{const {directory,service,data}=await fixture();try{assert.equal((await service.list())[0].tradeCount,15);data.trades[0].entryTimestamp=Date.parse("2024-01-27T08:00:00Z");data.trades[0].entryTimeSource="manual";await service.save(data.datasetId,data);assert.equal((await service.read(data.datasetId)).trades[0].entryTimestamp,data.trades[0].entryTimestamp);}finally{await rm(directory,{recursive:true,force:true});}});
test("invalid records and traversal are rejected",async()=>{const {directory,service,data}=await fixture();try{data.trades[1].id=data.trades[0].id;await assert.rejects(service.save(data.datasetId,data),/validation/i);await assert.rejects(service.read("../secret"),/Invalid dataset ID/);await assert.rejects(service.read("/tmp/secret"),/Invalid dataset ID/);}finally{await rm(directory,{recursive:true,force:true});}});
test("separate imports get safe collision IDs",async()=>{const {directory,service,data}=await fixture();try{const result=await service.import(data,"separate");assert.equal(result.dataset.datasetId,"default-sample-trades-2");assert.equal((await service.list()).length,2);}finally{await rm(directory,{recursive:true,force:true});}});
test("combine appends, skips identical, and resolves conflicts",()=>{const current=structuredClone(defaultDataset) as TradeDataset;const fresh={...current.trades[0],id:"fresh"};const changed={...current.trades[1],entryPrice:999};const incoming={...current,datasetId:"incoming",trades:[current.trades[0],changed,fresh]};const keep=mergeTradeDatasets(current,incoming,"keep-existing");assert.deepEqual(keep.summary,{added:1,unchanged:1,replaced:0,conflicts:1,rejected:0});assert.equal(keep.dataset.trades[1].entryPrice,current.trades[1].entryPrice);assert.equal(keep.dataset.trades.at(-1)?.id,"fresh");const replace=mergeTradeDatasets(current,incoming,"replace-imported");assert.equal(replace.summary.replaced,1);assert.equal(replace.dataset.trades[1].entryPrice,999);});
test("failed temporary write leaves canonical JSON intact",async()=>{const {directory,service}=await fixture();try{const before=await readFile(join(directory,"default-sample-trades.json"),"utf8");await writeFile(join(directory,`.default-sample-trades.${process.pid}.${Date.now()}.tmp`),"collision");const invalid=structuredClone(defaultDataset) as TradeDataset;Object.defineProperty(invalid,"name",{get(){throw new Error("serialization failed");}});await assert.rejects(service.atomicWrite(invalid),/serialization failed/);assert.equal(await readFile(join(directory,"default-sample-trades.json"),"utf8"),before);}finally{await rm(directory,{recursive:true,force:true});}});
test("schema validation reports trade ID and field path",()=>{const bad=structuredClone(defaultDataset) as TradeDataset;bad.trades[0].entryTimestamp=NaN;const result=validateTradeDataset(bad);assert.equal(result.ok,false);if(!result.ok){assert.equal(result.errors[0].tradeId,"43e5f62c");assert.match(result.errors[0].path,/entryTimestamp/);}});

/* ---- schema-v1 extension: first-class extremeDate / extremeTimestamp ---- */

/** The exact supplied shape: every canonical field on one event. */
const supplied = (): TradeDataset => ({
  schemaVersion: 1, datasetId: "supplied-shape", name: "Supplied first version",
  updatedAt: "2026-08-27T09:00:00.000Z",
  trades: [{
    id: "3f2a1b8c-9d4e-4f10-8a77-1c2d3e4f5a6b",
    // Deliberately a label whose displayed date does NOT match entryDate.
    label: "MR-11 · 2025-10-08",
    direction: "short",
    entryDate: "2025-10-09", entryPrice: 122490,
    entryTimestamp: Date.parse("2025-10-09T12:00:00Z"), entryTimeSource: "manual",
    exitDate: "2025-10-20", exitPrice: 111010, exitTimestamp: Date.parse("2025-10-20T05:00:00Z"),
    extremePrice: 126270, extremeDate: "2025-10-11", extremeTimestamp: Date.parse("2025-10-11T03:30:00Z"),
    vpocPrice: 118040, vpocDate: "2025-10-10", vpocTimestamp: Date.parse("2025-10-10T17:00:00Z"),
    invalidationPrice: 126500, rangeLow: 107200, rangeHigh: 126270,
  }],
});

test("the supplied schema-v1 shape validates, label date mismatch included", () => {
  const dataset = supplied();
  const result = validateTradeDataset(dataset);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.errors));
  assert.equal(dataset.schemaVersion, 1, "additive fields must not bump the schema version");
  // The label says 2025-10-08 while entryDate is 2025-10-09; label is display
  // text and must never be parsed for chronology.
  assert.match(dataset.trades[0]!.label, /2025-10-08/);
  assert.equal(dataset.trades[0]!.entryDate, "2025-10-09");
});

test("extreme fields survive import, save, reload and combine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trade-datasets-extreme-"));
  const service = new TradeDatasetService(directory);
  try {
    const imported = await service.import(supplied(), "separate");
    const event = imported.dataset.trades[0]!;
    assert.equal(event.extremeDate, "2025-10-11");
    assert.equal(event.extremeTimestamp, Date.parse("2025-10-11T03:30:00Z"));

    const reloaded = (await service.read(imported.dataset.datasetId)).trades[0]!;
    for (const field of ["extremePrice", "extremeDate", "extremeTimestamp", "vpocDate", "vpocTimestamp",
      "exitTimestamp", "entryTimeSource", "invalidationPrice", "rangeLow", "rangeHigh"] as const)
      assert.deepEqual(reloaded[field], supplied().trades[0]![field], `${field} must round-trip`);

    // Saving again must not shed the new fields either.
    const saved = await service.save(imported.dataset.datasetId, await service.read(imported.dataset.datasetId));
    assert.equal(saved.trades[0]!.extremeTimestamp, Date.parse("2025-10-11T03:30:00Z"));

    // ...and neither must a combine import into an existing dataset.
    const combined = await service.import({...supplied(), trades: [{...supplied().trades[0]!, id: "combined-event"}]},
      "combine-current", imported.dataset.datasetId, "keep-existing");
    const appended = combined.dataset.trades.find(t => t.id === "combined-event")!;
    assert.equal(appended.extremeDate, "2025-10-11");
    assert.equal(appended.extremeTimestamp, Date.parse("2025-10-11T03:30:00Z"));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("extreme date and timestamp are validated without being inferred", () => {
  const badDate = supplied(); badDate.trades[0]!.extremeDate = "2025-13-45";
  const dateResult = validateTradeDataset(badDate);
  assert.equal(dateResult.ok, false);
  if (!dateResult.ok) assert.match(dateResult.errors[0]!.path, /extremeDate/);

  const badTime = supplied(); badTime.trades[0]!.extremeTimestamp = Number.NaN;
  const timeResult = validateTradeDataset(badTime);
  assert.equal(timeResult.ok, false);
  if (!timeResult.ok) assert.match(timeResult.errors[0]!.path, /extremeTimestamp/);

  // A date and timestamp for the same point must agree on the UTC day.
  const mismatch = supplied(); mismatch.trades[0]!.extremeTimestamp = Date.parse("2025-10-12T03:30:00Z");
  const mismatchResult = validateTradeDataset(mismatch);
  assert.equal(mismatchResult.ok, false);
  if (!mismatchResult.ok) assert.match(mismatchResult.errors[0]!.path, /extremeTimestamp/);

  // Absent fields stay absent: nothing is inferred in either direction.
  const partial = supplied();
  delete partial.trades[0]!.extremeTimestamp;
  const partialResult = validateTradeDataset(partial);
  assert.equal(partialResult.ok, true);
  if (partialResult.ok) assert.equal(partialResult.dataset.trades[0]!.extremeTimestamp, undefined);
});

test("events without the new fields remain valid; canonical fixture still passes", () => {
  const legacy = structuredClone(defaultDataset) as TradeDataset;
  assert.equal(validateTradeDataset(legacy).ok, true, "additive extension must not break existing datasets");
  assert.ok(legacy.trades.every(t => t.extremeDate === undefined && t.extremeTimestamp === undefined));
  // Exit/VPOC day-consistency is newly enforced; the canonical fixture must
  // already satisfy it or the rule would be a breaking migration.
  for (const trade of legacy.trades)
    for (const [d, t] of [["exitDate", "exitTimestamp"], ["vpocDate", "vpocTimestamp"]] as const) {
      const day = trade[d], instant = trade[t];
      if (typeof day !== "string" || typeof instant !== "number") continue;
      const start = Date.parse(`${day}T00:00:00Z`);
      assert.ok(instant >= start && instant < start + 86_400_000, `${trade.id} ${t} must fall on ${d}`);
    }
});
