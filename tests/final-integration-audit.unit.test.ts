import test from "node:test";import assert from "node:assert/strict";
import {buildResearchBundle,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {canonicalStructuralLoss,STRUCTURAL_LOSS_METHOD_VERSION} from "../app/lib/maximum-economic-loss.ts";
import {payoffExtrema} from "../app/lib/expiry-payoff.ts";
import {buildResearchMarginSnapshot} from "../app/lib/research-margin.ts";
import {resolveEventTiming} from "../app/lib/event-timing.ts";
import {buildEventFuturesBaseline} from "../app/lib/futures-baseline.ts";
import {BUILD_PROVENANCE_UNAVAILABLE,buildProvenanceStatus,resolveApplicationBuild,resolveBuildProvenance} from "../app/lib/build-provenance.ts";
import {CONFIGURATION_IDENTITY_VERSION,ORDER_SIGNIFICANT_CONFIGURATION_PATHS,canonicalConfigurationRepresentation,configurationDifferences,diagnoseMethodologyStaleness,effectiveConfigurationHash} from "../app/lib/configuration-identity.ts";
import {EXECUTION_TIMING_METADATA,IMMEDIATE_FILL_SEARCH_WINDOWS_MS} from "../app/lib/execution-policy.ts";
import {MODEL_IV_ANCHOR_MAX_AGE_MINUTES,RESEARCH_WINDOWS_MINUTES,modelHistoricalEvidenceWindows} from "../app/lib/research-valuation.ts";
import {config,now,referenceOnlyFixture,store} from "./fixtures/research-selection-store.ts";
import {BARS,ENTRY,HOUR,barClose,barOpen,futuresEvent,futuresMarket,perpetualBars,underlyingPath} from "./fixtures/futures-market.ts";

const rows=(text:string)=>text.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
const bundle=(context={})=>buildResearchBundle(referenceOnlyFixture(),now,undefined,context);
const futuresBundle=(events:unknown[])=>buildResearchBundle({schemaVersion:"1.8.0",datasetId:"integration",updatedAtUtc:now,events},now,undefined,{tradeDatasetMrEventCount:15});
const withGeneration=(event:ReturnType<typeof futuresEvent>)=>({...event,generationSnapshot:{...event.generationSnapshot,configuration:config,candidates:[]},selectedStructures:[]});

// ---------------------------------------------------------------------------
// PART 1 -- one canonical maximum economic loss
// ---------------------------------------------------------------------------

/** A routine 60k/55k inverse put spread: the case where the BTC tail diverges. */
const DIVERGENT={optionType:"P" as const,shortStrike:60_000,longStrike:55_000,shortEntryPremiumBtc:0.02,longEntryPremiumBtc:0.01,entryIndex:58_000,amount:1,openingFeesBtc:0.0005,expiryTimestamp:Date.parse("2026-09-01T08:00:00Z")};

test("PART 1: the divergent BTC-settlement extremum is real, and is never the canonical maximum loss",()=>{
 const divergent=payoffExtrema(DIVERGENT,"btc-settlement").maximumLoss;
 assert.ok(divergent<-1e6,`the raw inverse BTC extremum must genuinely diverge for this regression to mean anything (got ${divergent})`);
 const canonical=canonicalStructuralLoss(DIVERGENT);
 assert.equal(canonical.status,"available");
 assert.ok(canonical.usd!>0&&canonical.usd!<1e6,"the canonical figure is a bounded positive USD magnitude");
 assert.equal(canonical.btcAtReferenceIndex,canonical.usd!/DIVERGENT.entryIndex);
 assert.ok(Math.abs(canonical.btcAtReferenceIndex!)<1,"the BTC representation is bounded, not a tail artifact");
 assert.equal(canonical.methodVersion,STRUCTURAL_LOSS_METHOD_VERSION);
 assert.equal(canonical.signConvention,"positive_magnitude");
});

test("PART 1: structure economics and margin scenarios reconcile on one maximum loss",()=>{
 const built=bundle();
 const economics=rows(built.files["structure_economics.jsonl"])[0]!;
 const margin=rows(built.files["margin_scenarios.jsonl"])[0]!;
 assert.equal(economics.maximum_structural_loss_status,"available");
 assert.equal(economics.candidate_id,margin.candidate_id);
 assert.equal(economics.maximum_structural_loss_usd,margin.maximum_structural_loss_usd,"one canonical USD maximum loss");
 assert.equal(economics.maximum_structural_loss_native,margin.maximum_structural_loss_native,"one canonical BTC representation");
 assert.equal(economics.maximum_structural_loss_reference_index,margin.reference_index,"at one stated reference index");
 const usd=Number(economics.maximum_structural_loss_usd),index=Number(economics.maximum_structural_loss_reference_index);
 assert.ok(usd>0,"reported as a positive magnitude");
 assert.ok(Math.abs(Number(economics.maximum_structural_loss_native)-usd/index)<1e-12);
 assert.deepEqual(economics.maximum_structural_loss_units,{native:"BTC",quote:"USD",sign_convention:"positive_magnitude"});
 assert.equal(economics.maximum_structural_loss_method_version,STRUCTURAL_LOSS_METHOD_VERSION);
});

test("PART 1: maximum economic loss stays distinct from initial and maintenance margin",()=>{
 const structure={candidateSnapshot:{optionType:"P",shortStrike:60_000,longStrike:55_000,expiryTimestamp:DIVERGENT.expiryTimestamp},quantity:1,
  referenceValuation:{status:"valued" as const,reason:null,source:"local_iv_interpolation" as const,
   entrySnapshot:{valuationTimestamp:Date.parse("2026-08-25T08:00:00Z"),entryTargetIndex:58_000,sold:{priceBtcPerContract:0.02},bought:{priceBtcPerContract:0.01},openingFeesBtc:0.0005},
   valuationPathSnapshot:[],outcomeSnapshots:[],provenance:null}};
 const snapshot=buildResearchMarginSnapshot(structure) as Record<string,unknown>;
 const canonical=canonicalStructuralLoss(DIVERGENT);
 assert.equal(snapshot.maximumStructuralLossUsd,canonical.usd,"the margin layer reuses the same helper");
 for(const key of ["initialMarginBtc","maintenanceMarginBtc","openingInitialMarginBtc","openingMaintenanceMarginBtc"]){
  const value=snapshot[key];
  if(typeof value==="number")assert.notEqual(value,canonical.btcAtReferenceIndex,`${key} must not be the maximum economic loss`);
 }
 assert.equal(snapshot.maximumLossMethodVersion,STRUCTURAL_LOSS_METHOD_VERSION);
});

test("PART 1: the validator rejects a maximum loss the two economic tables disagree about",()=>{
 const built=bundle();
 const files=structuredClone(built.files);
 files["margin_scenarios.jsonl"]=rows(files["margin_scenarios.jsonl"]).map(r=>JSON.stringify({...r,maximum_structural_loss_usd:Number(r.maximum_structural_loss_usd)*3})).join("\n")+"\n";
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/different maximum structural losses/.test(e)),checked.errors.join(" | "));
});

