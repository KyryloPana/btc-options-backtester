/**
 * Measure which Reference tier the promoted hierarchy actually selects, on the
 * real structures at the real canonical valuation points.
 *
 * Read-only. This does NOT regenerate the research bundle -- it cannot, because
 * the recompute path has no driver (see the Phase 2C-B report). What it can do
 * is drive the promoted `valueReferenceLeg` over the Phase 2A.3 cross-section
 * cache, which holds the genuine same-expiry tape at 669 causal targets, and
 * report the tier distribution that a regeneration would produce.
 *
 * The cache observations are already admitted market evidence, so this measures
 * the hierarchy rather than re-testing admission.
 *
 *   node --experimental-strip-types scripts/measure-reference-tier-usage.ts \
 *     <readinessJson> <structuresJsonl> <outJson>
 */

import {readFile, writeFile} from "node:fs/promises";
import {
  snapshotFromObservations, type CrossSectionObservation, type SurfaceSnapshot,
} from "../app/lib/volatility/cross-section.ts";
import {aggregateSlice} from "../app/lib/volatility/strike-aggregation.ts";
import {
  RULE_C_MINIMUM_UNIQUE_STRIKES, valueReferenceLeg, type ReferenceLegValuation,
} from "../app/lib/volatility/reference-hybrid.ts";
import type {ContractSeries, ContractTrade} from "../app/lib/backtester.ts";
import {
  listCrossSectionShards, readCrossSectionObservations, readCrossSectionSnapshots,
} from "./cross-section-cache.ts";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

async function loadSnapshots(): Promise<Map<number, SurfaceSnapshot>> {
  const out = new Map<number, SurfaceSnapshot>();
  for (const shard of await listCrossSectionShards()) {
    const headers = await readCrossSectionSnapshots(shard);
    const observations = await readCrossSectionObservations(shard);
    const byTarget = new Map<number, CrossSectionObservation[]>();
    for (const o of observations) {
      const list = byTarget.get(o.target_timestamp_ms);
      if (list) list.push(o); else byTarget.set(o.target_timestamp_ms, [o]);
    }
    for (const header of headers) {
      const target = num(header.target_timestamp_ms);
      if (target === null) continue;
      const rest = Object.fromEntries(Object.entries(header).filter(([k]) => k !== "slices"));
      out.set(target, snapshotFromObservations(
        rest as unknown as Omit<SurfaceSnapshot, "observations" | "slices">, byTarget.get(target) ?? []));
    }
  }
  return out;
}

/** Rebuild a ContractSeries-shaped view of one instrument from cached observations. */
function seriesFor(observations: readonly CrossSectionObservation[]): ContractSeries[] {
  const byInstrument = new Map<string, CrossSectionObservation[]>();
  for (const o of observations) {
    const list = byInstrument.get(o.instrument_name);
    if (list) list.push(o); else byInstrument.set(o.instrument_name, [o]);
  }
  return [...byInstrument.values()].map(rows => {
    const first = rows[0]!;
    const trades: ContractTrade[] = rows.map(o => ({
      timestamp: o.timestamp_ms, price: o.trade_price ?? 0, markPrice: o.mark_price ?? undefined,
      iv: o.iv_api_percentage, ivApiPercent: o.iv_api_percentage, ivDecimal: o.iv_decimal,
      instrumentName: o.instrument_name, indexPrice: o.index_price,
      direction: (o.direction === "sell" ? "sell" : "buy"), amount: o.amount ?? 0,
      tradeId: o.trade_id ?? undefined,
    }));
    return {
      instrumentName: first.instrument_name, expiryTimestamp: first.expiry_timestamp_ms,
      expiryLabel: first.expiry_timestamp_utc.slice(0, 10), strike: first.strike,
      optionType: first.option_type, trades,
      firstTradeTimestamp: Math.min(...trades.map(t => t.timestamp)),
      lastTradeTimestamp: Math.max(...trades.map(t => t.timestamp)),
      sourceFiles: ["cross-section-cache"],
      creationTimestamp: first.contract_created_at_utc ? Date.parse(first.contract_created_at_utc) : undefined,
    };
  });
}

