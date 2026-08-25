/**
 * Phase 2B: score causal surface reconstruction against the FROZEN Phase 2A.3
 * holdouts.
 *
 * Read-only. Production fair value is untouched; results live in a standalone
 * validation artifact.
 *
 * The frozen cohort is not re-derived from anything model-dependent. It is
 * rebuilt from the cached evidence and then CHECKED against the case ids the
 * Phase 2A.3 run recorded, so "the holdouts were not tuned" is a verified claim
 * rather than a promise.
 *
 *   node --experimental-strip-types scripts/validate-surface-models.ts \
 *     <readinessJson> <priorAnchorsJson> <outJson>
 */

import {readFile, writeFile} from "node:fs/promises";
import {
  snapshotFromObservations, type CrossSectionObservation, type SurfaceSnapshot,
} from "../app/lib/volatility/cross-section.ts";
import {
  buildSingleContractHoldouts, buildSpreadHoldout, summarizeHoldouts, type HoldoutCase,
} from "../app/lib/volatility/holdout.ts";
import {aggregateSlice, assessCallPutCompatibility} from "../app/lib/volatility/strike-aggregation.ts";
import {fitSsvi, ssviTotalVarianceAt, type SsviMaturityInput} from "../app/lib/volatility/ssvi.ts";
import {
  LINEAR_INTERPOLATION_METHOD_VERSION, LOCAL_IV_ANCHOR_METHOD_VERSION, SVI_METHOD_VERSION,
  PRIOR_ANCHOR_MAX_AGE_MINUTES, SSVI_ESTIMATE_METHOD_VERSION,
  estimateLinearInterpolation, estimateLocalIvAnchor, estimateSsvi, estimateSvi, fitSvi,
  type EstimationTarget, type PriorAnchor, type SurfaceEstimate,
} from "../app/lib/volatility/surface-models.ts";
import {
  MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC, ageBucketOf, dteBucketOf, leaveOneEventOut,
  moneynessBucketOf, summarizeBy, summarizeMethod, summarizeSpreads, timeSinceEntryBucketOf,
  type ScoredCase, type ScoredSpread,
} from "../app/lib/volatility/model-scoring.ts";
import {
  listCrossSectionShards, readCrossSectionObservations, readCrossSectionSnapshots,
} from "./cross-section-cache.ts";

/** Final-day rule, locked by Phase 2A.3. */
export const FINAL_DAY_DTE_DAYS = 1;
export const FINAL_DAY_UNAVAILABLE_REASON = "surface_not_identifiable_final_day";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

const METHODS = [LOCAL_IV_ANCHOR_METHOD_VERSION, LINEAR_INTERPOLATION_METHOD_VERSION,
  SVI_METHOD_VERSION, SSVI_ESTIMATE_METHOD_VERSION] as const;
type Method = (typeof METHODS)[number];

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
      // `slices` is derived and is recomputed by snapshotFromObservations, so
      // the stored copy is dropped rather than trusted.
      const rest = Object.fromEntries(Object.entries(header).filter(([key]) => key !== "slices"));
      out.set(target, snapshotFromObservations(
        rest as unknown as Omit<SurfaceSnapshot, "observations" | "slices">,
        byTarget.get(target) ?? []));
    }
  }
  return out;
}

