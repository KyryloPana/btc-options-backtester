/**
 * Validate a supplied ResearchSelectionStore through the repository's own
 * migration/validation path, and reconcile every selected structure against the
 * generation snapshot it came from.
 *
 * Read-only. This exists so a supplied store is accepted on evidence rather than
 * on its own say-so: the schema is validated by the canonical migrator, and the
 * structural identity of each selection is checked against the candidate universe
 * that produced it. A mismatch is reported, never repaired.
 *
 *   node --experimental-strip-types scripts/validate-selection-store.ts <storeJson> [outJson]
 */

import {readFile, writeFile} from "node:fs/promises";
import {
  RESEARCH_SELECTION_SCHEMA_VERSION, migrateResearchSelectionStore,
} from "../app/lib/research-selections.ts";
import {effectiveConfigurationHash} from "../app/lib/configuration-identity.ts";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

async function main() {
  const [storePath, outPath] = process.argv.slice(2);
  if (!storePath) throw new Error("usage: validate-selection-store.ts <storeJson> [outJson]");

  const raw = JSON.parse(await readFile(storePath, "utf8")) as Row;
  const declared = String(raw.schemaVersion ?? "");
  process.stdout.write(`declared schemaVersion: ${declared} | repository current: ${RESEARCH_SELECTION_SCHEMA_VERSION}\n`);
  process.stdout.write(`datasetId: ${String(raw.datasetId)} | updatedAtUtc: ${String(raw.updatedAtUtc)}\n`);

  let store;
  try { store = migrateResearchSelectionStore(raw); }
  catch (error) {
    process.stdout.write(`\nVALIDATION FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const configurationHashes = new Map(store.events.map(e =>
    [e.eventId, effectiveConfigurationHash(e.generationSnapshot.configuration)]));
  const selectedTotal = store.events.reduce((s, e) => s + e.selectedStructures.length, 0);
  const generatedTotal = store.events.reduce((s, e) => s + e.generationSnapshot.candidates.length, 0);
  const eventsWithSelections = store.events.filter(e => e.selectedStructures.length).length;

  process.stdout.write(`migrated schemaVersion: ${store.schemaVersion}\n`);
  process.stdout.write(`events: ${store.events.length} | events with selections: ${eventsWithSelections}\n`);
  process.stdout.write(`selected structures: ${selectedTotal} | generated candidate universe: ${generatedTotal}\n`);
  process.stdout.write(`distinct effective configuration hashes: ${JSON.stringify([...new Set(configurationHashes.values())])}\n`);

  process.stdout.write("\n--- per event ---\n");
  for (const e of store.events) {
    const source = obj(obj(e.sourceRun as unknown).event);
    const entry = num(source.entryTimestamp);
    process.stdout.write(
      `${e.eventId}  ${String(source.label ?? "").padEnd(22)} ${String(source.direction ?? "").padEnd(6)} ` +
      `entry=${entry === null ? "?" : new Date(entry).toISOString()}  ` +
      `generated=${String(e.generationSnapshot.candidates.length).padStart(4)}  ` +
      `selected=${String(e.selectedStructures.length).padStart(3)}  cfg=${configurationHashes.get(e.eventId)}\n`);
  }

  /* ---- reconcile every selection against the generation snapshot ---- */

  const mismatches: Row[] = [];
  const rows: Row[] = [];
  for (const e of store.events) {
    const byId = new Map(e.generationSnapshot.candidates.map(c => [c.candidateId, c]));
    const entry = num(obj(obj(e.sourceRun as unknown).event).entryTimestamp);
    for (const s of e.selectedStructures) {
      const generated = byId.get(s.candidateId);
      const snapshot = obj(s.candidateSnapshot as unknown);
      const problems: string[] = [];
      if (!generated) problems.push("candidateId absent from generationSnapshot.candidates");
      else {
        // Only fields present on BOTH sides are compared; a field the snapshot
        // does not carry is not evidence of disagreement.
        const compare = (label: string, a: unknown, b: unknown) => {
          if (a === undefined || a === null) return;
          if (JSON.stringify(a) !== JSON.stringify(b))
            problems.push(`${label}: selection ${JSON.stringify(a)} vs generated ${JSON.stringify(b)}`);
        };
        compare("optionType", snapshot.optionType, generated.optionType);
        compare("expiryTimestamp", snapshot.expiryTimestamp, generated.actualExpiryTimestamp);
        compare("requestedStrikes", snapshot.requestedStrikes, generated.requestedStrikes);
        compare("actualStrikes", snapshot.actualStrikes, generated.actualStrikes);
        compare("targetHorizon", snapshot.targetHorizon, generated.targetHorizon);
        compare("structure", snapshot.structure, generated.structure);
      }
      if (problems.length) mismatches.push({event_id: e.eventId, candidate_id: s.candidateId, problems});
      if (generated) rows.push({
        event_id: e.eventId, candidate_id: s.candidateId, venue: s.venue,
        option_type: generated.optionType, structure: generated.structure,
        requested_strikes: generated.requestedStrikes as unknown as Row,
        actual_strikes: generated.actualStrikes as unknown as Row,
        target_horizon_days: generated.targetHorizon,
        expiry_timestamp_ms: generated.actualExpiryTimestamp,
        entry_timestamp_ms: entry,
        actual_dte_days: entry !== null && generated.actualExpiryTimestamp
          ? (generated.actualExpiryTimestamp - entry) / 86_400_000 : null,
        status: generated.status,
      });
    }
  }

  process.stdout.write(`\nreconciled ${rows.length} selections; ${mismatches.length} mismatches\n`);
  for (const m of mismatches.slice(0, 20))
    process.stdout.write(`  MISMATCH ${String(m.candidate_id)}: ${(m.problems as string[]).join(" | ")}\n`);

  process.stdout.write("\nevent     ty  reqShort  reqLong  actShort  actLong  width  horiz  expiry                     DTE  status\n");
  for (const r of [...rows].sort((a, b) => String(a.event_id).localeCompare(String(b.event_id))
    || num(obj(a.actual_strikes).short)! - num(obj(b.actual_strikes).short)!
    || num(obj(a.actual_strikes).long)! - num(obj(b.actual_strikes).long)!)) {
    const req = obj(r.requested_strikes), act = obj(r.actual_strikes);
    process.stdout.write(
      `${String(r.event_id).padEnd(9)} ${String(r.option_type).padEnd(3)} ` +
      `${String(req.short).padStart(9)} ${String(req.long).padStart(8)} ` +
      `${String(act.short).padStart(9)} ${String(act.long).padStart(8)} ` +
      `${String(act.width ?? req.width).padStart(6)} ${String(r.target_horizon_days).padStart(6)}  ` +
      `${new Date(num(r.expiry_timestamp_ms)!).toISOString()}  ` +
      `${(num(r.actual_dte_days) ?? 0).toFixed(2).padStart(5)}  ${String(r.status)}\n`);
  }

  const widthSubstituted = rows.filter(r =>
    JSON.stringify(r.requested_strikes) !== JSON.stringify(r.actual_strikes));
  const tally = (key: string) => rows.reduce<Record<string, number>>((m, r) => {
    const k = String(r[key]); m[k] = (m[k] ?? 0) + 1; return m;
  }, {});
  process.stdout.write(`\nwidth-substituted: ${widthSubstituted.length}\n`);
  process.stdout.write(`horizons: ${JSON.stringify(tally("target_horizon_days"))}\n`);
  process.stdout.write(`option types: ${JSON.stringify(tally("option_type"))}\n`);
  process.stdout.write(`distinct expiries: ${new Set(rows.map(r => r.expiry_timestamp_ms)).size}\n`);
  process.stdout.write(`duplicate candidate ids: ${rows.length - new Set(rows.map(r => r.candidate_id)).size}\n`);

  if (outPath) await writeFile(outPath, JSON.stringify({
    declared_schema_version: declared, repository_schema_version: RESEARCH_SELECTION_SCHEMA_VERSION,
    dataset_id: store.datasetId, updated_at_utc: store.updatedAtUtc,
    event_count: store.events.length, events_with_selections: eventsWithSelections,
    selected_structure_count: selectedTotal, generated_candidate_count: generatedTotal,
    configuration_hashes: [...new Set(configurationHashes.values())],
    mismatches, structures: rows,
  }, null, 1), "utf8");
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