// ---------------------------------------------------------------------------
// PART 2 -- a VPOC that was never reached is a research outcome, not a guillotine
// ---------------------------------------------------------------------------

/** Eight days of hourly bars, so the fixed-time endpoints are genuinely observable. */
const LONG_BARS=8*24+2;
const neverReached=(overrides:Record<string,unknown>={})=>futuresEvent("long",{
 vpocTimestamp:null,vpocPrice:150_000,invalidationPrice:1,
 underlyingHourlyPath:underlyingPath(LONG_BARS),
 futuresMarket:futuresMarket("long",{},LONG_BARS),...overrides});

test("PART 2: a configured VPOC target that was never reached keeps the whole futures benchmark",()=>{
 const timing=resolveEventTiming({sourceRun:neverReached().sourceRun,underlyingHourlyPath:underlyingPath(LONG_BARS)});
 assert.equal(timing.vpocTargetStatus,"not_reached","the target exists; it simply was not touched");
 assert.equal(timing.vpocTriggerTimestamp,null);
 const built=buildEventFuturesBaseline(neverReached(),"vpoc");
 assert.equal(built.comparison.availability,"available","one unresolved endpoint is not a guillotine");
 assert.equal(built.comparison.exit_status,"not_reached");
 assert.equal(built.comparison.exit_unavailable_reason_code,"futures_vpoc_target_not_reached");
 assert.equal(built.comparison.vpoc_target_status,"not_reached");
 assert.equal(built.comparison.gross_pnl_usd_per_unit,null,"no exit means no realised PnL");
 assert.equal(built.comparison.funding_status,"not_evaluated","funding is a property of a holding period");
 assert.ok(Number(built.comparison.risk_to_invalidation_usd_per_unit)>0,"entry-side per-unit risk survives");
 assert.ok(built.path.length>0,"the causal perpetual path is still exported");
 assert.equal(built.comparison.path_terminus_basis,"retrieved_series_end_no_resolved_exit");
});

test("PART 2: fixed-time endpoints stay available while the VPOC endpoint does not resolve",()=>{
 const endpoints=buildEventFuturesBaseline(neverReached(),"vpoc").comparison.endpoints as Array<Record<string,unknown>>;
 const vpoc=endpoints.find(e=>e.policy==="vpoc")!;
 assert.equal(vpoc.outcome,"not_reached");
 assert.equal(vpoc.status,"not_reached");
 assert.equal(vpoc.observation_price,null);
 for(const policy of ["fixed_3d","fixed_5d","fixed_7d"]){
  const endpoint=endpoints.find(e=>e.policy===policy)!;
  assert.equal(endpoint.status,"available",`${policy} is independent of the VPOC outcome`);
  assert.ok(Number(endpoint.observation_price)>0);
 }
 // And selecting a fixed policy directly produces complete economics.
 const fixed=buildEventFuturesBaseline(neverReached(),"fixed_3d").comparison;
 assert.equal(fixed.exit_status,"available");
 assert.ok(Number.isFinite(fixed.gross_pnl_usd_per_unit as number));
 assert.equal(fixed.funding_status,"available");
});

test("PART 2: a missing VPOC target is a data-quality fact, distinct from an unreached one",()=>{
 const timing=resolveEventTiming({sourceRun:futuresEvent("long",{vpocTimestamp:null,vpocPrice:null}).sourceRun,underlyingHourlyPath:underlyingPath()});
 assert.equal(timing.vpocTargetStatus,"not_configured");
 const built=buildEventFuturesBaseline(neverReached({vpocPrice:null}),"vpoc").comparison;
 assert.equal(built.vpoc_target_status,"not_configured");
 assert.equal(built.exit_status,"not_configured");
 assert.equal(built.exit_unavailable_reason_code,"futures_event_vpoc_not_configured");
 assert.equal(built.availability,"available","a missing target does not invent one, nor discard the benchmark");
 assert.ok((built.reason_codes as string[]).includes("futures_event_vpoc_not_configured"));
});

