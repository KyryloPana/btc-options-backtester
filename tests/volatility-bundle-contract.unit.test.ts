import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS, RESEARCH_BUNDLE_FILES, RESEARCH_BUNDLE_SCHEMA_VERSION,
  buildResearchBundle, validateResearchBundle,
} from "../app/lib/research-bundle.ts";
import {
  buildEventVolatilityState, buildStructureVolatilityState,
} from "../app/lib/volatility/volatility-state.ts";
import {REFERENCE_SERIES_ID} from "../app/lib/volatility/reference-series.ts";
import type {ReferenceSeriesRow} from "../app/lib/volatility/reference-series.ts";
import type {RealizedVolatilityResult} from "../app/lib/volatility/realized-volatility.ts";
import {HOUR_MS} from "../app/lib/volatility/realized-volatility.ts";
import {now, store, ts} from "./fixtures/research-selection-store.ts";

/**
 * Schema 3.7.0: the two volatility tables as part of the serialized contract.
 *
 * The validator rules pinned here exist to make three things unserializable: a
 * metric reporting a number it does not have, a derived quantity standing on an
 * unavailable endpoint, and a model-produced volatility presented as market
 * evidence.
 */

const HASH = "series-hash-1";
const EXPIRY = ts + 6 * 86_400_000;

const referenceRow = (over: Partial<ReferenceSeriesRow> = {}): ReferenceSeriesRow => ({
  series_id: REFERENCE_SERIES_ID, method_version: "volatility-reference-series-v1",
  timestamp_utc: new Date(ts).toISOString(), timestamp_ms: ts,
  underlying_instrument: "BTC-PERPETUAL", underlying_price: 100,
  nominal_tenor: "7d", reference_expiry_timestamp_utc: new Date(EXPIRY).toISOString(),
  actual_dte_days: 6, tenor_tolerance_passed: true,
  reference_iv_decimal: 0.42, iv_units: "decimal", reference_strike: 100, log_moneyness: 0,
  observation_class: "exact_atm", observation_source: "deribit_trade_iv",
  observation_timestamp_utc: new Date(ts - 600_000).toISOString(),
  age_minutes: 10, max_age_minutes: 60, passes_market_state_rule: true,
  diagnostic_age_minutes: 10, source_trade_ids: ["t1"], interpolation_inputs: [],
  contract_settlement_period: "week", own_legs_excluded: true,
  quality: "observed", unavailable_reason_code: null, ...over,
});

const rv = (over: Partial<RealizedVolatilityResult> = {}): RealizedVolatilityResult => ({
  status: "available", rvDecimal: 0.55, observationCount: 167, expectedCount: 168,
  coverageRatio: 167 / 168, windowStartMs: ts - 168 * HOUR_MS, windowEndMs: ts,
  underlyingSource: "BTC-PERPETUAL", annualizationFactor: 8760,
  methodVersion: "realized-volatility-hourly-log-v1", unavailableReason: null, ...over,
});

const eventState = (eventId: string) => buildEventVolatilityState({
  eventId, entryTimestampMs: ts, underlyingInstrument: "BTC-PERPETUAL", entryUnderlyingPrice: 100,
  referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: HASH,
  referenceRows: [
    referenceRow({nominal_tenor: "7d", actual_dte_days: 6, reference_iv_decimal: 0.42}),
    referenceRow({nominal_tenor: "14d", actual_dte_days: 13, reference_iv_decimal: 0.46}),
    referenceRow({nominal_tenor: "30d", actual_dte_days: 27, reference_iv_decimal: 0.50}),
  ],
  realizedVolatility: {"1d": rv(), "3d": rv(), "7d": rv(), "14d": rv(), "30d": rv()},
  percentiles: {},
});

const structureState = (eventId: string, candidateId: string) => buildStructureVolatilityState({
  eventId, candidateId, entryTimestampMs: ts,
  actualExpiryTimestampMs: EXPIRY, actualDteDays: 6,
  shortStrike: 110, longStrike: 112, optionType: "C",
  referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: HASH,
  shortLeg: {ivDecimal: 0.48, ivSource: "local-observed-IV", ivSourceTimestampMs: ts - 300_000, observation: "observed"},
  longLeg: {ivDecimal: 0.51, ivSource: "local-observed-IV", ivSourceTimestampMs: ts - 480_000, observation: "observed"},
  reference: referenceRow(),
});

