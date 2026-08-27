#!/usr/bin/env node
/**
 * Factual pricing sanity comparison for the corrected expiry-forward Reference.
 *
 * Reports, on real v4 calibration observations and WITHOUT reaching a verdict:
 *
 *   NEW      corrected causal expiry forward  -> primary fair premium
 *   LEGACY   index-as-forward proxy           -> same fair IV repriced at F = X
 *   MARK     Deribit's own mark price         -> the independent reference
 *
 * The legacy column is a CONVENTION-ISOLATING PROXY, not a v3 re-run: it holds
 * the v4 fair IV fixed and swaps only the pricing forward, so it measures the
 * effect of the forward convention on the premium. A full v3 reproduction would
 * additionally rebuild the smile on ln(K/X) coordinates, which this script
 * deliberately does not do -- reproducing a superseded methodology is not the
 * question being asked of it.
 *
 * The previous external audit found the old convention produced a strong
 * OPPOSITE-SIGN call/put bias against Deribit mark. That signature is what the
 * per-option-type medians below exist to expose or refute.
 *
 *   node --experimental-strip-types scripts/validate-expiry-forward-pricing.ts [root]
 */

import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {priceInverseOption} from "../app/lib/inverse-option-pricing.ts";
import {legacyIndexForwardDiagnostic, EXPIRY_FORWARD_METHOD_VERSION} from "../app/lib/volatility/expiry-forward.ts";
import {
  EXECUTION_CALIBRATION_METHOD_VERSION, type ExecutionCalibrationObservation,
} from "../app/lib/execution-calibration.ts";
import {REFERENCE_VALUATION_METHOD_VERSION} from "../app/lib/volatility/reference-hybrid.ts";

const DEFAULT_ROOT = ".local-cache/execution-calibration/execution_calibration_observations";

const quantile = (sorted: readonly number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : null;

function summarize(signed: readonly number[]) {
  const s = [...signed].sort((a, b) => a - b);
  const absolute = signed.map(Math.abs).sort((a, b) => a - b);
  return {
    count: s.length,
    median_signed: quantile(s, .5),
    mean_signed: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    mean_absolute_error: absolute.length ? absolute.reduce((a, b) => a + b, 0) / absolute.length : null,
    p50_absolute_error: quantile(absolute, .5),
    p90_absolute_error: quantile(absolute, .9),
    p95_absolute_error: quantile(absolute, .95),
    fraction_negative: s.length ? s.filter(v => v < 0).length / s.length : null,
  };
}

/** The same fair IV repriced with forward = index, isolating the convention. */
function legacyPremium(row: ExecutionCalibrationObservation): number | null {
  if (row.primary_fair_iv_decimal === null || row.index_price === null) return null;
  const legacy = legacyIndexForwardDiagnostic(row.index_price);
  const priced = priceInverseOption({
    optionType: row.option_type === "C" ? "call" : "put",
    indexPrice: row.index_price, strike: row.strike,
    valuationTimestamp: row.trade_timestamp_ms, expiryTimestamp: row.expiry_timestamp_ms,
    ivDecimal: row.primary_fair_iv_decimal, forwardPrice: legacy.forwardPrice,
  });
  return priced.status === "priced" ? priced.priceBtc : null;
}

const dteBand = (days: number) => {
  for (const [lo, hi] of [[1, 3], [3, 7], [7, 14], [14, 30], [30, 46]] as const)
    if (days >= lo && days < hi) return `${lo}-${hi}d`;
  return "other";
};

export interface PricingSanityReport { [key: string]: unknown }

export async function validateExpiryForwardPricing(root = DEFAULT_ROOT): Promise<PricingSanityReport> {
  const files = (await readdir(root)).filter(n => n.endsWith(".observations.jsonl")).sort();
  const rows: ExecutionCalibrationObservation[] = [];
  for (const name of files) {
    const text = await readFile(join(root, name), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const row = JSON.parse(line) as ExecutionCalibrationObservation;
      // v3 and earlier were produced under forward = index and must never be
      // mixed into a corrected-forward measurement.
      if (row.method_version !== EXECUTION_CALIBRATION_METHOD_VERSION)
        throw new Error(`incompatible observation method_version ${row.method_version} in ${name}`);
      rows.push(row);
    }
  }

  const withMark = rows.filter(r => r.primary_fair_eligible && r.mark_price_btc !== null
    && r.primary_fair_price_btc !== null);
  const paired = withMark.map(r => ({
    row: r,
    corrected: r.primary_fair_price_btc! - r.mark_price_btc!,
    legacy: (() => { const p = legacyPremium(r); return p === null ? null : p - r.mark_price_btc!; })(),
  }));

  const slice = (predicate: (r: ExecutionCalibrationObservation) => boolean) => {
    const subset = paired.filter(p => predicate(p.row));
    return {
      corrected_forward: summarize(subset.map(p => p.corrected)),
      legacy_index_forward_proxy: summarize(subset.flatMap(p => p.legacy === null ? [] : [p.legacy])),
    };
  };

  const dispersion = rows.flatMap(r => r.forward_dispersion_mad === null ? [] : [r.forward_dispersion_mad])
    .sort((a, b) => a - b);
  const relativeDispersion = rows.flatMap(r =>
    r.forward_dispersion_mad === null || !r.forward_price ? [] : [r.forward_dispersion_mad / r.forward_price * 1e4])
    .sort((a, b) => a - b);

  return {
    generated_at_utc: new Date().toISOString(),
    reference_method_version: REFERENCE_VALUATION_METHOD_VERSION,
    calibration_method_version: EXECUTION_CALIBRATION_METHOD_VERSION,
    forward_method_version: EXPIRY_FORWARD_METHOD_VERSION,
    legacy_column_is: "convention-isolating proxy: v4 fair IV repriced at forward = index; NOT a v3 re-run",
    scope: {
      shard_files: files.length,
      observations: rows.length,
      primary_fair_eligible: rows.filter(r => r.primary_fair_eligible).length,
      comparable_against_mark: paired.length,
    },
    forward_reconstruction: {
      available: rows.filter(r => r.forward_price !== null).length,
      unavailable: rows.filter(r => r.forward_price === null).length,
      availability_rate: rows.length ? rows.filter(r => r.forward_price !== null).length / rows.length : null,
      unavailable_reasons: Object.fromEntries([...rows.reduce((m, r) => r.forward_price === null
        ? m.set(r.forward_unavailable_reason ?? "unknown", (m.get(r.forward_unavailable_reason ?? "unknown") ?? 0) + 1)
        : m, new Map<string, number>())].sort((a, b) => b[1] - a[1])),
      evidence_observation_count: summarize(rows.map(r => r.forward_observation_count)),
      dispersion_mad_absolute: {count: dispersion.length, p50: quantile(dispersion, .5),
        p90: quantile(dispersion, .9), p95: quantile(dispersion, .95)},
      dispersion_mad_bps_of_forward: {count: relativeDispersion.length, p50: quantile(relativeDispersion, .5),
        p90: quantile(relativeDispersion, .9), p95: quantile(relativeDispersion, .95)},
    },
    fair_minus_mark_btc: {
      all: slice(() => true),
      call: slice(r => r.option_type === "C"),
      put: slice(r => r.option_type === "P"),
      by_dte: Object.fromEntries(["1-3d", "3-7d", "7-14d", "14-30d", "30-46d"]
        .map(band => [band, slice(r => dteBand(r.actual_dte_days) === band)])),
    },
  };
}

async function main() { console.log(JSON.stringify(await validateExpiryForwardPricing(process.argv[2]), null, 2)); }
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
