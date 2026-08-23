import type {JsonValue} from "./research-selections.ts";

/**
 * The canonical economic-track contract for the research bundle.
 *
 * WHY THIS EXISTS. Until now `valuations.jsonl` and `outcomes.jsonl` were built
 * as `(["maker","taker"]).flatMap(mode => scenario.status!=="evaluated" ? [] :
 * ...)`, so a structurally resolved candidate with a perfectly good reference
 * valuation exported ZERO economic rows whenever immediate maker and taker
 * evidence were both unavailable. Economic analysis was therefore gated by
 * execution, which inverts the intended architecture:
 *
 *     structural candidate -> economic valuation/outcomes
 *                          -> execution evidence OVERLAID separately
 *
 * A track is an addressable economic view of ONE structure. Exactly one
 * scenario-independent structure-economics record describes the structure; the
 * tracks below overlay it and never decide whether it exists.
 *
 * WHAT A TRACK IS NOT. Declaring seven tracks does not mean manufacturing seven
 * numeric paths. Each track is exported with an explicit status, and a track
 * whose engine cannot support it under existing methodology is exported as
 * `unavailable` with a specific reason rather than invented. No new closing
 * price model is introduced here: every path reuses the valuation semantics the
 * corresponding engine already produced.
 */

export const CANONICAL_TRACKS=[
 "reference_fair_value",
 "modeled_conservative",
 "modeled_expected",
 "strict_maker",
 "strict_taker",
 "delayed_maker",
 "delayed_taker",
] as const;
export type CanonicalTrack=(typeof CANONICAL_TRACKS)[number];

export type TrackStatus="available"|"unavailable";

/** Why a track has no path. Stable codes so consumers can branch without parsing prose. */
export const TRACK_REASON_CODES=[
 "track_available",
 "reference_valuation_unavailable",
 "reference_valuation_not_evaluated",
 "modeled_execution_unavailable",
 "modeled_calibration_insufficient",
 "immediate_execution_unavailable",
 "immediate_execution_not_evaluated",
 "delayed_execution_unavailable",
 "delayed_execution_not_evaluated",
 "structure_not_resolved",
] as const;
export type TrackReasonCode=(typeof TRACK_REASON_CODES)[number];

/**
 * How a track's opening ledger was formed. This is the field that keeps a
 * modeled execution from being mistaken for the reference fair value: the
 * modeled tracks reuse the reference marks but carry their OWN opening
 * adjustment, and say so here.
 */
export type EntryBasis=
 |"reference_fair_value_entry"
 |"modeled_opening_ledger"
 |"observed_immediate_fill"
 |"observed_delayed_fill"
 |"unavailable";

/** How the path's marks were produced. Never upgraded by a modeled overlay. */
export type ValuationBasis="reference_marks"|"observed_marks"|"unavailable";

/**
 * What the track proves about executability. Reference economics prove nothing
 * about being fillable, and must never be read as execution evidence.
 */
export type ExecutionEvidenceClass=
 /** Economically valued, with no claim that the structure could be filled. */
 |"none_reference_only"
 /** A model's assumption about execution cost, not observed evidence. */
 |"modeled_assumption"
 /** Historical tape consistent with a passive fill; never a guaranteed queue fill. */
 |"observed_maker_opportunity"
 /** The conservative runnable execution proxy. */
 |"observed_taker_execution";

export interface TrackDescriptor {
 readonly track:CanonicalTrack;
 readonly status:TrackStatus;
 readonly reasonCode:TrackReasonCode;
 readonly reason:string|null;
 readonly entryBasis:EntryBasis;
 readonly entryTimestampMs:number|null;
 readonly valuationBasis:ValuationBasis;
 readonly executionEvidence:ExecutionEvidenceClass;
 /** The pricing/valuation source the producing engine recorded. */
 readonly valuationSource:string|null;
 readonly provenance:JsonValue;
 readonly engineVersion:string|null;
 /** The scenario an execution track overlays; null for execution-independent tracks. */
 readonly executionScenario:"maker"|"taker"|null;
 readonly entrySnapshot:JsonValue;
 readonly valuationPath:readonly JsonValue[];
 readonly outcomeSnapshots:readonly JsonValue[];
}

const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const num=(v:unknown):number|null=>typeof v==="number"&&Number.isFinite(v)?v:null;
const str=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v:null;
const arr=(v:unknown):JsonValue[]=>Array.isArray(v)?v as JsonValue[]:[];
const entryTime=(entry:Record<string,unknown>):number|null=>num(entry.valuationTimestamp)??num(entry.targetTimestamp);

