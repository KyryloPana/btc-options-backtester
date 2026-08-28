/**
 * Phase 2A.3 measurement: can the causal Deribit cross-section identify a
 * surface at the real selected structures, at entry AND along the valuation path?
 *
 * Read-only research tool. It fits nothing, prices nothing and changes no
 * methodology; it retrieves evidence, records geometry and counts outcomes.
 *
 * One snapshot per (event, target timestamp) is retrieved once and reused by
 * every structure and every expiry at that timestamp, because a single
 * `get_last_trades_by_currency_and_time` call already returns the whole option
 * tape for the window.
 *
 *   node --experimental-strip-types scripts/measure-surface-readiness.ts <inputDir> <outJson> [--path-only|--entry-only]
 */

import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {MARKET_IV_DIAGNOSTIC_AGE_MINUTES, MARKET_IV_MAX_AGE_MINUTES} from "../app/lib/volatility/market-iv-evidence.ts";
import {
  buildSurfaceSnapshot, classifyLeg, classifySurfaceReadiness, maturityCoverage,
  observationsFor, sliceFor,
  type LegEvidence, type SurfaceSnapshot,
} from "../app/lib/volatility/cross-section.ts";
import {
  buildSingleContractHoldouts, buildSpreadHoldout, summarizeHoldouts,
  type HoldoutCase, type SpreadHoldoutCase,
} from "../app/lib/volatility/holdout.ts";
import {
  CrossSectionRetrieval, causalUnderlyingPrice, writeCrossSectionShards,
} from "./cross-section-cache.ts";

const FOUR_HOURS_MS = 4 * 3_600_000;
/** Single-contract holdouts are built at entry, named points, and every Nth path point. */
const HOLDOUT_PATH_STRIDE = 6;