async function main() {
  const [readinessPath, structuresPath, outPath] = process.argv.slice(2);
  if (!readinessPath || !structuresPath || !outPath)
    throw new Error("usage: measure-reference-tier-usage.ts <readinessJson> <structuresJsonl> <outJson>");

  const readiness = JSON.parse(await readFile(readinessPath, "utf8")) as {readiness: Row[]};
  const structures = (await readFile(structuresPath, "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as Row);
  const snapshots = await loadSnapshots();
  process.stderr.write(`snapshots ${snapshots.size}; structures ${structures.length}\n`);

  const byCandidate = new Map(structures.map(s => [String(s.candidate_id), s]));
  const rows: Row[] = [];

  for (const point of readiness.readiness) {
    const candidateId = str(point.candidate_id);
    const structure = candidateId ? byCandidate.get(candidateId) : undefined;
    const target = num(point.target_timestamp_ms);
    if (!structure || target === null) continue;
    const snapshot = snapshots.get(target);
    if (!snapshot) continue;

    const expiryMs = Date.parse(String(structure.expiry_timestamp_utc));
    const sameExpiry = snapshot.observations.filter(o => o.expiry_timestamp_ms === expiryMs);
    const ladder = seriesFor(sameExpiry);

    for (const side of ["short", "long"] as const) {
      const instrument = str(structure[`${side}_instrument`]);
      const strike = num(structure[`${side}_strike`]);
      if (!instrument || strike === null) continue;
      const own = ladder.find(s => s.instrumentName === instrument);
      const leg: ContractSeries = own ?? {
        instrumentName: instrument, expiryTimestamp: expiryMs,
        expiryLabel: new Date(expiryMs).toISOString().slice(0, 10), strike,
        optionType: String(structure.option_type) === "P" ? "P" : "C", trades: [],
        firstTradeTimestamp: 0, lastTradeTimestamp: 0, sourceFiles: ["cache"],
      };
      // Own legs excluded, exactly as production does.
      const excluded = ladder.filter(s => s.instrumentName !== instrument);
      const points = aggregateSlice(sameExpiry.filter(o => o.instrument_name !== instrument));
      const anchor = own?.trades.filter(t => t.timestamp <= target)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      const valuation: ReferenceLegValuation = valueReferenceLeg({
        leg, targetTimestampMs: target, underlyingPrice: snapshot.underlying_price,
        crossSection: {
          points, uniqueStrikeCount: new Set(points.map(p => p.strike)).size,
          observationCount: points.length, maxAgeMinutes: 60,
          underlyingPrice: snapshot.underlying_price,
          forwardPrice: sameExpiry[0]?.forward_price ?? null,
          forwardMethodVersion: sameExpiry[0]?.forward_method_version ?? null,
          forwardEvidenceTimestampMs: sameExpiry[0]?.forward_evidence_timestamp_ms ?? null,
          forwardObservationCount: sameExpiry[0]?.forward_observation_count ?? 0,
          forwardUnavailableReason: sameExpiry[0]?.forward_price ? null : "no_causal_forward_evidence",
        },
        anchor,
      });
      void excluded;
      rows.push({
        event_id: str(point.event_id), candidate_id: candidateId, side,
        role: str(point.role), target_timestamp_ms: target,
        hours_since_entry: num(point.hours_since_entry),
        actual_dte_days: num(point.actual_dte_days),
        source: valuation.source,
        declined: valuation.interpolation_declined_reason,
        unavailable_reason: valuation.unavailable_reason,
        unique_strikes: valuation.unique_qualifying_strike_count,
        lower_strike: valuation.lower_strike, upper_strike: valuation.upper_strike,
        anchor_age_minutes: valuation.anchor_age_minutes,
        iv_decimal: valuation.iv_decimal,
      });
    }
  }

  const tally = (key: string, filter: (r: Row) => boolean = () => true) =>
    rows.filter(filter).reduce<Record<string, number>>((m, r) => {
      const k = String(r[key] ?? "none"); m[k] = (m[k] ?? 0) + 1; return m;
    }, {});
  const bucket = (d: number) => d < 1 ? "0-1d" : d < 3 ? "1-3d" : d < 7 ? "3-7d"
    : d < 14 ? "7-14d" : d < 30 ? "14-30d" : "30d+";

  const report = {
    generated_at_utc: new Date().toISOString(),
    rule_c_minimum_unique_strikes: RULE_C_MINIMUM_UNIQUE_STRIKES,
    leg_valuation_count: rows.length,
    distinct_targets: new Set(rows.map(r => r.target_timestamp_ms)).size,
    distinct_candidates: new Set(rows.map(r => r.candidate_id)).size,
    source_overall: tally("source"),
    source_at_entry: tally("source", r => r.role === "entry"),
    source_on_path: tally("source", r => r.role !== "entry"),
    decline_reasons: tally("declined", r => r.source !== "same_expiry_linear_interpolation"),
    unavailable_reasons: tally("unavailable_reason", r => r.source === "unavailable"),
    by_event: Object.fromEntries([...new Set(rows.map(r => String(r.event_id)))].sort()
      .map(e => [e, tally("source", r => String(r.event_id) === e)])),
    by_dte: Object.fromEntries(["0-1d", "1-3d", "3-7d", "7-14d", "14-30d", "30d+"]
      .map(b => [b, tally("source", r => bucket(num(r.actual_dte_days) ?? 0) === b)])),
    interpolation_geometry: (() => {
      const interpolated = rows.filter(r => r.source === "same_expiry_linear_interpolation");
      const strikes = interpolated.map(r => num(r.unique_strikes) ?? 0).sort((a, b) => a - b);
      const gaps = interpolated.flatMap(r => {
        const lower = num(r.lower_strike), upper = num(r.upper_strike);
        return lower !== null && upper !== null ? [upper - lower] : [];
      }).sort((a, b) => a - b);
      const q = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null;
      return {
        count: interpolated.length,
        unique_strikes: {min: strikes[0] ?? null, median: q(strikes, 0.5), max: strikes.at(-1) ?? null},
        bracket_width: {min: gaps[0] ?? null, median: q(gaps, 0.5), p90: q(gaps, 0.9), max: gaps.at(-1) ?? null},
        // The rule is a floor, so this must never be below it.
        below_rule_c: strikes.filter(s => s < RULE_C_MINIMUM_UNIQUE_STRIKES).length,
      };
    })(),
    rows,
  };
  await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stderr.write(`done: ${rows.length} leg valuations\n`);
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
