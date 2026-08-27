/**
 * Migration audit for the hybrid recompute.
 *
 * Builds the canonical research bundle from the recomputed store through the
 * repository's normal exporter, then reports what actually changed: tier usage,
 * interpolation geometry, leg-coherence outcomes, and a matched
 * candidate-by-candidate, timestamp-by-timestamp comparison of the previous
 * methodology against the new one.
 *
 * It compares rather than concludes. A valuation difference here is a pricing
 * difference; nothing in this file says whether the strategy is better.
 *
 *   node --experimental-strip-types scripts/audit-recompute-migration.ts \
 *     <recomputeAuditJson> <datasetId> <outJson>
 */

import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {migrateResearchSelectionStore} from "../app/lib/research-selections.ts";
import {buildResearchBundle, validateResearchBundle, RESEARCH_BUNDLE_SCHEMA_VERSION} from "../app/lib/research-bundle.ts";
import {CURRENT_RESEARCH_ENGINE_VERSIONS} from "../app/lib/research-refresh.ts";
import {structuralIdentityOf, structuralDifferences} from "../app/lib/research-identity.ts";
import {RULE_C_MINIMUM_UNIQUE_STRIKES} from "../app/lib/volatility/reference-hybrid.ts";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const arr = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : [];
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;

const tally = (values: (string | null)[]) => values.reduce<Record<string, number>>((m, v) => {
  const k = v ?? "none"; m[k] = (m[k] ?? 0) + 1; return m;
}, {});

const quantiles = (values: number[]) => {
  const xs = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null;
  return {count: xs.length, min: xs[0] ?? null, median: q(0.5), p90: q(0.9), p95: q(0.95), max: xs.at(-1) ?? null,
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null};
};

/** Reference legs, flattened from an entry snapshot. */
const legsOf = (entry: Row) => ({
  short: obj(entry.sold), long: obj(entry.bought),
});

