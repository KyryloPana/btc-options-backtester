/**
 * Recompute the derived research for an already-saved selection store.
 *
 * Structural identity is verified before anything is written: if a single
 * candidate id, strike, expiry or horizon moved, the recompute fails and the
 * saved store is left untouched. That check is the whole safety property --
 * a migration that quietly reselects would be indistinguishable from a
 * successful one in the output.
 *
 *   node --experimental-strip-types scripts/run-research-recompute.ts \
 *     <datasetId> <auditJson> [--execution-estimator=/path/to/artifact-directory-or-json] [--dry-run]
 */

import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {migrateResearchSelectionStore, type ResearchSelectionStore, type SelectedStructure} from "../app/lib/research-selections.ts";
import {structuralDifferences, structuralIdentityOf} from "../app/lib/research-identity.ts";
import {recomputeSelectedResearch} from "../app/lib/research-refresh.ts";
import {DeribitHistoryService} from "./deribit-history-api.ts";
import {createResearchRecomputeEngine, type RecomputeDiagnostics} from "./research-recompute-engine.ts";
import {loadExecutionCalibration} from "./execution-estimator-artifact.ts";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};

/** The previous methodology's output, captured before anything is overwritten. */
function captureReference(store: ResearchSelectionStore) {
  const rows: Row[] = [];
  for (const event of store.events) for (const structure of event.selectedStructures) {
    const reference = obj(structure.referenceValuation as unknown);
    rows.push({
      event_id: event.eventId, candidate_id: structure.candidateId,
      method_version: obj(structure.derivedVersions as unknown).referenceValuation ?? null,
      status: reference.status ?? null, source: reference.source ?? null,
      reason: reference.reason ?? null,
      entry: reference.entrySnapshot ?? null,
      path: reference.valuationPathSnapshot ?? [],
      outcomes: reference.outcomeSnapshots ?? [],
    });
  }
  return rows;
}

async function main() {
  const [datasetId, auditPath, ...flags] = process.argv.slice(2);
  if (!datasetId || !auditPath) throw new Error("usage: run-research-recompute.ts <datasetId> <auditJson> [--execution-estimator=<artifact-directory-or-json>] [--dry-run]");
  const dryRun = flags.includes("--dry-run");
  const estimatorFlags=flags.filter(flag=>flag.startsWith("--execution-estimator="));
  const unknown=flags.filter(flag=>flag!=="--dry-run"&&!flag.startsWith("--execution-estimator="));
  if(unknown.length||estimatorFlags.length>1||estimatorFlags[0]==="--execution-estimator=")throw new Error(`invalid arguments: ${[...unknown,...estimatorFlags.slice(1)].join(" ")||"empty execution estimator path"}`);
  // Validate before starting the history service: a bad artifact cannot cause a partial recompute.
  const executionCalibration=estimatorFlags[0]?await loadExecutionCalibration(resolve(estimatorFlags[0].slice("--execution-estimator=".length))):undefined;
  const storePath = resolve(process.cwd(), "data/research-selections", `${datasetId}.json`);

  const raw = JSON.parse(await readFile(storePath, "utf8"));
  const before = migrateResearchSelectionStore(raw);
  const beforeIdentity = structuralIdentityOf(before);
  const beforeReference = captureReference(before);
  process.stderr.write(
    `store ${datasetId}: ${before.events.length} events, ${beforeIdentity.length} selected structures\n`);

  const service = new DeribitHistoryService(
    "https://history.deribit.com/api/v2/public",
    resolve(process.cwd(), ".local-cache/deribit-manifest.json"), fetch, 4);
  await service.startIndex();
  await service.waitUntilReady();
  process.stderr.write("instrument manifest ready\n");

  const diagnostics: RecomputeDiagnostics[] = [];
  const {engine, prime} = createResearchRecomputeEngine({service, diagnostics, executionCalibration});
  prime(before);

  let done = 0;
  const total = beforeIdentity.length;
  const wrapped: typeof engine = async input => {
    const output = await engine(input);
    done += 1;
    process.stderr.write(`  ${done}/${total} ${input.structure.candidateId}\n`);
    return output;
  };

  const {store: after, refreshed} = await recomputeSelectedResearch(before, {kind: "all"}, wrapped);
  const afterIdentity = structuralIdentityOf(after);
  const differences = structuralDifferences(beforeIdentity, afterIdentity);

  if (differences.length) {
    process.stderr.write(`STRUCTURAL IDENTITY CHANGED -- refusing to write:\n`);
    for (const d of differences.slice(0, 20)) process.stderr.write(`  ${d}\n`);
    process.exitCode = 1;
    return;
  }

  const afterReference = captureReference(after);
  await writeFile(auditPath, JSON.stringify({
    generated_at_utc: new Date().toISOString(),
    dataset_id: datasetId, dry_run: dryRun,
    refreshed, api_requests: service.totalRequestCount,
    structural_identity_preserved: true,
    structural_rows: beforeIdentity.length,
    diagnostics,
    before: beforeReference, after: afterReference,
  }, null, 1), "utf8");

  if (dryRun) { process.stderr.write(`dry run: ${refreshed} structures recomputed, store NOT written\n`); return; }

  // Written through the service so the store is validated and persisted exactly
  // as the application persists it -- same atomic temp-and-rename, same
  // formatting. Identity was already checked above, so nothing reaches disk
  // unless the structural set is provably unchanged.
  const {ResearchSelectionService} = await import("./research-selection-service.ts");
  await new ResearchSelectionService(resolve(process.cwd(), "data/research-selections")).save(datasetId, after);
}

main().catch(e => {
  const error = e as Error & {details?: unknown};
  process.stderr.write(`FAILED: ${error.message}
`);
  if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 1).slice(0, 4000)}
`);
  process.exitCode = 1;
});

export type {SelectedStructure};