test("PART 2: the invalidation endpoint resolves independently of the VPOC endpoint",()=>{
 const path=underlyingPath(LONG_BARS);
 // A level the third candle genuinely trades through.
 const breached=neverReached({invalidationPrice:path[2].low,underlyingHourlyPath:path});
 const endpoints=buildEventFuturesBaseline(breached,"vpoc").comparison.endpoints as Array<Record<string,unknown>>;
 assert.equal(endpoints.find(e=>e.policy==="vpoc")!.status,"not_reached");
 assert.equal(endpoints.find(e=>e.policy==="invalidation")!.status,"available");
 const untouched=buildEventFuturesBaseline(neverReached({invalidationPrice:1}),"invalidation").comparison;
 assert.equal(untouched.exit_status,"not_reached");
 assert.equal(untouched.exit_unavailable_reason_code,"futures_invalidation_not_reached");
 const unconfigured=buildEventFuturesBaseline(neverReached({invalidationPrice:null}),"invalidation").comparison;
 assert.equal(unconfigured.exit_unavailable_reason_code,"futures_event_invalidation_not_configured");
});

test("PART 2: genuinely missing perpetual source data stays explicit",()=>{
 const absent=buildEventFuturesBaseline(neverReached({futuresMarket:undefined})).comparison;
 assert.equal(absent.availability,"unavailable");
 assert.deepEqual(absent.reason_codes,["futures_instrument_unavailable","futures_margin_unavailable"]);
 const empty=buildEventFuturesBaseline(neverReached({futuresMarket:futuresMarket("long",{reference:[]})})).comparison;
 assert.equal(empty.availability,"unavailable");
 assert.ok((empty.reason_codes as string[]).includes("futures_reference_series_unavailable"));
});

test("PART 2: the validator rejects a bundle that discards observable endpoints",()=>{
 const built=futuresBundle([withGeneration(neverReached())]);
 assert.equal(validateResearchBundle(built.files).ok,true);
 const files=structuredClone(built.files);
 files["futures_comparisons.jsonl"]=rows(files["futures_comparisons.jsonl"]).map(r=>JSON.stringify({...r,availability:"unavailable"})).join("\n")+"\n";
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/discards an observable benchmark/.test(e)),checked.errors.join(" | "));
});

// ---------------------------------------------------------------------------
// PART 3 -- like-for-like sequence classification
// ---------------------------------------------------------------------------

// The fixture tape rises monotonically, so a SHORT event is what lets the
// invalidation land on a chosen candle: the first candle whose high reaches the level.
const sequenceOf=(vpocTimestamp:number|null,invalidationPrice:number|null,path=underlyingPath())=>
 resolveEventTiming({sourceRun:{event:{direction:"short",entryTimestamp:ENTRY,vpocTimestamp,vpocPrice:vpocTimestamp===null?null:120,invalidationPrice}},underlyingHourlyPath:path});

test("PART 3: the sequence classifier compares like-for-like decision candles",()=>{
 const path=underlyingPath();
 // VPOC in candle 5, invalidation in candle 1 -> invalidation first.
 const invalidationFirst=sequenceOf(path[5].openTime,path[1].high,path);
 assert.equal(invalidationFirst.sequenceStatus,"invalidation_first");
 // VPOC in candle 1, invalidation in candle 5 -> vpoc first.
 const vpocFirst=sequenceOf(path[1].openTime,path[5].high,path);
 assert.equal(vpocFirst.sequenceStatus,"vpoc_first");
 // Both inside the same hourly candle: unorderable at this precision.
 const ambiguous=sequenceOf(path[3].openTime,path[3].high,path);
 assert.equal(ambiguous.sequenceStatus,"ambiguous","a touch and a breach in one candle cannot be ordered");
 assert.equal(ambiguous.vpocDecisionCandleOpenTimestamp,ambiguous.invalidationDecisionCandleOpenTimestamp);
 assert.equal(ambiguous.sequenceResolutionMs,HOUR);
 // Neither resolves.
 assert.equal(sequenceOf(null,null,path).sequenceStatus,"unresolved");
});

test("PART 3: neither outcome gains priority from being represented by a candle open",()=>{
 const path=underlyingPath();
 const timing=sequenceOf(path[3].openTime,path[3].high,path);
 // The old classifier compared the VPOC TRIGGER (candle open) against the
 // invalidation DECISION (candle close), which made the open always earlier.
 assert.ok(timing.vpocTriggerTimestamp!<timing.invalidationDecisionTimestamp!,"the asymmetric comparison would still say vpoc_first");
 assert.equal(timing.sequenceStatus,"ambiguous","the like-for-like comparison does not");
 // The invalidation trigger is the touch candle's own open, not one hour before its close.
 assert.equal(timing.invalidationTriggerTimestamp,path[3].openTime);
});

test("PART 3: the options events table and the futures baseline see one classification",()=>{
 const path=underlyingPath();
 for(const [vpocTimestamp,invalidationPrice] of [[path[1].openTime,path[5].high],[path[5].openTime,path[1].high],[path[3].openTime,path[3].high],[null,null]] as const){
  const event=futuresEvent("short",{vpocTimestamp,vpocPrice:vpocTimestamp===null?null:barClose(1),invalidationPrice,underlyingHourlyPath:path});
  const built=futuresBundle([withGeneration(event)]);
  const eventRow=rows(built.files["events.jsonl"])[0]!;
  const comparison=rows(built.files["futures_comparisons.jsonl"])[0]!;
  assert.equal(comparison.sequence_status,eventRow.sequence_status,"one shared classification");
  assert.equal(eventRow.censoring_status,eventRow.sequence_status==="unresolved"?"right_censored":"resolved");
 }
});