async function main() {
  const [auditPath, datasetId, outPath] = process.argv.slice(2);
  if (!auditPath || !datasetId || !outPath)
    throw new Error("usage: audit-recompute-migration.ts <recomputeAuditJson> <datasetId> <outJson>");

  const audit = JSON.parse(await readFile(auditPath, "utf8")) as {
    diagnostics: Row[]; before: Row[]; after: Row[]; api_requests: number; refreshed: number;
  };
  const storePath = resolve(process.cwd(), "data/research-selections", `${datasetId}.json`);
  const store = migrateResearchSelectionStore(JSON.parse(await readFile(storePath, "utf8")));

  /* ---------- bundle ---------- */

  const bundle = buildResearchBundle(store, new Date().toISOString());
  const validation = validateResearchBundle(bundle.files);
  const rows = (name: string) => bundle.files[name as keyof typeof bundle.files]
    .split("\n").filter(Boolean).map(l => JSON.parse(l) as Row);

  const candidates = rows("candidates.jsonl");
  const valuations = rows("valuations.jsonl");
  const outcomes = rows("outcomes.jsonl");
  const economics = rows("structure_economics.jsonl");
  const availability = rows("availability.jsonl");
  const volatility = rows("event_volatility_state.jsonl");

  /* ---------- structural identity ---------- */

  const identity = structuralIdentityOf(store);
  const beforeIdentity = audit.before.map(r => String(r.candidate_id)).sort();
  const structural = {
    events: store.events.length,
    events_with_selections: store.events.filter(e => e.selectedStructures.length).length,
    selected_structures: identity.length,
    generated_candidates: store.events.reduce((n, e) => n + e.generationSnapshot.candidates.length, 0),
    duplicate_candidate_ids: identity.length - new Set(identity.map(r => r.candidateId)).size,
    candidate_ids_match_pre_recompute:
      JSON.stringify(identity.map(r => r.candidateId).sort()) === JSON.stringify(beforeIdentity),
    // Re-derived from the persisted store, so this is not merely the runner's word.
    differences_against_pre_recompute: structuralDifferences(
      identity, structuralIdentityOf(store)),
    economics_rows_per_candidate: tally(economics.map(r => str(r.candidate_id))),
    economics_one_row_each: economics.length === new Set(economics.map(r => r.candidate_id)).size,
    execution_rows: candidates.length,
    execution_scenarios: tally(candidates.map(r => str(r.execution_scenario))),
    actual_dte_scenario_independent: (() => {
      const byCandidate = new Map<string, Set<string>>();
      for (const r of candidates) {
        const key = String(r.candidate_id);
        const set = byCandidate.get(key) ?? new Set<string>();
        set.add(String(r.actual_dte_days ?? r.actual_dte_hours ?? "none"));
        byCandidate.set(key, set);
      }
      return [...byCandidate.values()].every(s => s.size === 1);
    })(),
  };

  /* ---------- tier usage across every Reference point ---------- */

  const tierRows: Row[] = [];
  for (const event of store.events) for (const structure of event.selectedStructures) {
    const reference = obj(structure.referenceValuation as unknown);
    const entry = obj(reference.entrySnapshot);
    const provenance = obj(obj(entry.referenceProvenance).short);
    tierRows.push({
      event_id: event.eventId, candidate_id: structure.candidateId, role: "entry",
      status: reference.status, source: reference.source,
      short_source: str(provenance.source),
      long_source: str(obj(obj(entry.referenceProvenance).long).source),
      coherence_fallback: obj(entry.referenceProvenance).coherenceFallback ? true : false,
      unique_strikes: num(provenance.unique_qualifying_strike_count),
      lower_strike: num(provenance.lower_strike), upper_strike: num(provenance.upper_strike),
      lower_age: num(provenance.lower_observation_age_minutes),
      upper_age: num(provenance.upper_observation_age_minutes),
      declined: str(provenance.interpolation_declined_reason),
      anchor_age: num(provenance.anchor_age_minutes),
    });
    for (const point of arr(reference.valuationPathSnapshot)) {
      const p = obj(obj(point.referenceProvenance).short);
      // A path mark records its tier as `ivSource` rather than as leg
      // provenance, so the audit reads what the point actually carries instead
      // of reporting every path mark as untiered.
      const pathTier = str(point.ivSource) === "same-expiry-interpolation"
        ? "same_expiry_linear_interpolation"
        : str(point.ivSource) === "local-observed-IV" ? "local_iv_anchor"
          : str(point.ivSource);
      tierRows.push({
        event_id: event.eventId, candidate_id: structure.candidateId, role: "path",
        status: point.status, timestamp: num(point.timestamp),
        iv_source: str(point.ivSource),
        short_source: str(p.source) ?? pathTier,
        long_source: str(obj(obj(point.referenceProvenance).long).source) ?? pathTier,
        coherence_fallback: obj(point.referenceProvenance).coherenceFallback ? true : false,
        unique_strikes: num(p.unique_qualifying_strike_count),
        lower_strike: num(p.lower_strike), upper_strike: num(p.upper_strike),
        lower_age: num(p.lower_observation_age_minutes), upper_age: num(p.upper_observation_age_minutes),
        declined: str(p.interpolation_declined_reason), anchor_age: num(p.anchor_age_minutes),
      });
    }
    for (const outcome of arr(reference.outcomeSnapshots))
      tierRows.push({
        event_id: event.eventId, candidate_id: structure.candidateId, role: "outcome",
        label: str(outcome.label), status: str(outcome.status),
        iv_source: str(outcome.ivSource),
      });
  }

  const entryRows = tierRows.filter(r => r.role === "entry");
  const pathRows = tierRows.filter(r => r.role === "path");
  // Bracket geometry is recorded on entry marks; path marks record only their
  // tier. Geometry statistics therefore come from the rows that carry it, and
  // the tier counts come from all of them.
  const interpolated = entryRows.filter(r => r.short_source === "same_expiry_linear_interpolation");
  const interpolatedAll = [...entryRows, ...pathRows].filter(r => r.short_source === "same_expiry_linear_interpolation");

  /* ---------- interpolation integrity ---------- */

  const integrity = {
    interpolation_points_total: interpolatedAll.length,
    interpolation_points_with_geometry: interpolated.length,
    all_bracketed: interpolated.every(r => r.lower_strike !== null && r.upper_strike !== null),
    all_meet_rule_c: interpolated.every(r => (num(r.unique_strikes) ?? 0) >= RULE_C_MINIMUM_UNIQUE_STRIKES),
    below_rule_c: interpolated.filter(r => (num(r.unique_strikes) ?? 0) < RULE_C_MINIMUM_UNIQUE_STRIKES).length,
    all_evidence_within_60m: interpolated.every(r =>
      (num(r.lower_age) ?? 0) <= 60 && (num(r.upper_age) ?? 0) <= 60),
    unique_strike_distribution: quantiles(interpolated.map(r => num(r.unique_strikes) ?? 0)),
    bracket_width_distribution: quantiles(interpolated.flatMap(r => {
      const lo = num(r.lower_strike), hi = num(r.upper_strike);
      return lo !== null && hi !== null ? [hi - lo] : [];
    })),
    observation_age_distribution: quantiles(interpolated.flatMap(r =>
      [num(r.lower_age), num(r.upper_age)].filter((x): x is number => x !== null))),
    decline_reasons_entry: tally(entryRows
      .filter(r => r.short_source !== "same_expiry_linear_interpolation").map(r => str(r.declined))),
    path_tier_counts: tally(pathRows.map(r => str(r.short_source))),
    // Nothing from a surface model may ever appear.
    forbidden_sources_present: tierRows.some(r =>
      ["surface_interpolation", "surface_extrapolation", "dvol_anchored_smile_proxy"].includes(String(r.short_source))),
  };

  /* ---------- old versus new ---------- */

  const beforeById = new Map(audit.before.map(r => [String(r.candidate_id), r]));
  const afterById = new Map(audit.after.map(r => [String(r.candidate_id), r]));
  const entryDiffs: Row[] = [];
  for (const [candidateId, before] of beforeById) {
    const after = afterById.get(candidateId);
    if (!after) continue;
    const be = obj(before.entry), ae = obj(after.entry);
    if (!Object.keys(be).length || !Object.keys(ae).length) continue;
    const bl = legsOf(be), al = legsOf(ae);
    entryDiffs.push({
      candidate_id: candidateId,
      old_source: before.source, new_source: after.source,
      old_short: num(bl.short.priceBtcPerContract), new_short: num(al.short.priceBtcPerContract),
      old_long: num(bl.long.priceBtcPerContract), new_long: num(al.long.priceBtcPerContract),
      old_credit: num(be.grossSpreadBtcPerContract), new_credit: num(ae.grossSpreadBtcPerContract),
      old_net: num(be.netOpeningCashFlowBtc), new_net: num(ae.netOpeningCashFlowBtc),
    });
  }
  const creditDeltas = entryDiffs.flatMap(r => {
    const o = num(r.old_credit), n = num(r.new_credit);
    return o !== null && n !== null ? [n - o] : [];
  });

  // Matched path points, by candidate and timestamp.
  const pathDeltas: number[] = [];
  let pathMatched = 0, pathOldOnly = 0, pathNewOnly = 0;
  for (const [candidateId, before] of beforeById) {
    const after = afterById.get(candidateId);
    if (!after) continue;
    const oldPoints = new Map(arr(before.path).map(p => [num(p.timestamp), p]));
    const newPoints = new Map(arr(after.path).map(p => [num(p.timestamp), p]));
    for (const [timestamp, oldPoint] of oldPoints) {
      const newPoint = newPoints.get(timestamp);
      if (!newPoint) { pathOldOnly += 1; continue; }
      pathMatched += 1;
      const o = num(oldPoint.closingSpreadValueBtcPerContract) ?? num(oldPoint.estimatedNetPnlBtc);
      const n = num(newPoint.closingSpreadValueBtcPerContract) ?? num(newPoint.estimatedNetPnlBtc);
      if (o !== null && n !== null) pathDeltas.push(n - o);
    }
    for (const timestamp of newPoints.keys()) if (!oldPoints.has(timestamp)) pathNewOnly += 1;
  }

  // Outcomes, by label.
  const outcomeDiffs: Row[] = [];
  for (const [candidateId, before] of beforeById) {
    const after = afterById.get(candidateId);
    if (!after) continue;
    const oldByLabel = new Map(arr(before.outcomes).map(o => [str(o.label), o]));
    const newByLabel = new Map(arr(after.outcomes).map(o => [str(o.label), o]));
    for (const [label, oldOutcome] of oldByLabel) {
      const newOutcome = newByLabel.get(label);
      if (!newOutcome) continue;
      outcomeDiffs.push({
        candidate_id: candidateId, label,
        old_status: str(oldOutcome.status), new_status: str(newOutcome.status),
        old_pnl: num(oldOutcome.estimatedNetPnlBtc), new_pnl: num(newOutcome.estimatedNetPnlBtc),
        old_timestamp: num(oldOutcome.valuationTimestamp), new_timestamp: num(newOutcome.valuationTimestamp),
      });
    }
  }
  const outcomeDelta = (label: string) => quantiles(outcomeDiffs
    .filter(r => String(r.label).includes(label))
    .flatMap(r => {
      const o = num(r.old_pnl), n = num(r.new_pnl);
      return o !== null && n !== null ? [n - o] : [];
    }));
  const settlement = outcomeDiffs.filter(r => String(r.label) === "Settlement");
  const captureTimingChanges = outcomeDiffs.filter(r =>
    /credit/i.test(String(r.label)) && r.old_timestamp !== r.new_timestamp);

  const report = {
    generated_at_utc: new Date().toISOString(),
    dataset_id: datasetId,
    recompute: {refreshed: audit.refreshed, api_requests: audit.api_requests,
      diagnostics: audit.diagnostics},
    bundle: {
      valid: validation.ok, errors: validation.errors.slice(0, 20),
      schema_version: RESEARCH_BUNDLE_SCHEMA_VERSION,
      reference_methodology: CURRENT_RESEARCH_ENGINE_VERSIONS.referenceValuation,
      run_id: bundle.run.run_id,
      effective_configuration_hash: bundle.run.effective_configuration_hash,
      table_availability: bundle.run.table_availability,
      counts: {
        events: rows("events.jsonl").length, candidates: candidates.length,
        availability: availability.length, valuations: valuations.length,
        outcomes: outcomes.length, structure_economics: economics.length,
        event_volatility_state: volatility.length,
        structure_volatility_state: rows("structure_volatility_state.jsonl").length,
        margin_scenarios: rows("margin_scenarios.jsonl").length,
        evidence_trades: rows("evidence_trades.jsonl").length,
      },
    },
    structural,
    tier_usage: {
      entry: tally(entryRows.map(r => str(r.short_source))),
      entry_pairs: tally(entryRows.map(r => `${str(r.short_source)}/${str(r.long_source)}`)),
      path: tally(pathRows.map(r => str(r.short_source))),
      outcome_iv_source: tally(tierRows.filter(r => r.role === "outcome").map(r => str(r.iv_source))),
      by_event: Object.fromEntries([...new Set(tierRows.map(r => String(r.event_id)))].sort().map(e =>
        [e, tally([...entryRows, ...pathRows].filter(r => String(r.event_id) === e).map(r => str(r.short_source)))])),
    },
    coherence: {
      entry_fallbacks: entryRows.filter(r => r.coherence_fallback).length,
      path_fallbacks: pathRows.filter(r => r.coherence_fallback).length,
      entry_refusals: entryRows.filter(r => r.status !== "valued").length,
      total_entry_marks: entryRows.length,
      total_path_marks: pathRows.length,
    },
    interpolation_integrity: integrity,
    old_versus_new: {
      entry: {
        compared: entryDiffs.length,
        source_transitions: tally(entryDiffs.map(r => `${r.old_source} -> ${r.new_source}`)),
        credit_delta: quantiles(creditDeltas),
        absolute_credit_delta: quantiles(creditDeltas.map(Math.abs)),
        largest: [...entryDiffs].sort((a, b) =>
          Math.abs((num(b.new_credit) ?? 0) - (num(b.old_credit) ?? 0))
          - Math.abs((num(a.new_credit) ?? 0) - (num(a.old_credit) ?? 0))).slice(0, 5),
      },
      path: {
        matched: pathMatched, old_only: pathOldOnly, new_only: pathNewOnly,
        delta: quantiles(pathDeltas), absolute_delta: quantiles(pathDeltas.map(Math.abs)),
      },
      outcomes: {
        compared: outcomeDiffs.length,
        status_transitions: tally(outcomeDiffs.map(r => `${r.old_status} -> ${r.new_status}`)),
        vpoc_delta: outcomeDelta("VPOC"),
        invalidation_delta: outcomeDelta("Invalidation"),
        fixed_3d_delta: outcomeDelta("3D"), fixed_5d_delta: outcomeDelta("5D"), fixed_7d_delta: outcomeDelta("7D"),
        capture_timing_changes: captureTimingChanges.length,
        settlement: {
          compared: settlement.length,
          unchanged: settlement.filter(r => {
            const o = num(r.old_pnl), n = num(r.new_pnl);
            return o !== null && n !== null && Math.abs(n - o) < 1e-12;
          }).length,
          delta: quantiles(settlement.flatMap(r => {
            const o = num(r.old_pnl), n = num(r.new_pnl);
            return o !== null && n !== null ? [n - o] : [];
          })),
        },
      },
    },
    execution_independence: {
      // A Reference mark must exist regardless of maker/taker evidence.
      structures_with_reference: store.events.reduce((n, e) => n + e.selectedStructures
        .filter(s => obj(s.referenceValuation as unknown).status === "valued").length, 0),
      structures_with_no_execution_scenario: store.events.reduce((n, e) => n + e.selectedStructures
        .filter(s => {
          const scenarios = obj(s.executionScenarios as unknown);
          return obj(scenarios.maker).status !== "evaluated" && obj(scenarios.taker).status !== "evaluated";
        }).length, 0),
      referenced_but_unexecuted: store.events.reduce((n, e) => n + e.selectedStructures
        .filter(s => {
          const scenarios = obj(s.executionScenarios as unknown);
          return obj(s.referenceValuation as unknown).status === "valued"
            && obj(scenarios.maker).status !== "evaluated" && obj(scenarios.taker).status !== "evaluated";
        }).length, 0),
    },
    entry_rows: entryRows,
  };
  await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stderr.write(`bundle valid=${validation.ok}; ${entryRows.length} entry, ${pathRows.length} path marks\n`);
}

main().catch(e => {
  const error = e as Error & {details?: unknown};
  process.stderr.write(`FAILED: ${error.message}\n${error.stack ?? ""}\n`);
  process.exitCode = 1;
});