function unavailable(track:CanonicalTrack,reasonCode:TrackReasonCode,reason:string|null,
 executionScenario:"maker"|"taker"|null,provenance:JsonValue=null):TrackDescriptor{
 return {track,status:"unavailable",reasonCode,reason,entryBasis:"unavailable",entryTimestampMs:null,
  valuationBasis:"unavailable",
  executionEvidence:executionScenario==="taker"?"observed_taker_execution"
   :executionScenario==="maker"?"observed_maker_opportunity"
   :track.startsWith("modeled")?"modeled_assumption":"none_reference_only",
  valuationSource:null,provenance,engineVersion:null,executionScenario,
  entrySnapshot:null,valuationPath:[],outcomeSnapshots:[]};
}

/**
 * The execution-independent economic track. Required for every structurally
 * resolved candidate the reference engine could price, and the primary path for
 * economic research: its existence must never depend on execution evidence.
 */
function referenceTrack(structure:Record<string,unknown>):TrackDescriptor{
 const reference=obj(structure.referenceValuation);
 if(!Object.keys(reference).length||reference.status==="not_evaluated")
  return unavailable("reference_fair_value","reference_valuation_not_evaluated",
   str(reference.reason)??"The reference valuation engine did not evaluate this structure.",null,(reference.provenance??null) as JsonValue);
 if(reference.status!=="valued")
  return unavailable("reference_fair_value","reference_valuation_unavailable",
   str(reference.reason)??"The reference valuation engine could not price this structure.",null,(reference.provenance??null) as JsonValue);
 const entry=obj(reference.entrySnapshot);
 return {
  track:"reference_fair_value",status:"available",reasonCode:"track_available",reason:null,
  entryBasis:"reference_fair_value_entry",entryTimestampMs:entryTime(entry),
  valuationBasis:"reference_marks",executionEvidence:"none_reference_only",
  valuationSource:str(reference.source),provenance:(reference.provenance??null) as JsonValue,
  engineVersion:str(obj(reference.provenance).engineVersion),
  executionScenario:null,
  entrySnapshot:(reference.entrySnapshot??null) as JsonValue,
  valuationPath:arr(reference.valuationPathSnapshot),
  outcomeSnapshots:arr(reference.outcomeSnapshots),
 };
}

/**
 * A modeled execution overlay. It reuses the reference marks for its path --
 * exactly as the persisted `pathDerivation` records -- but carries its own
 * opening ledger, so it is never a relabelled reference entry. The producing
 * engine's own status is honoured verbatim: an expected track that the
 * calibration policy left unpromoted stays unavailable with its own reason
 * rather than being forced to fill the table.
 */
function modeledTrack(structure:Record<string,unknown>,which:"conservative"|"expected"):TrackDescriptor{
 const track:CanonicalTrack=which==="conservative"?"modeled_conservative":"modeled_expected";
 const modeled=obj(obj(structure.modeledExecution)[which]);
 const reference=obj(structure.referenceValuation);
 if(!Object.keys(modeled).length||modeled.status!=="evaluated"){
  const insufficient=which==="expected"&&(num(modeled.calibrationCount)!==null||str(modeled.reason)!==null);
  return unavailable(track,insufficient?"modeled_calibration_insufficient":"modeled_execution_unavailable",
   str(modeled.reason)??"The modeled execution layer did not produce this track.",null,(modeled.provenance??null) as JsonValue);
 }
 // The modeled opening ledger is real; the marks it is valued against are the
 // reference marks, which is why the reference track must exist for it to.
 if(reference.status!=="valued")
  return unavailable(track,"reference_valuation_unavailable",
   "The modeled opening ledger is valued against reference marks, which are unavailable for this structure.",null,(modeled.provenance??null) as JsonValue);
 const entry=obj(modeled.entrySnapshot);
 return {
  track,status:"available",reasonCode:"track_available",reason:null,
  entryBasis:"modeled_opening_ledger",
  entryTimestampMs:num(modeled.entryTimestamp)??entryTime(entry)??entryTime(obj(reference.entrySnapshot)),
  valuationBasis:"reference_marks",executionEvidence:"modeled_assumption",
  valuationSource:str(modeled.source),provenance:(modeled.provenance??null) as JsonValue,
  engineVersion:str(modeled.modelVersion),executionScenario:null,
  entrySnapshot:(modeled.entrySnapshot??null) as JsonValue,
  valuationPath:arr(reference.valuationPathSnapshot),
  outcomeSnapshots:arr(modeled.outcomeSnapshots),
 };
}