// ---------------------------------------------------------------------------
// PART 4 -- build provenance
// ---------------------------------------------------------------------------

test("PART 4: build provenance is injected, never hardcoded, and never invented",()=>{
 assert.equal(resolveApplicationBuild({VITE_APP_COMMIT:"8257c154b6e8ff33"}),"8257c154b6e8ff33");
 assert.equal(resolveBuildProvenance({VITE_APP_COMMIT:"8257c15-dirty"}).status,"available");
 // Local development without Git metadata fails gracefully but explicitly.
 for(const env of [undefined,null,{},{VITE_APP_COMMIT:"   "},{VITE_APP_COMMIT:"not-a-commit"}]){
  const resolved=resolveBuildProvenance(env as Record<string,string>|undefined|null);
  assert.equal(resolved.applicationBuild,BUILD_PROVENANCE_UNAVAILABLE);
  assert.equal(resolved.status,"unavailable");
  assert.ok(resolved.source.length>0,"the reason is stated rather than left null");
 }
 assert.equal(buildProvenanceStatus(["abc1234","def5678"]),"available");
 assert.equal(buildProvenanceStatus(["abc1234",BUILD_PROVENANCE_UNAVAILABLE]),"unavailable");
 assert.equal(buildProvenanceStatus([]),"unavailable");
});