/** One aggregated smile and its SVI fit, memoized per distinct fitting input set. */
function smileFor(cache: Map<string, ReturnType<typeof buildSmile>>, holdout: HoldoutCase) {
  const key = `${holdout.snapshot_id}~${holdout.expiry_timestamp_ms}~${holdout.withheld_instruments.join("|")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = buildSmile(holdout);
  cache.set(key, built);
  return built;
}

function buildSmile(holdout: HoldoutCase) {
  const sameExpiry = holdout.fitting_inputs.filter(o => o.expiry_timestamp_ms === holdout.expiry_timestamp_ms);
  const points = aggregateSlice(sameExpiry);

  // SSVI sees EVERY maturity in the snapshot, minus the withheld instrument --
  // that shared term structure is the only thing it can offer over same-expiry
  // SVI, so withholding it would test nothing.
  const byExpiry = new Map<number, typeof holdout.fitting_inputs[number][]>();
  for (const o of holdout.fitting_inputs) {
    const list = byExpiry.get(o.expiry_timestamp_ms);
    if (list) list.push(o); else byExpiry.set(o.expiry_timestamp_ms, [o]);
  }
  const maturities: SsviMaturityInput[] = [...byExpiry.entries()]
    .sort(([a], [b]) => a - b)
    .map(([expiry, rows]) => ({
      expiryTimestampMs: expiry,
      timeToExpiryYears: rows[0]!.time_to_expiry_years,
      points: aggregateSlice(rows),
    }));
  return {
    points, fit: fitSvi(points), ssvi: fitSsvi(maturities),
    compatibility: assessCallPutCompatibility(points),
  };
}

interface CaseContext {
  readonly eventId: string | null;
  readonly role: string;
  readonly hoursSinceEntry: number | null;
}

function scoreOne(
  method: Method, estimate: SurfaceEstimate, holdout: HoldoutCase,
  target: EstimationTarget, truthIv: number, truthPrice: number | null,
  readiness: string, strikeCount: number, truthAge: number, context: CaseContext,
): ScoredCase {
  const ivError = estimate.iv_decimal !== null ? (estimate.iv_decimal - truthIv) * 100 : null;
  const priceError = estimate.price_btc !== null && truthPrice !== null ? estimate.price_btc - truthPrice : null;
  return {
    case_id: holdout.case_id, method_version: method,
    event_id: context.eventId, snapshot_id: holdout.snapshot_id,
    target_timestamp_ms: holdout.target_timestamp_ms,
    expiry_timestamp_ms: holdout.expiry_timestamp_ms,
    actual_dte_days: holdout.actual_dte_days,
    option_type: target.optionType, log_moneyness: target.logMoneyness,
    readiness, same_expiry_strike_count: strikeCount,
    truth_age_minutes: truthAge,
    hours_since_entry: context.hoursSinceEntry, role: context.role,
    status: estimate.status,
    unavailable_reason: estimate.unavailable_reason,
    is_extrapolation: estimate.is_extrapolation,
    iv_error_vol_points: ivError,
    price_error_btc: priceError,
    price_error_usd: priceError !== null ? priceError * target.underlyingPrice : null,
    // Withheld on tiny prices, where a one-tick miss reads as a huge percentage.
    relative_price_error: priceError !== null && truthPrice !== null
      && Math.abs(truthPrice) >= MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC
      ? priceError / truthPrice : null,
    truth_iv_decimal: truthIv, truth_price_btc: truthPrice,
    estimate_iv_decimal: estimate.iv_decimal, estimate_price_btc: estimate.price_btc,
  };
}

async function main() {
  const [readinessPath, anchorsPath, outPath] = process.argv.slice(2);
  if (!readinessPath || !anchorsPath || !outPath)
    throw new Error("usage: validate-surface-models.ts <readinessJson> <priorAnchorsJson> <outJson>");

  const readiness = JSON.parse(await readFile(readinessPath, "utf8")) as {
    holdouts: Row[]; spread_holdouts: Row[]; readiness: Row[]; holdout_composition: Row;
  };
  const anchorFile = JSON.parse(await readFile(anchorsPath, "utf8")) as {
    anchors: Record<string, {instrument_name: string; iv_decimal: number; timestamp_ms: number}[]>;
  };
  const anchorsByTarget = new Map<number, Map<string, {iv_decimal: number; timestamp_ms: number}>>();
  for (const [target, rows] of Object.entries(anchorFile.anchors))
    anchorsByTarget.set(Number(target), new Map(rows.map(r => [r.instrument_name, r])));

  process.stderr.write("loading cached snapshots...\n");
  const snapshots = await loadSnapshots();
  process.stderr.write(`snapshots: ${snapshots.size}\n`);

  // Context per (event, target) from the readiness rows, so scored cases can be
  // sliced by role and time since entry.
  const contextByTarget = new Map<number, CaseContext>();
  for (const r of readiness.readiness) {
    const target = num(r.target_timestamp_ms);
    if (target === null || contextByTarget.has(target)) continue;
    contextByTarget.set(target, {
      eventId: str(r.event_id), role: str(r.role) ?? "unknown",
      hoursSinceEntry: num(r.hours_since_entry),
    });
  }

  /* ---------- rebuild and VERIFY the frozen cohort ---------- */

  // The frozen cohort is verified on its NATURAL KEY -- snapshot, expiry and
  // withheld instrument -- not on the case id. The id is a content hash, and
  // Phase 2A.3 recorded ids built before the identity was made order-
  // independent, so comparing ids reports a mismatch for cases that are
  // demonstrably the same evidence. The natural key is what "the same holdout"
  // actually means.
  const naturalKey = (snapshotId: string, expiry: number, withheld: readonly string[]) =>
    `${snapshotId}~${expiry}~${[...withheld].sort().join("|")}`;
  const frozenKeys = new Set(readiness.holdouts.map(h =>
    naturalKey(String(h.snapshot_id), num(h.expiry_timestamp_ms) ?? 0,
      (h.withheld_instruments as string[] | undefined) ?? [])));
  const frozenIds = new Set(readiness.holdouts.map(h => String(h.case_id)));
  const byTargetExpiry = new Map<string, {target: number; expiry: number; eventId: string | null}>();
  for (const h of readiness.holdouts) {
    const target = Date.parse(String(h.target_timestamp_utc));
    const expiry = num(h.expiry_timestamp_ms);
    if (!Number.isFinite(target) || expiry === null) continue;
    byTargetExpiry.set(`${target}~${expiry}`, {target, expiry, eventId: str(h.event_id)});
  }

  const rebuilt: HoldoutCase[] = [];
  for (const {target, expiry, eventId} of byTargetExpiry.values()) {
    const snapshot = snapshots.get(target);
    if (!snapshot) continue;
    rebuilt.push(...buildSingleContractHoldouts({snapshot, expiryTimestampMs: expiry, eventId}));
  }
  const rebuiltByKey = new Map(rebuilt.map(c =>
    [naturalKey(c.snapshot_id, c.expiry_timestamp_ms, c.withheld_instruments), c]));
  const missing = [...frozenKeys].filter(k => !rebuiltByKey.has(k));
  const extra = [...rebuiltByKey.keys()].filter(k => !frozenKeys.has(k));
  const cohortMatches = missing.length === 0 && extra.length === 0;
  const idsUnchanged = rebuilt.filter(c => frozenIds.has(c.case_id)).length;
  process.stderr.write(
    `frozen cohort: ${frozenKeys.size} recorded, ${rebuiltByKey.size} rebuilt, ` +
    `${missing.length} missing, ${extra.length} extra -> ${cohortMatches ? "MATCH" : "MISMATCH"}\n` +
    `  case ids unchanged from the Phase 2A.3 record: ${idsUnchanged}/${frozenIds.size}\n`);

  // Score exactly the frozen keys, so a rebuild discrepancy can never quietly
  // enlarge or shrink the cohort a model is judged on.
  const cohort = [...frozenKeys]
    .map(k => rebuiltByKey.get(k))
    .filter((c): c is HoldoutCase => c !== undefined)
    .sort((a, b) => a.case_id.localeCompare(b.case_id));
  const composition = summarizeHoldouts(cohort);

  /* ---------- score single-contract holdouts ---------- */

  const smileCache = new Map<string, ReturnType<typeof buildSmile>>();
  const scored: Record<Method, ScoredCase[]> = {
    [LOCAL_IV_ANCHOR_METHOD_VERSION]: [],
    [LINEAR_INTERPOLATION_METHOD_VERSION]: [],
    [SVI_METHOD_VERSION]: [],
    [SSVI_ESTIMATE_METHOD_VERSION]: [],
  };
  const ssviDiagnostics: Row[] = [];
  const fitDiagnostics: Row[] = [];
  const compatibility: Row[] = [];
  let processed = 0;

  for (const holdout of cohort) {
    const snapshot = snapshots.get(holdout.target_timestamp_ms);
    if (!snapshot) continue;
    const truth = holdout.truth[0]!;
    const context = contextByTarget.get(holdout.target_timestamp_ms)
      ?? {eventId: holdout.event_id, role: "unknown", hoursSinceEntry: null};

    // Truth IV is the freshness-consistent aggregate of the withheld prints, not
    // whichever print happened to be first.
    const truthIvs = [...holdout.truth.map(t => t.true_iv_decimal)].sort((a, b) => a - b);
    const truthIv = truthIvs.length % 2
      ? truthIvs[(truthIvs.length - 1) / 2]!
      : (truthIvs[truthIvs.length / 2 - 1]! + truthIvs[truthIvs.length / 2]!) / 2;
    const prices = holdout.truth.map(t => t.true_trade_price).filter((x): x is number => x !== null);
    const truthPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

    const target: EstimationTarget = {
      strike: truth.strike, optionType: truth.option_type,
      logMoneyness: truth.log_moneyness, timeToExpiryYears: truth.time_to_expiry_years,
      underlyingPrice: snapshot.underlying_price,
      targetTimestampMs: holdout.target_timestamp_ms,
      expiryTimestampMs: holdout.expiry_timestamp_ms,
    };
    const {points, fit, ssvi, compatibility: compat} = smileFor(smileCache, holdout);
    const readinessClass = holdout.remaining_readiness.readiness;
    const strikeCount = holdout.remaining_slice?.unique_strike_count ?? 0;
    const truthAge = truth.age_minutes;

    const anchorRow = anchorsByTarget.get(holdout.target_timestamp_ms)?.get(truth.instrument_name) ?? null;
    const anchor: PriorAnchor | null = anchorRow ? {
      instrument_name: truth.instrument_name, iv_decimal: anchorRow.iv_decimal,
      timestamp_ms: anchorRow.timestamp_ms,
      age_minutes: (holdout.target_timestamp_ms - anchorRow.timestamp_ms) / 60_000,
    } : null;

    const estimates: Record<Method, SurfaceEstimate> = {
      [LOCAL_IV_ANCHOR_METHOD_VERSION]: estimateLocalIvAnchor(anchor, target, PRIOR_ANCHOR_MAX_AGE_MINUTES),
      [LINEAR_INTERPOLATION_METHOD_VERSION]: estimateLinearInterpolation(points, target),
      [SVI_METHOD_VERSION]: estimateSvi(fit, points, target),
      [SSVI_ESTIMATE_METHOD_VERSION]: estimateSsvi(
        ssviTotalVarianceAt(ssvi, holdout.expiry_timestamp_ms, target.logMoneyness),
        points, target,
        {maturity_count: ssvi.maturity_count, rms_residual_iv: ssvi.rms_residual_iv,
          calendar_monotone: ssvi.calendar_monotone, constraint_violations: ssvi.constraint_violations,
          rho: ssvi.parameters?.rho, eta: ssvi.parameters?.eta, gamma: ssvi.parameters?.gamma},
        ssvi.unavailable_reason === null ? null
          : ssvi.unavailable_reason === "insufficient_maturities"
            || ssvi.unavailable_reason === "insufficient_observations"
            ? "insufficient_observations"
            : ssvi.unavailable_reason === "fit_economically_invalid"
              ? "fit_economically_invalid" : "fit_did_not_converge"),
    };
    for (const method of METHODS)
      scored[method].push(scoreOne(method, estimates[method], holdout, target,
        truthIv, truthPrice, readinessClass, strikeCount, truthAge, context));

    if (processed % 25 === 0) {
      fitDiagnostics.push({
        case_id: holdout.case_id, snapshot_id: holdout.snapshot_id,
        expiry_timestamp_ms: holdout.expiry_timestamp_ms,
        converged: fit.converged, unavailable_reason: fit.unavailable_reason,
        observation_count: fit.observation_count, objective: fit.objective,
        rms_residual_iv: fit.rms_residual_iv, max_absolute_residual_iv: fit.max_absolute_residual_iv,
        min_durrleman_g: fit.min_durrleman_g, butterfly_arbitrage_free: fit.butterfly_arbitrage_free,
        log_moneyness_span: fit.log_moneyness_span, warnings: fit.warnings,
        parameters: fit.parameters as unknown as Row,
      });
      compatibility.push({snapshot_id: holdout.snapshot_id, ...compat as unknown as Row});
      ssviDiagnostics.push({
        snapshot_id: holdout.snapshot_id, expiry_timestamp_ms: holdout.expiry_timestamp_ms,
        converged: ssvi.converged, unavailable_reason: ssvi.unavailable_reason,
        maturity_count: ssvi.maturity_count, observation_count: ssvi.observation_count,
        rms_residual_iv: ssvi.rms_residual_iv, calendar_monotone: ssvi.calendar_monotone,
        constraint_violations: ssvi.constraint_violations,
        rho: ssvi.parameters?.rho ?? null, eta: ssvi.parameters?.eta ?? null,
        gamma: ssvi.parameters?.gamma ?? null,
      });
    }
    processed += 1;
    if (processed % 500 === 0) process.stderr.write(`  scored ${processed}/${cohort.length}\n`);
  }

  /* ---------- score vertical-spread holdouts ---------- */

  const spreadRows = readiness.spread_holdouts;
  const spreadScored: Record<Method, ScoredSpread[]> = {
    [LOCAL_IV_ANCHOR_METHOD_VERSION]: [],
    [LINEAR_INTERPOLATION_METHOD_VERSION]: [],
    [SVI_METHOD_VERSION]: [],
    [SSVI_ESTIMATE_METHOD_VERSION]: [],
  };

  for (const row of spreadRows) {
    const target = Date.parse(String(row.target_timestamp_utc));
    const snapshot = snapshots.get(target);
    const shortTruth = row.short_truth as Row | null, longTruth = row.long_truth as Row | null;
    const pairedClass = str(row.paired_truth_class) ?? "unknown";
    // Only both-leg cases carry genuine two-leg credit truth. The single-leg
    // cases are never completed with an invented second leg.
    const usable = pairedClass !== "single_leg_only" && shortTruth && longTruth && snapshot;
    const observedCredit = num(row.observed_spread_credit_native);

    if (!usable || observedCredit === null) {
      for (const method of METHODS) spreadScored[method].push({
        case_id: String(row.case_id), method_version: method,
        event_id: str(row.event_id), candidate_id: str(row.candidate_id),
        snapshot_id: String(row.snapshot_id), target_timestamp_ms: target,
        actual_dte_days: num(row.actual_dte_days) ?? 0,
        paired_truth_class: pairedClass,
        synchronization_gap_minutes: num(row.synchronization_gap_minutes),
        status: "unavailable",
        unavailable_reason: pairedClass === "single_leg_only"
          ? "no_two_leg_observed_truth" : "snapshot_unavailable",
        observed_credit_btc: observedCredit, estimated_credit_btc: null,
        credit_error_btc: null, relative_credit_error: null, credit_sign_flip: false,
      });
      continue;
    }

    const expiry = num(row.expiry_timestamp_ms) ?? num((shortTruth as Row).expiry_timestamp_ms)!;
    const holdout = buildSpreadHoldout({
      snapshot, expiryTimestampMs: expiry,
      eventId: str(row.event_id), candidateId: str(row.candidate_id),
      optionType: str(row.option_type),
      shortStrike: num(row.short_strike)!, longStrike: num(row.long_strike)!,
      shortInstrument: String((shortTruth as Row).instrument_name),
      longInstrument: String((longTruth as Row).instrument_name),
    });
    if (!holdout) continue;

    const {points, fit, ssvi} = buildSmile(holdout.holdout);
    const legTarget = (truth: Row): EstimationTarget => ({
      strike: num(truth.strike)!, optionType: String(truth.option_type) === "P" ? "P" : "C",
      logMoneyness: num(truth.log_moneyness)!, timeToExpiryYears: num(truth.time_to_expiry_years)!,
      underlyingPrice: snapshot.underlying_price,
      targetTimestampMs: target, expiryTimestampMs: expiry,
    });
    const shortTarget = legTarget(shortTruth as Row), longTarget = legTarget(longTruth as Row);
    const anchors = anchorsByTarget.get(target);
    const anchorFor = (instrument: string): PriorAnchor | null => {
      const a = anchors?.get(instrument);
      return a ? {instrument_name: instrument, iv_decimal: a.iv_decimal, timestamp_ms: a.timestamp_ms,
        age_minutes: (target - a.timestamp_ms) / 60_000} : null;
    };

    for (const method of METHODS) {
      const estimateLeg = (t: EstimationTarget, instrument: string): SurfaceEstimate =>
        method === LOCAL_IV_ANCHOR_METHOD_VERSION ? estimateLocalIvAnchor(anchorFor(instrument), t, PRIOR_ANCHOR_MAX_AGE_MINUTES)
          : method === LINEAR_INTERPOLATION_METHOD_VERSION ? estimateLinearInterpolation(points, t)
            : method === SVI_METHOD_VERSION ? estimateSvi(fit, points, t)
              : estimateSsvi(ssviTotalVarianceAt(ssvi, expiry, t.logMoneyness), points, t,
                {maturity_count: ssvi.maturity_count},
                ssvi.unavailable_reason === null ? null : "fit_economically_invalid");
      const shortEstimate = estimateLeg(shortTarget, String((shortTruth as Row).instrument_name));
      const longEstimate = estimateLeg(longTarget, String((longTruth as Row).instrument_name));
      const both = shortEstimate.status === "available" && longEstimate.status === "available"
        && shortEstimate.price_btc !== null && longEstimate.price_btc !== null;
      // Credit is short premium minus long premium, matching the observed truth.
      const estimated = both ? shortEstimate.price_btc! - longEstimate.price_btc! : null;
      const error = estimated !== null ? estimated - observedCredit : null;
      spreadScored[method].push({
        case_id: String(row.case_id), method_version: method,
        event_id: str(row.event_id), candidate_id: str(row.candidate_id),
        snapshot_id: String(row.snapshot_id), target_timestamp_ms: target,
        actual_dte_days: num(row.actual_dte_days) ?? 0,
        paired_truth_class: pairedClass,
        synchronization_gap_minutes: num(row.synchronization_gap_minutes),
        status: both ? "available" : "unavailable",
        unavailable_reason: both ? null
          : (shortEstimate.unavailable_reason ?? longEstimate.unavailable_reason ?? "leg_unavailable"),
        observed_credit_btc: observedCredit, estimated_credit_btc: estimated,
        credit_error_btc: error,
        relative_credit_error: error !== null && Math.abs(observedCredit) >= MINIMUM_PRICE_FOR_RELATIVE_ERROR_BTC
          ? error / observedCredit : null,
        credit_sign_flip: estimated !== null && Math.sign(estimated) !== Math.sign(observedCredit),
      });
    }
  }

  /* ---------- cohorts ---------- */

  const total = cohort.length;
  const isPrimary = (c: ScoredCase) =>
    c.readiness === "same_expiry_dense" && !c.is_extrapolation && c.actual_dte_days > FINAL_DAY_DTE_DAYS;
  const isEarlyLife = (c: ScoredCase) =>
    c.hours_since_entry !== null && c.hours_since_entry <= 72 && c.actual_dte_days >= 7;
  const isExtrapolationCohort = (c: ScoredCase) => c.readiness === "extrapolation_required";
  const isFinalDay = (c: ScoredCase) => c.actual_dte_days < FINAL_DAY_DTE_DAYS;

  const cohortView = (predicate: (c: ScoredCase) => boolean) => {
    const ids = new Set(scored[SVI_METHOD_VERSION].filter(predicate).map(c => c.case_id));
    return Object.fromEntries(METHODS.map(m => {
      const subset = scored[m].filter(c => ids.has(c.case_id));
      return [m, summarizeMethod(subset, ids.size)];
    }));
  };

  const overall = Object.fromEntries(METHODS.map(m => [m, summarizeMethod(scored[m], total)]));
  const breakdowns = Object.fromEntries(METHODS.map(m => [m, {
    by_dte: summarizeBy(scored[m], c => dteBucketOf(c.actual_dte_days)),
    by_moneyness: summarizeBy(scored[m], c => moneynessBucketOf(c.log_moneyness)),
    by_option_type: summarizeBy(scored[m], c => c.option_type),
    by_readiness: summarizeBy(scored[m], c => c.readiness),
    by_strike_count: summarizeBy(scored[m], c =>
      c.same_expiry_strike_count < 5 ? "<5" : c.same_expiry_strike_count < 10 ? "5-9"
        : c.same_expiry_strike_count < 20 ? "10-19" : "20+"),
    by_observation_age: summarizeBy(scored[m], c => ageBucketOf(c.truth_age_minutes)),
    by_event: summarizeBy(scored[m], c => c.event_id ?? "unknown"),
    by_time_since_entry: summarizeBy(scored[m], c => timeSinceEntryBucketOf(c.hours_since_entry)),
  }]));

  const spreadCohort = (predicate: (s: ScoredSpread) => boolean, label: string) => {
    const ids = new Set(spreadScored[SVI_METHOD_VERSION].filter(predicate).map(s => s.case_id));
    return {
      label, cohort_size: ids.size,
      methods: Object.fromEntries(METHODS.map(m =>
        [m, summarizeSpreads(spreadScored[m].filter(s => ids.has(s.case_id)), ids.size)])),
    };
  };

  const report = {
    generated_at_utc: new Date().toISOString(),
    scoring_version: "phase-2b-surface-validation-v1",
    prior_anchor_max_age_minutes: PRIOR_ANCHOR_MAX_AGE_MINUTES,
    final_day_rule: {dte_days: FINAL_DAY_DTE_DAYS, reason: FINAL_DAY_UNAVAILABLE_REASON},
    cohort_verification: {
      verified_on: "natural_key(snapshot_id, expiry_timestamp_ms, withheld_instruments)",
      recorded_case_count: frozenKeys.size, rebuilt_case_count: rebuiltByKey.size,
      scored_case_count: cohort.length,
      missing_from_rebuild: missing.slice(0, 20), extra_in_rebuild: extra.slice(0, 20),
      matches: cohortMatches,
      case_ids_unchanged_from_2a3_record: idsUnchanged,
      case_id_note: "Case ids are content hashes. Phase 2A.3 recorded ids built before holdout identity was made order-independent, so ids differ for multi-truth cases while the withheld evidence is identical.",
      composition: composition as unknown as Row,
    },
    call_put_compatibility_sample: compatibility,
    ssvi_fit_diagnostics_sample: ssviDiagnostics,
    svi_fit_diagnostics_sample: fitDiagnostics,
    overall,
    cohorts: {
      primary_dense_interpolation: cohortView(isPrimary),
      early_life: cohortView(isEarlyLife),
      sparse_interpolation: cohortView(c => c.readiness === "same_expiry_sparse"),
      extrapolation_required: cohortView(isExtrapolationCohort),
      final_day: cohortView(isFinalDay),
      entry_only: cohortView(c => c.role === "entry"),
    },
    breakdowns,
    leave_one_event_out: {
      iv: leaveOneEventOut(scored as unknown as Record<string, readonly ScoredCase[]>),
      price: leaveOneEventOut(scored as unknown as Record<string, readonly ScoredCase[]>, c => c.price_error_btc),
    },
    spreads: {
      all: spreadCohort(() => true, "all frozen spread cases"),
      both_legs_observed: spreadCohort(s => s.paired_truth_class !== "single_leg_only", "both legs observed"),
      synchronous: spreadCohort(s => s.paired_truth_class === "synchronous", "synchronous (<=5 min)"),
      asynchronous: spreadCohort(s => s.paired_truth_class === "asynchronous_within_window", "asynchronous"),
    },
  };
  await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stderr.write(`done: ${cohort.length} cases scored across ${METHODS.length} methods\n`);
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