/** The fixture store: events e1/e2 with candidates a, b, c, red. */
const CANDIDATES: readonly [string, string][] = [["e1", "a"], ["e1", "b"], ["e2", "c"], ["e2", "red"]];
const candidateIdOf = (event: string, key: string) =>
  JSON.parse(buildResearchBundle(store, now).files["candidates.jsonl"].trim().split("\n")[0]!) && `${event}~${key}`;

const withVolatility = () => {
  const bare = buildResearchBundle(store, now);
  const candidateIds = [...new Set(bare.files["candidates.jsonl"].trim().split("\n")
    .map(l => JSON.parse(l) as {event_id: string; candidate_id: string}))];
  const byId = new Map(candidateIds.map(c => [c.candidate_id, c.event_id]));
  return buildResearchBundle(store, now, undefined, {
    volatility: {
      events: ["e1", "e2"].map(eventState),
      structures: [...byId].map(([candidateId, eventId]) => structureState(eventId, candidateId)),
    },
  });
};

void CANDIDATES; void candidateIdOf;

/* ---------------- schema contract ---------------- */

test("SCHEMA: 3.7.0 adds the two tables and retires 3.6.0 to the legacy list", () => {
  assert.equal(RESEARCH_BUNDLE_SCHEMA_VERSION, "3.7.0");
  assert.ok(RESEARCH_BUNDLE_FILES.includes("event_volatility_state.jsonl"));
  assert.ok(RESEARCH_BUNDLE_FILES.includes("structure_volatility_state.jsonl"));
  assert.ok((LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS as readonly string[]).includes("3.6.0"));
});

test("SCHEMA: a bundle built without the volatility pipeline exports empty tables, not zeroes", () => {
  const bundle = buildResearchBundle(store, now);
  assert.equal(bundle.files["event_volatility_state.jsonl"], "");
  assert.equal(bundle.files["structure_volatility_state.jsonl"], "");
  const availability = bundle.run.table_availability as Record<string, string>;
  assert.equal(availability.event_volatility_state, "unavailable");
  assert.equal(availability.structure_volatility_state, "unavailable");
  assert.equal(validateResearchBundle(bundle.files).ok, true, "absence is a valid state");
});

test("SCHEMA: injected volatility state exports, validates and carries series identity", () => {
  const bundle = withVolatility();
  const events = bundle.files["event_volatility_state.jsonl"].trim().split("\n").map(l => JSON.parse(l));
  const structures = bundle.files["structure_volatility_state.jsonl"].trim().split("\n").map(l => JSON.parse(l));
  assert.equal(events.length, 2);
  assert.equal(structures.length, 4);
  assert.equal(validateResearchBundle(bundle.files).ok, true);
  const availability = bundle.run.table_availability as Record<string, string>;
  assert.equal(availability.event_volatility_state, "available");
  // Identity travels on every row, so a consumer can always tell which dataset
  // produced the numbers it is reading.
  for (const row of [...events, ...structures]) {
    assert.equal(row.reference_series_id, REFERENCE_SERIES_ID);
    assert.equal(row.reference_series_content_hash, HASH);
    assert.equal(row.run_id, bundle.run.run_id, "rows join to their own run");
    assert.ok(row.venue, "every row carries a venue");
  }
});

/* ---------------- validator invariants ---------------- */

const mutate = (bundle: ReturnType<typeof buildResearchBundle>, file: string, from: string, to: string) => {
  const text = bundle.files[file as keyof typeof bundle.files];
  assert.ok(text.includes(from), `fixture should contain ${from}`);
  return {...bundle.files, [file]: text.replace(from, to)};
};

test("VALIDATOR: a metric reporting a value while unavailable is rejected", () => {
  const bundle = withVolatility();
  // The exact failure this rule exists for: a stale or missing reading that
  // still carries a number, which downstream would average as if it were real.
  const broken = mutate(bundle, "event_volatility_state.jsonl",
    '"status":"available"', '"status":"unavailable"');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /must be null/.test(e)), result.errors.slice(0, 3).join(" | "));
});

