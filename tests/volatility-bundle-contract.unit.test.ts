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
import {now, referenceOnlyFixture, store, ts} from "./fixtures/research-selection-store.ts";
import {createResearchBundleZip} from "../scripts/research-bundle-service.ts";
import {LEGACY_SCHEMA_MIGRATION_SPEC, importResearchBundle} from "../app/lib/research-analysis.ts";
import {buildResearchAnalyticsModel,datasetForAnalyticsTrack} from "../app/lib/research-analytics-model.ts";

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

test("SCHEMA: 4.1.0 retains volatility and adds controlled-research candidates", () => {
  assert.equal(RESEARCH_BUNDLE_SCHEMA_VERSION, "4.1.0");
  assert.ok(RESEARCH_BUNDLE_FILES.includes("event_volatility_state.jsonl"));
  assert.ok(RESEARCH_BUNDLE_FILES.includes("structure_volatility_state.jsonl"));
  assert.ok(RESEARCH_BUNDLE_FILES.includes("entry_delay_sensitivity.jsonl"));
  assert.ok((LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS as readonly string[]).includes("3.9.0"));
  assert.ok((LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS as readonly string[]).includes("3.8.0"));
});

test("LEGACY: schema 4.0 preserves compatible selected-only Reference state without inventing roles",()=>{
 const bundle=buildResearchBundle(referenceOnlyFixture(),now),run=JSON.parse(bundle.files["run.json"]);run.schema_version="4.0.0";const files={...bundle.files,"run.json":JSON.stringify(run)+"\n","candidates.jsonl":bundle.files["candidates.jsonl"].trim().split("\n").map(line=>{const row=JSON.parse(line);delete row.research_role;return JSON.stringify(row)}).join("\n")+"\n"};
 const result=importResearchBundle(new Uint8Array(createResearchBundleZip(files)),"schema-4.0.zip");if(result.status==="invalid")assert.fail(result.errors.join("\n"));assert.equal(result.dataset.schemaVersion,"4.1.0");assert.equal(result.dataset.migratedFrom,"4.0.0");assert.ok(result.dataset.tables.candidates.every(row=>row.is_selected===true&&row.research_role===null));assert.ok(result.dataset.tables.candidates.every(row=>(row.reference_valuation as Record<string,unknown>)?.status==="valued"));assert.equal(new Set(result.dataset.tables.candidates.map(row=>row.candidate_id)).size,1);
});

test("LEGACY: schema 3.8 volatility rows import with new market collections explicitly empty",()=>{
 const bundle=withVolatility(),run=JSON.parse(bundle.files["run.json"]);run.schema_version="3.8.0";run.volatility_method_versions.structure_volatility_state="structure-volatility-state-v1";
 const legacyStructures=bundle.files["structure_volatility_state.jsonl"].trim().split("\n").map(line=>{const row=JSON.parse(line);row.method_version="structure-volatility-state-v1";delete row.post_entry_market_iv;delete row.market_iv_path;return JSON.stringify(row)}).join("\n")+"\n";
 const {"entry_delay_sensitivity.jsonl":_omitted,...legacyFiles}=bundle.files,beforeOutcomes=bundle.files["outcomes.jsonl"],beforeValuations=bundle.files["valuations.jsonl"];
 const files={...legacyFiles,"run.json":JSON.stringify(run)+"\n","structure_volatility_state.jsonl":legacyStructures},result=importResearchBundle(new Uint8Array(createResearchBundleZip(files as typeof bundle.files)),"legacy.zip");
 void _omitted;if(result.status==="invalid")assert.fail(result.errors.join("\n"));assert.equal(result.status,"degraded");assert.equal(result.dataset.migratedFrom,"3.8.0");assert.equal(result.dataset.schemaVersion,RESEARCH_BUNDLE_SCHEMA_VERSION);assert.deepEqual(result.dataset.tables.entry_delay_sensitivity,[]);assert.equal((result.dataset.run.table_availability as Record<string,string>).entry_delay_sensitivity,"unavailable");assert.equal(result.dataset.capabilities.find(c=>c.id==="delayed-entry")?.status,"unavailable");assert.deepEqual(result.dataset.tables.outcomes,beforeOutcomes.trim().split("\n").filter(Boolean).map(JSON.parse));assert.deepEqual(result.dataset.tables.valuations,beforeValuations.trim().split("\n").filter(Boolean).map(JSON.parse));assert.deepEqual(result.dataset.tables.structure_volatility_state[0]!.post_entry_market_iv,[]);assert.ok(result.warnings.some(w=>/fixed-offset entry-delay sensitivity.*unavailable/i.test(w)));
});