test("PART 4: the manifest states build provenance and the validator holds it to its source runs",()=>{
 const built=bundle();
 assert.equal(built.run.build_provenance_status,"available");
 assert.ok((built.run.source_runs as Array<Record<string,unknown>>).every(r=>typeof r.application_build==="string"&&r.application_build!==BUILD_PROVENANCE_UNAVAILABLE));
 const files=structuredClone(built.files);
 const run=JSON.parse(files["run.json"]);
 run.source_runs=run.source_runs.map((r:Record<string,unknown>)=>({...r,application_build:BUILD_PROVENANCE_UNAVAILABLE}));
 files["run.json"]=JSON.stringify(run)+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/build_provenance_status/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 5 -- dataset denominator
// ---------------------------------------------------------------------------

test("PART 5: the MR-event denominator comes from the active dataset, not the selection store",()=>{
 const built=bundle({tradeDatasetMrEventCount:15});
 assert.equal(built.run.trade_dataset_mr_event_count,15,"no historic count is hardcoded");
 assert.equal(built.run.trade_dataset_mr_event_count_source,"active_trade_dataset");
 assert.equal(built.run.persisted_research_event_count,2);
 assert.equal(built.run.events_with_selected_candidates_count,1);
 assert.equal(built.run.selected_structure_count,1);
 assert.ok(Number(built.run.trade_dataset_mr_event_count)>=Number(built.run.persisted_research_event_count));
 // Absent dataset metadata is explicit, never a fabricated count.
 const unknown=bundle();
 assert.equal(unknown.run.trade_dataset_mr_event_count,null);
 assert.equal(unknown.run.trade_dataset_mr_event_count_source,"unavailable");
 assert.equal(validateResearchBundle(unknown.files).ok,true);
});

test("PART 5: the validator rejects a denominator smaller than the persisted event count",()=>{
 const files=structuredClone(bundle({tradeDatasetMrEventCount:15}).files);
 const run=JSON.parse(files["run.json"]);run.trade_dataset_mr_event_count=1;files["run.json"]=JSON.stringify(run)+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/fewer than the/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 6 -- one deterministic configuration identity
// ---------------------------------------------------------------------------

test("PART 6: semantically identical configurations hash identically regardless of key order",()=>{
 const reversed=Object.fromEntries(Object.entries(config).reverse());
 assert.equal(effectiveConfigurationHash(reversed),effectiveConfigurationHash(config));
 const reorderedTracks={...config,pricingTracks:[...config.pricingTracks].reverse()};
 assert.equal(effectiveConfigurationHash(reorderedTracks),effectiveConfigurationHash(config),"set-like track order is an accident");
 const nested={...config,modelAssumptions:{rate:0,model:"bs"}},nestedFlipped={...config,modelAssumptions:{model:"bs",rate:0}};
 assert.equal(effectiveConfigurationHash(nested),effectiveConfigurationHash(nestedFlipped));
});

test("PART 6: methodology changes move the hash and presentation noise does not",()=>{
 const baseline=effectiveConfigurationHash(config);
 for(const field of ["pricingEngineVersion","qualityRulesVersion","expirySelectionMode","valuationInterval","feeScheduleVersion","executionMode"] as const){
  assert.notEqual(effectiveConfigurationHash({...config,[field]:"changed"}),baseline,`${field} genuinely changes research output`);
 }
 assert.notEqual(effectiveConfigurationHash({...config,modelAssumptions:{rate:0.05}}),baseline);
 for(const noise of [{generatedAtUtc:"2099-01-01T00:00:00.000Z"},{applicationBuild:"deadbeef"}]){
  assert.equal(effectiveConfigurationHash({...config,...noise}),baseline,`${Object.keys(noise)[0]} is provenance, not methodology`);
 }
 assert.deepEqual(configurationDifferences(config,{...config,pricingEngineVersion:"v9"}),["pricingEngineVersion"]);
 assert.deepEqual(configurationDifferences(config,{...config,generatedAtUtc:"2099-01-01T00:00:00.000Z"}),[]);
 assert.ok(!("generatedAtUtc" in canonicalConfigurationRepresentation(config)));
});

test("PART 6: source runs and the manifest expose the same configuration identity",()=>{
 const built=bundle();
 const identity=effectiveConfigurationHash(config);
 assert.equal(built.run.effective_configuration_hash,identity);
 for(const sourceRun of built.run.source_runs as Array<Record<string,unknown>>){
  assert.equal(sourceRun.effective_configuration_hash,identity);
  assert.equal(sourceRun.configuration_identity_version,CONFIGURATION_IDENTITY_VERSION);
  assert.ok(String(sourceRun.source_run_id).endsWith(identity),"the source-run key is derived from the same identity");
 }
 assert.equal((built.run.methodology_identity as Record<string,unknown>).hash,identity);
 const files=structuredClone(built.files);
 const run=JSON.parse(files["run.json"]);run.effective_configuration_hash="tampered";files["run.json"]=JSON.stringify(run)+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/effective_configuration_hash disagrees/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 7 -- no silent mixed-methodology bundles
// ---------------------------------------------------------------------------

test("PART 7: aggregating incompatible methodologies fails and names what differs",()=>{
 const mixed=structuredClone(store);
 mixed.events[1]!.generationSnapshot.configuration={...config,pricingEngineVersion:"v2",valuationInterval:"1h"};
 assert.throws(()=>buildResearchBundle(mixed,now),error=>{
  const message=(error as Error).message;
  assert.match(message,/Incompatible research methodologies/);
  assert.match(message,/e1/,"the baseline event is named");
  assert.match(message,/e2/,"the stale event is named");
  assert.match(message,/pricingEngineVersion/,"the differing methodology field is named");
  assert.match(message,/valuationInterval/);
  assert.match(message,new RegExp(effectiveConfigurationHash(mixed.events[1]!.generationSnapshot.configuration)),"the effective configuration hash is named");
  assert.match(message,/Regenerate/,"regeneration, never metadata migration");
  return true;
 });
 // A purely non-methodological difference is not a mixed bundle.
 assert.equal(validateResearchBundle(buildResearchBundle(structuredClone(store),now).files).ok,true);
});

test("PART 7: the validator independently refuses an already-mixed bundle",()=>{
 const files=structuredClone(bundle().files);
 const run=JSON.parse(files["run.json"]);
 run.source_runs=[run.source_runs[0],{...run.source_runs[1],effective_configuration_hash:"other-methodology"}];
 files["run.json"]=JSON.stringify(run)+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/mixes 2 research methodologies/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 8 -- manifest availability is derived, in both directions
// ---------------------------------------------------------------------------

const CANONICAL_TABLES=["underlying_path","structure_economics","candidates","availability","valuations","outcomes","margin_scenarios","evidence_trades","futures_comparisons","futures_path"] as const;

test("PART 8: every canonical table states availability derived from real content",()=>{
 const built=bundle();
 const manifest=built.run.table_availability as Record<string,string>;
 for(const table of CANONICAL_TABLES)assert.ok(manifest[table]==="available"||manifest[table]==="unavailable",`${table} states availability`);
 assert.equal(manifest.structure_economics,"available");
 assert.equal(manifest.futures_comparisons,"unavailable","this fixture carries no perpetual evidence");
 assert.equal(manifest.futures_path,"unavailable");
 const withFutures=futuresBundle([withGeneration(futuresEvent("long"))]).run.table_availability as Record<string,string>;
 assert.equal(withFutures.futures_comparisons,"available");
 assert.equal(withFutures.futures_path,"available");
});

test("PART 8: usable rows can never read as unavailable, and no usable rows can never read as available",()=>{
 const built=bundle();
 for(const table of CANONICAL_TABLES){
  const files=structuredClone(built.files);
  const run=JSON.parse(files["run.json"]);
  const stated=run.table_availability[table];
  run.table_availability[table]=stated==="available"?"unavailable":"available";
  files["run.json"]=JSON.stringify(run)+"\n";
  const checked=validateResearchBundle(files);
  assert.equal(checked.ok,false,`flipping ${table} must be rejected`);
  assert.ok(checked.errors.some(e=>e.includes(table)),`${table}: ${checked.errors.join(" | ")}`);
 }
 // A missing statement is rejected too.
 const files=structuredClone(built.files);
 const run=JSON.parse(files["run.json"]);delete run.table_availability.structure_economics;files["run.json"]=JSON.stringify(run)+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/does not state availability for structure_economics/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 9 -- the integrity validator
// ---------------------------------------------------------------------------

test("PART 9: per-candidate structural, track and margin rules hold on a valid bundle",()=>{
 const built=bundle();
 assert.equal(validateResearchBundle(built.files).ok,true);
 const economics=rows(built.files["structure_economics.jsonl"]);
 assert.equal(economics.length,1,"exactly one economic record per selected candidate");
 const record=economics[0]!;
 for(const key of ["requested_short_strike","requested_long_strike","requested_width","actual_short_strike","actual_long_strike","actual_width","width_substituted","expiry_timestamp_utc","reference_entry_timestamp_utc","actual_dte_hours","actual_dte_days"])
  assert.ok(key in record,`${key} provenance survives export`);
 const tracks=record.tracks as Array<Record<string,unknown>>;
 assert.equal(tracks.length,7,"all seven canonical tracks carry a status");
 for(const track of tracks)assert.ok("source_valuation_point_count" in track&&"source_outcome_snapshot_count" in track);
 assert.equal(tracks.find(t=>t.track==="modeled_expected")!.status,"unavailable");
 assert.notEqual(tracks.find(t=>t.track==="modeled_expected")!.reason,null,"with its genuine calibration reason");
 assert.equal(rows(built.files["margin_scenarios.jsonl"]).length,1,"a margin scenario exists");
});

test("PART 9: honest outcome absence is allowed but a silent drop is not",()=>{
 const built=bundle();
 const economics=rows(built.files["structure_economics.jsonl"])[0]!;
 const reference=(economics.tracks as Array<Record<string,unknown>>).find(t=>t.track==="reference_fair_value")!;
 assert.ok(Number(reference.source_outcome_snapshot_count)>0,"this track genuinely produced outcomes");
 // Tracks that produced nothing export nothing, and that is valid.
 const idle=(economics.tracks as Array<Record<string,unknown>>).filter(t=>Number(t.source_outcome_snapshot_count)===0);
 assert.ok(idle.length>0);
 assert.equal(validateResearchBundle(built.files).ok,true,"honest absence is not an error");
 // Dropping outcomes that DID exist is.
 const files=structuredClone(built.files);
 files["outcomes.jsonl"]=rows(files["outcomes.jsonl"]).filter(r=>r.analytics_track!=="reference_fair_value").map(r=>JSON.stringify(r)).join("\n")+"\n";
 const checked=validateResearchBundle(files);
 assert.equal(checked.ok,false);
 assert.ok(checked.errors.some(e=>/exported none/.test(e)),checked.errors.join(" | "));
});

test("PART 9: causal and duplicate rules on valuation rows",()=>{
 const built=bundle();
 const valuations=rows(built.files["valuations.jsonl"]);
 // A point before the track's own entry.
 const before=structuredClone(built.files);
 before["valuations.jsonl"]=valuations.map((r,i)=>JSON.stringify(i===0?{...r,timestamp_utc:new Date(Date.parse(String(r.timestamp_utc))-864e5).toISOString()}:r)).join("\n")+"\n";
 assert.ok(validateResearchBundle(before).errors.some(e=>/before that track's own entry/.test(e)));
 // A duplicate (candidate, track, timestamp, pricing track).
 const duplicated=structuredClone(built.files);
 duplicated["valuations.jsonl"]=[...valuations,{...valuations[0]!,valuation_id:`${String(valuations[0]!.valuation_id)}~copy`}].map(r=>JSON.stringify(r)).join("\n")+"\n";
 assert.ok(validateResearchBundle(duplicated).errors.some(e=>/Duplicate valuation row/.test(e)));
 // An undeclared analytics track.
 const undeclared=structuredClone(built.files);
 undeclared["valuations.jsonl"]=valuations.map((r,i)=>JSON.stringify(i===0?{...r,analytics_track:"invented_track"}:r)).join("\n")+"\n";
 assert.ok(validateResearchBundle(undeclared).errors.some(e=>/undeclared analytics track/.test(e)));
});

test("PART 9: an evaluated outcome no snapshot supports is rejected",()=>{
 const built=bundle();
 const files=structuredClone(built.files);
 files["outcomes.jsonl"]=rows(files["outcomes.jsonl"]).map(r=>JSON.stringify(r.analytics_track==="modeled_conservative"?{...r,status:"evaluated"}:r)).join("\n")+"\n";
 const fabricated=rows(files["outcomes.jsonl"]).some(r=>r.analytics_track==="modeled_conservative");
 if(fabricated)assert.ok(validateResearchBundle(files).errors.some(e=>/no persisted snapshot supports/.test(e)));
 // Regardless, a fabricated row for an idle track is caught by injection.
 const injected=structuredClone(built.files);
 const template=rows(injected["outcomes.jsonl"])[0]!;
 injected["outcomes.jsonl"]=injected["outcomes.jsonl"]+JSON.stringify({...template,outcome_id:"injected",analytics_track:"delayed_taker",status:"evaluated"})+"\n";
 assert.ok(validateResearchBundle(injected).errors.some(e=>/no persisted snapshot supports/.test(e)));
});

test("PART 9: nothing in structure economics may be labelled as margin",()=>{
 const built=bundle();
 const files=structuredClone(built.files);
 files["structure_economics.jsonl"]=rows(files["structure_economics.jsonl"]).map(r=>JSON.stringify({...r,protective_long_margin:0.01})).join("\n")+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/names a capital requirement/.test(e)));
});

test("PART 9: event-level censoring, futures joins and endpoint reasons are enforced",()=>{
 const built=futuresBundle([withGeneration(futuresEvent("long")),withGeneration(neverReached({eventId:"mr-2"}))]);
 assert.equal(validateResearchBundle(built.files).ok,true);
 const incoherent=structuredClone(built.files);
 incoherent["events.jsonl"]=rows(incoherent["events.jsonl"]).map((r,i)=>JSON.stringify(i===0?{...r,censoring_status:"right_censored"}:r)).join("\n")+"\n";
 assert.ok(validateResearchBundle(incoherent).errors.some(e=>/censoring status contradicts/.test(e)));
 const orphan=structuredClone(built.files);
 orphan["futures_path.jsonl"]=rows(orphan["futures_path.jsonl"]).map((r,i)=>JSON.stringify(i===0?{...r,event_id:"gone"}:r)).join("\n")+"\n";
 assert.ok(validateResearchBundle(orphan).errors.some(e=>/Futures path row has a broken event foreign key/.test(e)));
 const silent=structuredClone(built.files);
 silent["futures_comparisons.jsonl"]=rows(silent["futures_comparisons.jsonl"]).map(r=>JSON.stringify({...r,endpoints:(r.endpoints as Array<Record<string,unknown>>).map(e=>e.status==="available"?e:{...e,reason_code:null})})).join("\n")+"\n";
 assert.ok(validateResearchBundle(silent).errors.some(e=>/endpoint with no reason code/.test(e)));
});

// ---------------------------------------------------------------------------
// PART 11 -- the volatility foundation survives, and nothing more is added
// ---------------------------------------------------------------------------

test("PART 11: normalized per-leg IV and its provenance survive persistence and export",()=>{
 const built=bundle();
 const point=rows(built.files["valuations.jsonl"]).find(r=>r.analytics_track==="reference_fair_value"
  &&(r.short_leg_volatility as Record<string,unknown>|undefined)?.iv_decimal!=null)!;
 assert.ok(point,"a reference valuation row carries per-leg IV");
 for(const leg of ["short_leg_volatility","long_leg_volatility"]){
  const volatility=point[leg] as Record<string,unknown>;
  for(const field of ["iv_decimal","iv_api_percentage","iv_units","iv_source","iv_source_timestamp_utc","observation","anchor_index","target_index","dte_days"])
   assert.ok(field in volatility,`${leg}.${field} survives export`);
  assert.ok(["observed","reconstructed","unavailable"].includes(String(volatility.observation)));
 }
 // No spread-level IV is synthesised from two legs at different strikes.
 for(const key of Object.keys(point))assert.ok(!/^spread_iv|spread_volatility/.test(key),`${key} must not exist`);
 // An IV without its units or observation status is rejected.
 const files=structuredClone(built.files);
 files["valuations.jsonl"]=rows(files["valuations.jsonl"]).map(r=>{
  const volatility=r.short_leg_volatility as Record<string,unknown>|undefined;
  return JSON.stringify(volatility?.iv_decimal!=null?{...r,short_leg_volatility:{...volatility,iv_units:null}}:r);
 }).join("\n")+"\n";
 assert.ok(validateResearchBundle(files).errors.some(e=>/carries an IV without its units/.test(e)));
});

test("PART 11: the shipped bundle contains no volatility-analytics surface",()=>{
 const text=Object.values(bundle().files).join("\n");
 for(const forbidden of [/\bsvi\b/i,/ssvi/i,/dvol/i,/realized_vol/i,/variance_risk_premium/i,/garch/i,/\bhar\b/i,/ewma/i,/iv_percentile/i,/iv_regime/i,/term_structure/i]){
  assert.ok(!forbidden.test(text),`${forbidden} belongs to a later research phase, not this bundle`);
 }
});

// ---------------------------------------------------------------------------
// Regression guard for the fixture the whole suite depends on
// ---------------------------------------------------------------------------

test("the shared perpetual fixture still exercises what these tests claim",()=>{
 assert.equal(perpetualBars().length,BARS);
 assert.equal(perpetualBars(LONG_BARS).length,LONG_BARS);
 assert.equal(barOpen(0),100);
 assert.ok(perpetualBars(LONG_BARS).at(-1)!.timestamp-ENTRY>7*86_400_000,"the long tape genuinely reaches the 7D endpoint");
});

test("PART 7: staleness diagnosis names the minority events, and the exporter reads the same function",()=>{
 const current={...config,valuationInterval:"1h"};
 const events=[{eventId:"e1",configuration:config},{eventId:"e2",configuration:config},{eventId:"e3",configuration:current}];
 const majority=diagnoseMethodologyStaleness(events);
 assert.equal(majority.compatible,false);
 assert.deepEqual(majority.baselineEventIds,["e1","e2"],"the majority methodology is the baseline");
 assert.deepEqual(majority.stale.map(s=>s.eventId),["e3"]);
 assert.deepEqual(majority.stale[0]!.differingFields,["valuationInterval"]);
 // Against an explicit current methodology the minority becomes the baseline.
 const againstCurrent=diagnoseMethodologyStaleness(events,current);
 assert.deepEqual(againstCurrent.stale.map(s=>s.eventId),["e1","e2"]);
 assert.equal(diagnoseMethodologyStaleness([]).compatible,true);
 assert.equal(diagnoseMethodologyStaleness([{eventId:"e1",configuration:config}]).compatible,true);
});

test("PART 7 / versioning: a previous-schema bundle is rejected, never reinterpreted",()=>{
 const built=bundle();
 assert.equal(JSON.parse(built.files["run.json"]).schema_version,"3.7.0");
 for(const previous of ["3.6.0","3.5.0","3.4.0","3.3.0"]){
  const stale={...built.files,"run.json":built.files["run.json"].replace('"3.7.0"',`"${previous}"`)};
  assert.equal(validateResearchBundle(stale).ok,false,`${previous} carried different maximum-loss semantics and must not be read as current`);
 }
});

// ---------------------------------------------------------------------------
// Configuration identity: sequences versus sets
// ---------------------------------------------------------------------------

test("PART 6: a declared escalation sequence is order-sensitive and changes the identity",()=>{
 // immediateFillSearchWindowsMs records the progressive entry-evidence search
 // that estimateResearchSpread runs with first-match-wins semantics, so the
 // same SET in a different order is a different research method.
 const forward={...config,synchronizationThresholds:{...EXECUTION_TIMING_METADATA}};
 const reversed={...config,synchronizationThresholds:{...EXECUTION_TIMING_METADATA,immediateFillSearchWindowsMs:[...IMMEDIATE_FILL_SEARCH_WINDOWS_MS].reverse()}};
 assert.notEqual(effectiveConfigurationHash(reversed),effectiveConfigurationHash(forward),"a reordered search escalation is a different methodology");
 assert.deepEqual(configurationDifferences(forward,reversed),["synchronizationThresholds"]);
 assert.deepEqual((canonicalConfigurationRepresentation(forward).synchronizationThresholds as Record<string,unknown>).immediateFillSearchWindowsMs,
  [...IMMEDIATE_FILL_SEARCH_WINDOWS_MS],"the declared order survives canonicalization verbatim");
 // Two events differing only in that order are refused as a mixed bundle.
 const mixed=structuredClone(store);
 mixed.events[0]!.generationSnapshot.configuration=forward as typeof config;
 mixed.events[1]!.generationSnapshot.configuration=reversed as typeof config;
 assert.throws(()=>buildResearchBundle(mixed,now),/Incompatible research methodologies[\s\S]*synchronizationThresholds/);
});

test("PART 6: canonicalization is not disabled for the rest of that field, nor for set-like arrays",()=>{
 const forward={...config,synchronizationThresholds:{...EXECUTION_TIMING_METADATA}};
 // Object keys inside the same field are still order-insensitive.
 const rekeyed={...config,synchronizationThresholds:Object.fromEntries(Object.entries(EXECUTION_TIMING_METADATA).reverse())};
 assert.equal(effectiveConfigurationHash(rekeyed),effectiveConfigurationHash(forward),"only the sequence is order-significant, not the field");
 // pricingTracks is checkbox membership, never iterated with priority.
 assert.equal(effectiveConfigurationHash({...forward,pricingTracks:["iv","vwap"]}),effectiveConfigurationHash({...forward,pricingTracks:["vwap","iv"]}));
 // entryMinutes is built from a Set: a record of which windows produced prices.
 const windows=(entryMinutes:number[])=>({...forward,historicalEvidenceWindows:{entryMinutes}});
 assert.equal(effectiveConfigurationHash(windows([120,30,60])),effectiveConfigurationHash(windows([30,60,120])));
 // A genuine membership change is still caught.
 assert.notEqual(effectiveConfigurationHash(windows([30,60])),effectiveConfigurationHash(windows([30,60,120])));
});

test("the declared search escalation matches the engine that implements it",()=>{
 // If these drift, the persisted methodology would describe a search order the
 // valuation engine does not actually run.
 assert.deepEqual(IMMEDIATE_FILL_SEARCH_WINDOWS_MS,RESEARCH_WINDOWS_MINUTES.map(minutes=>minutes*60_000));
 assert.deepEqual([...RESEARCH_WINDOWS_MINUTES],[30,60,120],"tightest window first; only it can earn a green flag");
 assert.ok(ORDER_SIGNIFICANT_CONFIGURATION_PATHS.includes("synchronizationThresholds.immediateFillSearchWindowsMs"));
});


test("regenerated stale-event methodology uses the declared model horizon, independently of execution windows",()=>{
 const currentHistorical=modelHistoricalEvidenceWindows();
 assert.deepEqual(currentHistorical,{entryMinutes:[MODEL_IV_ANCHOR_MAX_AGE_MINUTES]});
 assert.deepEqual(currentHistorical,{entryMinutes:[720]});
 assert.notDeepEqual(currentHistorical,{entryMinutes:[...RESEARCH_WINDOWS_MINUTES]});

 const baseline={...config,historicalEvidenceWindows:currentHistorical,synchronizationThresholds:{...EXECUTION_TIMING_METADATA}};
 const pr98={...baseline,historicalEvidenceWindows:{entryMinutes:[...RESEARCH_WINDOWS_MINUTES]}};
 const events=[...Array.from({length:5},(_,index)=>({eventId:`baseline-${index}`,configuration:baseline})),{eventId:"1f046e00",configuration:pr98}];
 const before=diagnoseMethodologyStaleness(events);
 assert.equal(before.compatible,false);
 assert.deepEqual(before.stale.map(item=>item.eventId),["1f046e00"]);
 assert.deepEqual(before.stale[0]!.differingFields,["historicalEvidenceWindows"]);

 const regenerated=events.map(event=>event.eventId==="1f046e00"?{...event,configuration:{...event.configuration,historicalEvidenceWindows:modelHistoricalEvidenceWindows()}}:event);
 assert.equal(diagnoseMethodologyStaleness(regenerated).compatible,true);

 const changedExecution={...baseline,synchronizationThresholds:{...EXECUTION_TIMING_METADATA,immediateFillSearchWindowsMs:[30*60_000]}};
 assert.notEqual(effectiveConfigurationHash(changedExecution),effectiveConfigurationHash(baseline));
 assert.deepEqual(changedExecution.historicalEvidenceWindows,baseline.historicalEvidenceWindows);

 const genuinelyDifferent={...baseline,historicalEvidenceWindows:{entryMinutes:[360]}};
 assert.notEqual(effectiveConfigurationHash(genuinelyDifferent),effectiveConfigurationHash(baseline));
 assert.equal(diagnoseMethodologyStaleness([{eventId:"current",configuration:baseline},{eventId:"different",configuration:genuinelyDifferent}]).compatible,false);
});