type Row = Record<string, unknown>;
const jsonl = async (dir: string, name: string): Promise<Row[]> =>
  (await readFile(join(dir, name), "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as Row);
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const ms = (v: unknown): number | null => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};

interface Structure {
  candidateId: string; eventId: string; entryMs: number; expiryMs: number;
  optionType: string | null; shortStrike: number; longStrike: number;
  shortInstrument: string; longInstrument: string;
}

/** Readiness for one structure at one target timestamp. */
interface StructureReadinessRow {
  event_id: string; candidate_id: string; target_timestamp_utc: string;
  target_timestamp_ms: number; role: string;
  hours_since_entry: number; actual_dte_days: number;
  underlying_price: number;
  expiry_timestamp_utc: string;
  option_type: string | null; short_strike: number; long_strike: number;
  same_expiry_strike_count: number; same_expiry_trade_count: number;
  same_expiry_call_count: number; same_expiry_put_count: number;
  atm_bracketed: boolean;
  min_log_moneyness: number | null; max_log_moneyness: number | null;
  freshest_age_minutes: number | null; median_age_minutes: number | null; p95_age_minutes: number | null;
  short_leg: LegEvidence; long_leg: LegEvidence;
  readiness: string; readiness_rationale: string;
  adjacent_usable_expiry_count: number;
  maturity_bracketed: boolean;
  nearest_expiry_below_dte_days: number | null;
  nearest_expiry_above_dte_days: number | null;
  largest_maturity_gap_days: number | null;
  snapshot_id: string;
}

function structureReadiness(
  snapshot: SurfaceSnapshot, structure: Structure, role: string,
): StructureReadinessRow {
  const slice = sliceFor(snapshot, structure.expiryMs);
  const sameExpiry = observationsFor(snapshot, structure.expiryMs);
  const legInput = {
    optionType: structure.optionType, underlyingPrice: snapshot.underlying_price,
    slice, observations: sameExpiry,
  };
  const shortLeg = classifyLeg({leg: "short", strike: structure.shortStrike,
    instrumentName: structure.shortInstrument, ...legInput});
  const longLeg = classifyLeg({leg: "long", strike: structure.longStrike,
    instrumentName: structure.longInstrument, ...legInput});
  const adjacent = snapshot.slices.filter(s => s.expiry_timestamp_ms !== structure.expiryMs);
  const verdict = classifySurfaceReadiness({slice, legs: [shortLeg, longLeg], adjacentSlices: adjacent});
  const maturity = maturityCoverage(snapshot.slices, structure.expiryMs);

  return {
    event_id: structure.eventId, candidate_id: structure.candidateId,
    target_timestamp_utc: snapshot.target_timestamp_utc,
    target_timestamp_ms: snapshot.target_timestamp_ms, role,
    hours_since_entry: (snapshot.target_timestamp_ms - structure.entryMs) / 3_600_000,
    actual_dte_days: (structure.expiryMs - snapshot.target_timestamp_ms) / 86_400_000,
    underlying_price: snapshot.underlying_price,
    expiry_timestamp_utc: new Date(structure.expiryMs).toISOString(),
    option_type: structure.optionType,
    short_strike: structure.shortStrike, long_strike: structure.longStrike,
    same_expiry_strike_count: slice?.unique_strike_count ?? 0,
    same_expiry_trade_count: slice?.qualifying_trade_count ?? 0,
    same_expiry_call_count: slice?.call_count ?? 0,
    same_expiry_put_count: slice?.put_count ?? 0,
    atm_bracketed: slice?.atm_bracketed ?? false,
    min_log_moneyness: slice?.min_log_moneyness ?? null,
    max_log_moneyness: slice?.max_log_moneyness ?? null,
    freshest_age_minutes: slice?.freshest_age_minutes ?? null,
    median_age_minutes: slice?.median_age_minutes ?? null,
    p95_age_minutes: slice?.p95_age_minutes ?? null,
    short_leg: shortLeg, long_leg: longLeg,
    readiness: verdict.readiness, readiness_rationale: verdict.rationale,
    adjacent_usable_expiry_count: verdict.adjacent_usable_expiry_count,
    maturity_bracketed: maturity.target_expiry_bracketed_in_maturity,
    nearest_expiry_below_dte_days: maturity.nearest_expiry_below_dte_days,
    nearest_expiry_above_dte_days: maturity.nearest_expiry_above_dte_days,
    largest_maturity_gap_days: maturity.largest_maturity_gap_days,
    snapshot_id: snapshot.snapshot_id,
  };
}

async function main() {
  const [inputDir, outPath, ...flags] = process.argv.slice(2);
  if (!inputDir || !outPath) throw new Error("usage: measure-surface-readiness.ts <inputDir> <outJson> [--entry-only]");
  const entryOnly = flags.includes("--entry-only");

  const eventRows = await jsonl(inputDir, "events.jsonl");
  const structureRows = await jsonl(inputDir, "structures.jsonl");
  const events = new Map(eventRows.map(e => [str(e.event_id)!, e]));

  const structures: Structure[] = structureRows.map(r => ({
    candidateId: str(r.candidate_id)!, eventId: str(r.event_id)!,
    entryMs: ms(r.entry_timestamp_utc)!, expiryMs: ms(r.expiry_timestamp_utc)!,
    optionType: str(r.option_type),
    shortStrike: num(r.short_strike)!, longStrike: num(r.long_strike)!,
    shortInstrument: str(r.short_instrument)!, longInstrument: str(r.long_instrument)!,
  }));

  const retrieval = new CrossSectionRetrieval();
  process.stderr.write("manifest: fetching...\n");
  const manifest = await retrieval.instrumentManifest();
  process.stderr.write(`manifest: ${manifest.length} instruments\n`);

  // Snapshots are flushed to the shard cache per event rather than accumulated:
  // the full path is hundreds of snapshots of hundreds of observations each, and
  // holding all of them would be a needless several hundred megabytes.
  let pending: SurfaceSnapshot[] = [];
  let snapshotsBuilt = 0;
  const shardsWritten = new Set<string>(), shardsReused = new Set<string>();
  let cacheManifest: Awaited<ReturnType<typeof writeCrossSectionShards>>["manifest"] | null = null;
  const flush = async () => {
    if (!pending.length) return;
    const result = await writeCrossSectionShards({snapshots: pending});
    for (const s of result.shardsWritten) shardsWritten.add(s);
    for (const s of result.shardsReused) shardsReused.add(s);
    cacheManifest = result.manifest;
    pending = [];
  };
  const readinessRows: StructureReadinessRow[] = [];
  const entryDiagnostics: Row[] = [];
  const asymmetry: Row[] = [];
  const holdouts: HoldoutCase[] = [];
  const spreadHoldouts: SpreadHoldoutCase[] = [];
  const snapshotIndex: Row[] = [];

  for (const [eventId, event] of events) {
    const own = structures.filter(s => s.eventId === eventId);
    if (!own.length) { process.stderr.write(`event ${eventId}: no structures, skipped\n`); continue; }
    const entryMs = ms(event.entry_timestamp_utc)!;
    const lastExpiry = Math.max(...own.map(s => s.expiryMs));

    // Targets: entry, every scheduled 4h point up to the last expiry, plus the
    // named decision timestamps that fall inside the window.
    const named = new Map<number, string>();
    named.set(entryMs, "entry");
    for (const [key, role] of [["vpoc_decision_timestamp_utc", "vpoc"],
      ["invalidation_decision_timestamp_utc", "invalidation"], ["exit_timestamp_utc", "exit"]] as const) {
      const t = ms(event[key]);
      if (t !== null && t > entryMs && t <= lastExpiry) named.set(t, role);
    }
    const targets = new Set<number>(named.keys());
    if (!entryOnly)
      for (let t = entryMs + FOUR_HOURS_MS; t <= lastExpiry; t += FOUR_HOURS_MS) targets.add(t);
    const ordered = [...targets].sort((a, b) => a - b);
    process.stderr.write(`event ${eventId}: ${ordered.length} targets, ${own.length} structures\n`);

    let index = 0;
    for (const target of ordered) {
      index += 1;
      const role = named.get(target) ?? "scheduled_4h";
      const prints = await retrieval.optionPrints(target - MARKET_IV_MAX_AGE_MINUTES * 60_000, target);
      const underlying = causalUnderlyingPrice(prints, target);
      if (underlying === null) {
        snapshotIndex.push({event_id: eventId, target_timestamp_utc: new Date(target).toISOString(),
          role, status: "no_causal_underlying", trade_count: prints.length});
        continue;
      }
      const snapshot = buildSurfaceSnapshot({
        prints, targetTimestampMs: target, underlyingPrice: underlying,
        sourceHost: retrieval.host,
      });
      pending.push(snapshot);
      snapshotsBuilt += 1;
      snapshotIndex.push({
        event_id: eventId, target_timestamp_utc: snapshot.target_timestamp_utc, role,
        status: "built", snapshot_id: snapshot.snapshot_id, content_hash: snapshot.content_hash,
        raw_prints: prints.length, admitted: snapshot.admitted_count,
        duplicates_removed: snapshot.duplicates_removed,
        rejected: snapshot.rejected as unknown as Row,
        expiry_slices: snapshot.slices.length, underlying_price: underlying,
      });

      for (const structure of own) {
        // A structure is only priceable while it exists.
        if (target > structure.expiryMs) continue;
        readinessRows.push(structureReadiness(snapshot, structure, role));
      }

      // Holdouts: entry and named points always, plus a strided sample of the
      // scheduled path so DTE decay is represented without exploding the set.
      const wantHoldouts = role !== "scheduled_4h" || index % HOLDOUT_PATH_STRIDE === 0;
      if (wantHoldouts) {
        for (const expiryMs of [...new Set(own.filter(s => target <= s.expiryMs).map(s => s.expiryMs))])
          holdouts.push(...buildSingleContractHoldouts({snapshot, expiryTimestampMs: expiryMs, eventId}));
        for (const structure of own) {
          if (target > structure.expiryMs) continue;
          const spread = buildSpreadHoldout({
            snapshot, expiryTimestampMs: structure.expiryMs,
            eventId, candidateId: structure.candidateId,
            optionType: structure.optionType,
            shortStrike: structure.shortStrike, longStrike: structure.longStrike,
            shortInstrument: structure.shortInstrument, longInstrument: structure.longInstrument,
          });
          if (spread) spreadHoldouts.push(spread);
        }
      }

      // Entry-only extras: the 240-minute diagnostic window, used ONLY to
      // diagnose the short-vs-long asymmetry. It never touches canonical
      // readiness, which stays a 60-minute question.
      if (role === "entry") {
        const wide = await retrieval.optionPrints(target - MARKET_IV_DIAGNOSTIC_AGE_MINUTES * 60_000, target);
        const wideSnapshot = buildSurfaceSnapshot({
          prints: wide, targetTimestampMs: target, underlyingPrice: underlying,
          sourceHost: retrieval.host, maxAgeMinutes: MARKET_IV_DIAGNOSTIC_AGE_MINUTES,
        });
        entryDiagnostics.push({
          event_id: eventId, target_timestamp_utc: snapshot.target_timestamp_utc,
          underlying_price: underlying,
          canonical_admitted: snapshot.admitted_count, diagnostic_admitted: wideSnapshot.admitted_count,
          canonical_prints: prints.length, diagnostic_prints: wide.length,
        });
        for (const structure of own) {
          const slice = sliceFor(snapshot, structure.expiryMs);
          const sameExpiry = observationsFor(snapshot, structure.expiryMs);
          const expiryForward = sameExpiry[0]?.forward_price;
          if (!(expiryForward && expiryForward > 0)) continue;
          const wideSame = observationsFor(wideSnapshot, structure.expiryMs);
          const countFor = (instrument: string, rows: typeof sameExpiry) =>
            rows.filter(o => o.instrument_name === instrument).length;
          const neighbourCount = (strike: number, within: number) =>
            sameExpiry.filter(o => Math.abs(o.strike - strike) <= within && o.strike !== strike).length;
          asymmetry.push({
            event_id: eventId, candidate_id: structure.candidateId,
            option_type: structure.optionType,
            underlying_price: underlying,
            short_instrument: structure.shortInstrument, long_instrument: structure.longInstrument,
            short_strike: structure.shortStrike, long_strike: structure.longStrike,
            short_log_moneyness: Math.log(structure.shortStrike / expiryForward),
            long_log_moneyness: Math.log(structure.longStrike / expiryForward),
            // Roundness is the liquidity hypothesis: 10k/5k strikes are far more
            // heavily traded than 1k-increment strikes.
            short_strike_round_10k: structure.shortStrike % 10_000 === 0,
            long_strike_round_10k: structure.longStrike % 10_000 === 0,
            short_strike_round_5k: structure.shortStrike % 5_000 === 0,
            long_strike_round_5k: structure.longStrike % 5_000 === 0,
            short_prints_60m: countFor(structure.shortInstrument, sameExpiry),
            long_prints_60m: countFor(structure.longInstrument, sameExpiry),
            short_prints_240m: countFor(structure.shortInstrument, wideSame),
            long_prints_240m: countFor(structure.longInstrument, wideSame),
            short_neighbours_within_2k: neighbourCount(structure.shortStrike, 2_000),
            long_neighbours_within_2k: neighbourCount(structure.longStrike, 2_000),
            short_listed: manifest.some(m => m.instrumentName === structure.shortInstrument),
            long_listed: manifest.some(m => m.instrumentName === structure.longInstrument),
            short_created_before_entry: manifest.find(m => m.instrumentName === structure.shortInstrument)?.createdAtMs ?? null,
            long_created_before_entry: manifest.find(m => m.instrumentName === structure.longInstrument)?.createdAtMs ?? null,
            same_expiry_strikes: slice?.unique_strike_count ?? 0,
          });
        }
      }
    }
    // Flushed here, at the end of each event, so the run never holds every
    // snapshot of every path point in memory at once.
    await flush();
    retrieval.clearWindowCache();
    process.stderr.write(`event ${eventId}: flushed, ${snapshotsBuilt} snapshots so far
`);
  }
  await flush();

  // Holdout cases are persisted by REFERENCE: the evidence already lives in the
  // shard cache, so copying every fitting input into every case would multiply
  // the same observations hundreds of times.
  const holdoutIndex = holdouts.map(h => ({
    case_id: h.case_id, mode: h.mode, snapshot_id: h.snapshot_id,
    target_timestamp_utc: h.target_timestamp_utc, event_id: h.event_id,
    expiry_timestamp_ms: h.expiry_timestamp_ms, actual_dte_days: h.actual_dte_days,
    withheld_instruments: h.withheld_instruments,
    fitting_input_count: h.fitting_inputs.length,
    truth: h.truth,
    remaining_strike_count: h.remaining_slice?.unique_strike_count ?? 0,
    remaining_atm_bracketed: h.remaining_slice?.atm_bracketed ?? false,
    remaining_readiness: h.remaining_readiness.readiness,
    content_hash: h.content_hash,
  }));
  const spreadIndex = spreadHoldouts.map(s => ({
    case_id: s.case_id, event_id: s.event_id, candidate_id: s.candidate_id,
    snapshot_id: s.snapshot_id, target_timestamp_utc: s.target_timestamp_utc,
    actual_dte_days: s.actual_dte_days, option_type: s.option_type,
    short_strike: s.short_strike, long_strike: s.long_strike,
    paired_truth_class: s.paired_truth_class,
    synchronization_gap_minutes: s.synchronization_gap_minutes,
    max_observation_age_minutes: s.max_observation_age_minutes,
    observed_spread_credit_native: s.observed_spread_credit_native,
    short_truth: s.short_truth, long_truth: s.long_truth,
    remaining_readiness: s.holdout.remaining_readiness.readiness,
    remaining_strike_count: s.holdout.remaining_slice?.unique_strike_count ?? 0,
  }));

  const report = {
    measured_at_utc: new Date().toISOString(),
    input_dir: inputDir,
    entry_only: entryOnly,
    canonical_window_minutes: MARKET_IV_MAX_AGE_MINUTES,
    diagnostic_window_minutes: MARKET_IV_DIAGNOSTIC_AGE_MINUTES,
    api_requests: retrieval.requestCount,
    cache_manifest: cacheManifest,
    shards_written: [...shardsWritten].sort(), shards_reused: [...shardsReused].sort(),
    snapshot_index: snapshotIndex,
    entry_diagnostics: entryDiagnostics,
    asymmetry,
    readiness: readinessRows,
    holdout_composition: summarizeHoldouts(holdouts),
    holdouts: holdoutIndex,
    spread_holdouts: spreadIndex,
  };
  await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stderr.write(
    `done: ${snapshotsBuilt} snapshots, ${readinessRows.length} readiness rows, ` +
    `${holdouts.length} holdouts, ${spreadHoldouts.length} spread holdouts, ` +
    `${retrieval.requestCount} API requests\n`);
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