test("VALIDATOR: a slope standing on an unavailable endpoint is rejected", () => {
  const bundle = withVolatility();
  const rows = bundle.files["event_volatility_state.jsonl"].trim().split("\n").map(l => JSON.parse(l));
  // Knock out the 7d tenor but leave slope_7d_14d claiming to be available.
  rows[0].reference_iv = rows[0].reference_iv.map((t: Record<string, unknown>) =>
    t.nominal_tenor === "7d" ? {...t, status: "unavailable", iv_decimal: null, iv_units: null} : t);
  const files = {...bundle.files,
    "event_volatility_state.jsonl": rows.map((r: unknown) => JSON.stringify(r)).join("\n") + "\n"};
  const result = validateResearchBundle(files);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /is available while an endpoint tenor is not/.test(e)),
    result.errors.slice(0, 3).join(" | "));
});

test("VALIDATOR: a model-classified leg presented as available market evidence is rejected", () => {
  const bundle = withVolatility();
  const broken = mutate(bundle, "structure_volatility_state.jsonl",
    '"observation":"observed"', '"observation":"reconstructed"');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /pricing state rather than market evidence/.test(e)),
    result.errors.slice(0, 3).join(" | "));
});

test("VALIDATOR: a reference differential against a self-inclusive reference is rejected", () => {
  const bundle = withVolatility();
  const broken = mutate(bundle, "structure_volatility_state.jsonl",
    '"excluded_own_legs":true', '"excluded_own_legs":false');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /did not exclude the structure's own legs/.test(e)),
    result.errors.slice(0, 3).join(" | "));
});

test("VALIDATOR: a percentile below its own minimum, or outside [0,1], is rejected", () => {
  const bundle = withVolatility();
  const rows = bundle.files["event_volatility_state.jsonl"].trim().split("\n").map(l => JSON.parse(l));
  rows[0].reference_iv_percentile = [{
    nominal_tenor: "7d", percentile: 0.5, subject_iv_decimal: 0.42,
    prior_observation_count: 12, other_tenor_observations_excluded: 0,
    minimum_prior_observations: 720, history_start_utc: null, history_end_utc: null,
    reference_series_id: REFERENCE_SERIES_ID, reference_series_content_hash: HASH,
    method_version: "expanding-causal-iv-percentile-v1", status: "available", unavailable_reason: null,
  }];
  const files = {...bundle.files,
    "event_volatility_state.jsonl": rows.map((r: unknown) => JSON.stringify(r)).join("\n") + "\n"};
  const result = validateResearchBundle(files);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /below the 720 minimum/.test(e)), result.errors.slice(0, 3).join(" | "));
});

test("VALIDATOR: DVOL may never declare itself substitutable for a same-expiry reference", () => {
  const bundle = withVolatility();
  const broken = mutate(bundle, "event_volatility_state.jsonl",
    '"substitution_permitted":false', '"substitution_permitted":true');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /does not refuse substitution/.test(e)));
});

test("VALIDATOR: a synthesized spread IV is rejected outright", () => {
  const bundle = withVolatility();
  const broken = mutate(bundle, "structure_volatility_state.jsonl",
    '"synthesized_spread_iv":null', '"synthesized_spread_iv":0.495');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /does not exist for a vertical/.test(e)));
});

test("VALIDATOR: partial coverage is not exportable, and broken keys are caught", () => {
  const bundle = withVolatility();
  const rows = bundle.files["event_volatility_state.jsonl"].trim().split("\n");
  // One event silently dropped: downstream would read the remaining one as the
  // full sample.
  const partial = validateResearchBundle({...bundle.files,
    "event_volatility_state.jsonl": rows[0] + "\n"});
  assert.equal(partial.ok, false);
  assert.ok(partial.errors.some(e => /partial coverage is not exportable/.test(e)));

  const orphan = mutate(bundle, "structure_volatility_state.jsonl",
    '"event_id":"e1"', '"event_id":"ghost"');
  assert.equal(validateResearchBundle(orphan).ok, false);
});

test("VALIDATOR: a non-canonical annualization factor is rejected", () => {
  const bundle = withVolatility();
  const broken = mutate(bundle, "event_volatility_state.jsonl",
    '"annualization_factor":8760', '"annualization_factor":8760.0001');
  const result = validateResearchBundle(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => /non-canonical annualization factor/.test(e)));
});