/** Strict immediate execution: only where the causal immediate engine evaluated it. */
function strictTrack(structure:Record<string,unknown>,mode:"maker"|"taker"):TrackDescriptor{
 const track:CanonicalTrack=mode==="maker"?"strict_maker":"strict_taker";
 const scenario=obj(obj(structure.executionScenarios)[mode]);
 if(scenario.status!=="evaluated")
  return unavailable(track,scenario.status==="not_evaluated"?"immediate_execution_not_evaluated":"immediate_execution_unavailable",
   str(scenario.reason)??"Immediate execution evidence is unavailable for this scenario.",mode);
 const entry=obj(scenario.entrySnapshot);
 return {
  track,status:"available",reasonCode:"track_available",reason:null,
  entryBasis:"observed_immediate_fill",entryTimestampMs:entryTime(entry),
  valuationBasis:"observed_marks",
  executionEvidence:mode==="maker"?"observed_maker_opportunity":"observed_taker_execution",
  valuationSource:str(entry.priceSource),provenance:(scenario.provenance??null) as JsonValue,
  engineVersion:null,executionScenario:mode,
  entrySnapshot:(scenario.entrySnapshot??null) as JsonValue,
  valuationPath:arr(scenario.valuationPathSnapshot),
  outcomeSnapshots:arr(scenario.outcomeSnapshots),
 };
}

/**
 * Delayed execution keeps its REAL delayed opening timestamp. It is never
 * backdated to the reference entry: the delayed engine's own entry snapshot
 * supplies the timestamp and the opening economics.
 */
function delayedTrack(structure:Record<string,unknown>,mode:"maker"|"taker"):TrackDescriptor{
 const track:CanonicalTrack=mode==="maker"?"delayed_maker":"delayed_taker";
 const delayed=obj(obj(structure.delayedExecution)[mode]);
 if(delayed.status!=="evaluated")
  return unavailable(track,delayed.status==="not_evaluated"?"delayed_execution_not_evaluated":"delayed_execution_unavailable",
   str(delayed.reason)??"Delayed execution evidence is unavailable for this scenario.",mode);
 const entry=obj(delayed.entrySnapshot);
 return {
  track,status:"available",reasonCode:"track_available",reason:null,
  entryBasis:"observed_delayed_fill",entryTimestampMs:entryTime(entry),
  valuationBasis:"observed_marks",
  executionEvidence:mode==="maker"?"observed_maker_opportunity":"observed_taker_execution",
  valuationSource:str(delayed.source),provenance:(delayed.provenance??null) as JsonValue,
  engineVersion:null,executionScenario:mode,
  entrySnapshot:(delayed.entrySnapshot??null) as JsonValue,
  valuationPath:arr(delayed.valuationPathSnapshot),
  outcomeSnapshots:arr(delayed.outcomeSnapshots),
 };
}

/**
 * Every contracted track for one structure, in canonical order, each with an
 * explicit status. An unavailable track is still described -- the export
 * contract promises a status for all seven, so a consumer can distinguish
 * "this track was not supported here, and why" from "this track is missing
 * from the file".
 */
export function describeCanonicalTracks(structure:Record<string,unknown>):readonly TrackDescriptor[]{
 return [
  referenceTrack(structure),
  modeledTrack(structure,"conservative"),
  modeledTrack(structure,"expected"),
  strictTrack(structure,"maker"),
  strictTrack(structure,"taker"),
  delayedTrack(structure,"maker"),
  delayedTrack(structure,"taker"),
 ];
}

/**
 * Per-leg implied volatility, normalized out of the nested pricing snapshots.
 *
 * Deliberately minimal: this is a data-preservation step only, so a future
 * volatility module can consume per-leg IV history without re-parsing opaque
 * snapshots. No spread-level IV is synthesised -- two legs at different strikes
 * do not share one volatility -- and nothing here influences execution quality.
 */
export interface LegVolatility {
 readonly ivDecimal:number|null;
 readonly ivApiPercent:number|null;
 readonly ivUnits:"decimal"|null;
 /** How the figure was obtained, from the producing engine's own record. */
 readonly ivSource:string|null;
 readonly ivSourceTimestampMs:number|null;
 readonly observation:"observed"|"reconstructed"|"unavailable";
 readonly anchorIndex:number|null;
 readonly targetIndex:number|null;
 readonly dteDays:number|null;
}

export function legVolatility(leg:unknown,pointIv?:unknown,pointIvSource?:unknown):LegVolatility{
 const l=obj(leg),model=obj(l.model);
 const ivDecimal=num(model.anchorIvDecimal)??num(pointIv)??null;
 const ivApiPercent=num(model.anchorIvApiPercent)??(ivDecimal===null?null:ivDecimal*100);
 const source=str(pointIvSource)??str(l.source)??(Object.keys(model).length?"model_anchor":null);
 // "observed" only where the engine anchored on a real trade; anything the
 // model reconstructed says so, and an absent figure stays unavailable.
 const observation:LegVolatility["observation"]=ivDecimal===null?"unavailable"
  :source==="local-observed-IV"||l.source==="direct-vwap"?"observed":"reconstructed";
 return {
  ivDecimal,ivApiPercent,ivUnits:ivDecimal===null?null:"decimal",
  ivSource:source,ivSourceTimestampMs:num(model.anchorTimestamp),
  observation,anchorIndex:num(model.anchorIndex),targetIndex:num(model.targetIndex),
  dteDays:num(model.dte),
 };
}