test("LEGACY: schema 3.9 adds only unavailable fixed-offset delay and preserves outcomes",()=>{
 const bundle=withVolatility(),run=JSON.parse(bundle.files["run.json"]);run.schema_version="3.9.0";delete run.table_availability.entry_delay_sensitivity;
 const {"entry_delay_sensitivity.jsonl":_omitted,...legacyFiles}=bundle.files;
 const files={...legacyFiles,"run.json":JSON.stringify(run)+"\n"},beforeOutcomes=bundle.files["outcomes.jsonl"],beforeValuations=bundle.files["valuations.jsonl"],result=importResearchBundle(new Uint8Array(createResearchBundleZip(files as typeof bundle.files)),"legacy-3.9.zip");
 void _omitted;if(result.status==="invalid")assert.fail(result.errors.join("\n"));assert.equal(result.status,"degraded");assert.equal(result.dataset.migratedFrom,"3.9.0");assert.deepEqual(result.dataset.tables.entry_delay_sensitivity,[]);assert.equal(result.dataset.tables.outcomes.length,beforeOutcomes.trim().split("\n").filter(Boolean).length);assert.deepEqual(result.dataset.tables.outcomes,beforeOutcomes.trim().split("\n").filter(Boolean).map(JSON.parse));assert.deepEqual(result.dataset.tables.valuations,beforeValuations.trim().split("\n").filter(Boolean).map(JSON.parse));assert.ok(result.warnings.some(w=>/fixed-offset entry-delay/i.test(w)));assert.equal(result.dataset.capabilities.find(c=>c.id==="delayed-entry")?.status,"unavailable");
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

test("VALIDATOR: post-entry outcome targets must match canonical Reference outcomes",()=>{
 const bundle=withVolatility(),rows=bundle.files["structure_volatility_state.jsonl"].trim().split("\n").map(line=>JSON.parse(line)),candidate=rows[0]!,outcomes=bundle.files["outcomes.jsonl"].trim().split("\n").map(line=>JSON.parse(line)),vpoc=outcomes.find(x=>x.candidate_id===candidate.candidate_id&&x.outcome_type==="vpoc");assert.ok(vpoc);vpoc.analytics_track="reference_fair_value";const unavailable={status:"unavailable",instrument:null,iv_decimal:null,observation_timestamp_utc:null,age_minutes:null,max_age_minutes:60,source:null,unavailable_reason:"fixture"};candidate.post_entry_market_iv.push({endpoint_id:"vpoc",target_timestamp_utc:new Date(Date.parse(vpoc.valuation_timestamp_utc)+60_000).toISOString(),short:unavailable,long:unavailable});const files={...bundle.files,"outcomes.jsonl":outcomes.map(JSON.stringify).join("\n")+"\n","structure_volatility_state.jsonl":rows.map(JSON.stringify).join("\n")+"\n"},result=validateResearchBundle(files);assert.equal(result.ok,false);assert.match(result.errors.join("\n"),/disagrees with canonical Reference outcome/);
});

test("LEGACY CONTRACT: every advertised 3.2-3.9 schema has an explicit truthful migration",()=>{
 assert.deepEqual(Object.keys(LEGACY_SCHEMA_MIGRATION_SPEC),[...LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS]);
 const source=withVolatility();
 const parse=(text:string)=>text.trim().split("\n").filter(Boolean).map(JSON.parse);
 const historical=(version:string)=>{
  const files={...source.files} as Record<string,string>,run=JSON.parse(files["run.json"]);run.schema_version=version;
  delete files["entry_delay_sensitivity.jsonl"];
  const preEconomic=["1.0.0","2.0.0","2.1.0","2.2.0","2.3.0","3.0.0","3.1.0"];
  if(preEconomic.includes(version)){delete files["structure_economics.jsonl"];delete files["event_volatility_state.jsonl"];delete files["structure_volatility_state.jsonl"];delete run.reference_valuation_methodology_version;delete run.modeled_execution_methodology_version;delete run.execution_estimator_version;delete run.execution_calibration_method_version;delete run.forward_method_versions}
  if(["3.2.0","3.3.0","3.4.0","3.5.0","3.6.0"].includes(version)){delete files["event_volatility_state.jsonl"];delete files["structure_volatility_state.jsonl"];delete run.volatility_method_versions}
  if(["3.2.0","3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){run.reference_valuation_methodology_version="causal-reference-v1";run.modeled_execution_methodology_version="modeled-execution-v2";files["structure_economics.jsonl"]&&=writeLegacy(parse(files["structure_economics.jsonl"]).map(row=>({...row,tracks:(row.tracks as Record<string,unknown>[]).map(track=>({...track,...(["reference_fair_value"].includes(String(track.track))?{engine_version:"causal-reference-v1"}:String(track.track).startsWith("modeled_")?{engine_version:"modeled-execution-v2"}:{} )}))})))}
  if(["3.2.0","3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){const nestedEntry={status:"priced",targetTimestamp:ts,grossSpreadBtc:.001,openingFeesBtc:.0001,netOpeningCashFlowBtc:.0009,entryTargetIndex:70_000},nestedPath=[{timestamp:ts+3_600_000,estimatedNetPnlBtc:.0002}],nestedOutcome=[{label:"Settlement",valuationTimestamp:ts+7_200_000,estimatedNetPnlBtc:.0003}];files["candidates.jsonl"]=writeLegacy(parse(files["candidates.jsonl"]).map(row=>({...row,reference_valuation:{status:"valued",engineVersion:"causal-reference-v1",entrySnapshot:nestedEntry,valuationPathSnapshot:nestedPath,outcomeSnapshots:nestedOutcome},modeled_execution:{expected:{status:"evaluated",modelVersion:"modeled-execution-v2",entrySnapshot:nestedEntry,valuationPathSnapshot:nestedPath,outcomeSnapshots:nestedOutcome},conservative:{status:"evaluated",modelVersion:"modeled-execution-v2",entrySnapshot:nestedEntry,valuationPathSnapshot:nestedPath,outcomeSnapshots:nestedOutcome}},delayed_execution:{maker:{status:"evaluated",entrySnapshot:nestedEntry,valuationPathSnapshot:nestedPath,outcomeSnapshots:nestedOutcome},taker:{status:"evaluated",entrySnapshot:nestedEntry,valuationPathSnapshot:nestedPath,outcomeSnapshots:nestedOutcome}}})))}
  if(["3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){const valuations=parse(files["valuations.jsonl"]),outcomes=parse(files["outcomes.jsonl"]),valuation=valuations[0],outcome=outcomes[0];if(valuation)valuations.push({...valuation,valuation_id:`${valuation.valuation_id}~legacy-reference`,analytics_track:"reference_fair_value",net_pnl_native:0.123,net_pnl_usd:12.3},{...valuation,valuation_id:`${valuation.valuation_id}~legacy-modeled`,analytics_track:"modeled_expected",net_pnl_native:0.234,net_pnl_usd:23.4});if(outcome)outcomes.push({...outcome,outcome_id:`${outcome.outcome_id}~legacy-reference`,analytics_track:"reference_fair_value",net_pnl_native:0.345,net_pnl_usd:34.5},{...outcome,outcome_id:`${outcome.outcome_id}~legacy-modeled`,analytics_track:"modeled_expected",net_pnl_native:0.456,net_pnl_usd:45.6});files["valuations.jsonl"]=writeLegacy(valuations);files["outcomes.jsonl"]=writeLegacy(outcomes)}
  if(version==="3.2.0"||preEconomic.includes(version)){
   delete files["structure_economics.jsonl"];
   files["valuations.jsonl"]=writeLegacy(parse(files["valuations.jsonl"]).filter(row=>row.analytics_track==="strict_maker"||row.analytics_track==="strict_taker").map(row=>{const legacy={...row};delete legacy.analytics_track;return legacy}));
   files["outcomes.jsonl"]=writeLegacy(parse(files["outcomes.jsonl"]).filter(row=>row.analytics_track==="strict_maker"||row.analytics_track==="strict_taker").map(row=>{const legacy={...row};delete legacy.analytics_track;return legacy}));
  }
  if(version==="3.3.0"||version==="3.4.0"){
   files["structure_economics.jsonl"]=writeLegacy(parse(files["structure_economics.jsonl"]).map(row=>{row.maximum_economic_loss_native=row.maximum_structural_loss_native;row.maximum_economic_loss_usd=version==="3.4.0"?2.7e12:row.maximum_structural_loss_usd;for(const key of Object.keys(row))if(key.startsWith("maximum_structural_loss")||key==="credit_per_maximum_structural_loss")delete row[key];return row}));
   files["margin_scenarios.jsonl"]=writeLegacy(parse(files["margin_scenarios.jsonl"]).map(row=>{row.maximum_loss_native=row.maximum_structural_loss_native;row.maximum_loss_usd=row.maximum_structural_loss_usd;for(const key of Object.keys(row))if(key.startsWith("maximum_structural_loss"))delete row[key];return row}));
  }
  if(version==="3.5.0")files["outcomes.jsonl"]=writeLegacy(parse(files["outcomes.jsonl"]).map(row=>({...row,outcome_identity_version:"legacy-fixed-label-v0",holding_hours:999})));
  if(version==="3.7.0"){
   run.volatility_method_versions.structure_volatility_state="structure-volatility-state-v1";
   files["structure_volatility_state.jsonl"]=writeLegacy(parse(files["structure_volatility_state.jsonl"]).map(row=>{row.method_version="structure-volatility-state-v1";delete row.post_entry_market_iv;delete row.market_iv_path;return row}));
  }
  files["run.json"]=JSON.stringify(run)+"\n";return files;
 };
 const writeLegacy=(rows:Record<string,unknown>[])=>rows.map(JSON.stringify).join("\n")+(rows.length?"\n":"");
 for(const version of LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS){
  assert.ok((LEGACY_RESEARCH_BUNDLE_SCHEMA_VERSIONS as readonly string[]).includes(version));
  const result=importResearchBundle(new Uint8Array(createResearchBundleZip(historical(version) as typeof source.files)),`legacy-${version}.zip`);
  if(result.status==="invalid")assert.fail(`${version}: ${result.errors.join("\n")}`);
  assert.equal(result.status,"degraded",version);assert.equal(result.dataset.migratedFrom,version);assert.equal(result.dataset.schemaVersion,RESEARCH_BUNDLE_SCHEMA_VERSION);
  assert.deepEqual(result.dataset.tables.entry_delay_sensitivity,[]);assert.equal((result.dataset.run.table_availability as Record<string,string>).entry_delay_sensitivity,"unavailable");
  const model=buildResearchAnalyticsModel(result.dataset);if(["3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){assert.equal(model.denominators.referenceAvailable,0,version);assert.equal(model.denominators.referenceValued,0,version);assert.equal(model.denominators.modeledExpectedAvailable,0,version);assert.equal(model.denominators.modeledConservativeAvailable,0,version);assert.equal(model.denominators.modeledValued,0,version);assert.ok(model.observations.some(observation=>observation.tracks.immediate_taker&&observation.tracks.immediate_taker.status!=="unavailable"),`${version} compatible strict taker survives canonical gating`);for(const track of ["reference","modeled_expected","modeled_conservative"] as const){const projected=datasetForAnalyticsTrack(result.dataset,track);assert.ok(projected.tables.candidates.every(row=>row.execution_scenario_status==="unavailable"),`${version} ${track}`);assert.deepEqual(projected.tables.valuations,[],`${version} ${track} valuations`);assert.deepEqual(projected.tables.outcomes,[],`${version} ${track} outcomes`)}}if(version==="3.2.0"){assert.equal(model.denominators.referenceAvailable,0);assert.equal(model.denominators.modeledExpectedAvailable,0);assert.equal(model.denominators.modeledConservativeAvailable,0);assert.equal(model.denominators.delayedMakerAvailable,0);assert.equal(model.denominators.delayedTakerAvailable,0)}
  if(["3.2.0","3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){assert.equal(result.dataset.run.reference_valuation_methodology_version,"causal-reference-v1");assert.equal(result.dataset.run.modeled_execution_methodology_version,"modeled-execution-v2");assert.notEqual(result.dataset.run.reference_valuation_methodology_version,source.run.reference_valuation_methodology_version);if(version!=="3.2.0")assert.ok(result.dataset.tables.structure_economics.every(row=>(row.tracks as Record<string,unknown>[]).filter(track=>["reference_fair_value","modeled_expected","modeled_conservative"].includes(String(track.track))).every(track=>track.status==="unavailable"&&String((track.legacy_source_track as Record<string,unknown>)?.engine_version??track.engine_version).match(/causal-reference-v1|modeled-execution-v2/))),version)}
  if(["1.0.0","2.0.0","2.1.0","2.2.0","2.3.0","3.0.0","3.1.0"].includes(version)){assert.equal((result.dataset.run.legacy_source_methodology as Record<string,unknown>).reference_valuation_methodology_version,null);assert.deepEqual(result.dataset.tables.valuations,[]);assert.ok(result.dataset.tables.structure_economics.every(row=>(row.tracks as Record<string,unknown>[]).every(track=>track.status==="unavailable")))}
  if(version==="3.2.0"){assert.deepEqual(result.dataset.tables.valuations,[]);assert.deepEqual(result.dataset.tables.outcomes,[]);assert.ok(result.dataset.tables.structure_economics.every(row=>(row.tracks as Record<string,unknown>[]).every(track=>track.status==="unavailable")))}
  if(["3.3.0","3.4.0","3.5.0","3.6.0","3.7.0"].includes(version)){assert.ok(result.dataset.tables.valuations.every(row=>!["reference_fair_value","modeled_expected","modeled_conservative"].includes(String(row.analytics_track))),version);assert.ok(result.dataset.tables.outcomes.every(row=>!["reference_fair_value","modeled_expected","modeled_conservative"].includes(String(row.analytics_track))),version);assert.ok(result.dataset.tables.structure_economics.some(row=>(row.legacy_source_valuations as unknown[]).length>=2&&(row.legacy_source_outcomes as unknown[]).length>=2),version)}
  if(version==="3.3.0"||version==="3.4.0"){assert.ok(result.dataset.tables.structure_economics.every(row=>row.maximum_structural_loss_status==="unavailable"&&row.maximum_structural_loss_native===null&&row.maximum_structural_loss_usd===null))}
  if(version==="3.5.0"){assert.ok(result.dataset.tables.outcomes.every(row=>row.status==="unavailable"&&row.holding_hours===null&&row.outcome_identity_version===null));assert.ok(result.dataset.tables.valuations.length>0)}
  if(version==="3.6.0"){assert.deepEqual(result.dataset.tables.outcomes,parse(source.files["outcomes.jsonl"]));assert.deepEqual(result.dataset.tables.event_volatility_state,[]);assert.deepEqual(result.dataset.tables.structure_volatility_state,[])}
  if(version==="3.7.0"){assert.ok(result.dataset.tables.structure_volatility_state.length>0);assert.ok(result.dataset.tables.structure_volatility_state.every(row=>Array.isArray(row.post_entry_market_iv)&&row.post_entry_market_iv.length===0&&Array.isArray(row.market_iv_path)&&row.market_iv_path.length===0))}
 }
});


test("LEGACY PROVENANCE: historical engines are quarantined and native 4.0 cannot claim them",()=>{
 const bundle=withVolatility(),run=JSON.parse(bundle.files["run.json"]);
 for(const [field,value] of [["reference_valuation_methodology_version","causal-reference-v1"],["modeled_execution_methodology_version","modeled-execution-v2"]] as const){const native={...bundle.files,"run.json":JSON.stringify({...run,[field]:value})+"\n"};assert.equal(validateResearchBundle(native).ok,false);const forged={...native,"run.json":JSON.stringify({...run,[field]:value,legacy_source_methodology:{}})+"\n"};assert.equal(validateResearchBundle(forged).ok,false,"a legacy-like object without a migration marker cannot bypass native validation")}
});
