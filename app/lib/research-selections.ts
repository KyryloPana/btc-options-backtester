import type { BacktestEvent, Candle, QualityFlag, RetrievedSpread } from "./backtester";

export const RESEARCH_SELECTION_SCHEMA_VERSION = "1.8.0" as const;
/** Every schema version this app can still read and migrate forward from. */
export const LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"] as const;
/** @deprecated kept for external callers; prefer LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS. */
export const LEGACY_RESEARCH_SELECTION_SCHEMA_VERSION = "1.0.0" as const;
export type Venue = "deribit" | "bybit" | "binance";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CandidateIdentityInput {
  venue: Venue; datasetId: string; eventId: string; structure: string; optionType: string;
  expiryTimestamp: number; shortStrike: number; longStrike: number; strikeMethod: string; targetHorizon: number;
}

const part = (value: string | number) => encodeURIComponent(String(value).trim().toLowerCase());
/** Stable, readable identity containing only durable economic dimensions. */
export function stableCandidateId(input: CandidateIdentityInput): string {
  return [input.venue,input.datasetId,input.eventId,input.structure,input.optionType,input.expiryTimestamp,input.shortStrike,input.longStrike,input.strikeMethod,input.targetHorizon].map(part).join("~");
}
export function stableSelectionId(eventId: string, venue: Venue, candidateId: string) { return `selection~${part(eventId)}~${part(venue)}~${candidateId}`; }

export interface GenerationCandidateSnapshot {
  candidateId: string; venue: Venue; selected: boolean; status: "priced" | "unavailable";
  availabilityReasons: string[]; targetHorizon: number; eligibleDteRange: { min: number | null; max: number | null };
  actualExpiryTimestamp: number | null; actualDte: number | null; requestedStrikes: { short: number; long: number; width: number };
  actualStrikes: { short: number | null; long: number | null; width: number | null }; structure: string; optionType: string;
  strikeMethod: string; entryQuality: QualityFlag | null;
}
export interface ReproducibilitySnapshot {
  applicationBuild: string | null; pricingEngineVersion: string; qualityRulesVersion: string; feeScheduleVersion: string;
  dteWindows: JsonValue; expirySelectionMode: string; executionMode: string; pricingAssumption: string; pricingTracks: string[];
  historicalEvidenceWindows: JsonValue; synchronizationThresholds: JsonValue; qualityThresholds: JsonValue; feeAssumptions: JsonValue;
  settlementRules: JsonValue; valuationInterval: string; modelAssumptions: JsonValue; generatedAtUtc: string;
}
/** Authoritative perpetual contract conventions, read from the venue rather than assumed. */
export interface FuturesInstrumentMetadata {instrumentName:string;kind:string;settlementPeriod:string;futureType?:string|null;isActive?:boolean;contractSizeUsd:number|null;tickSize:number|null;minTradeAmountUsd:number|null;makerCommission:number|null;takerCommission:number|null;priceIndex:string|null;settlementCurrency?:string|null;source:string;retrievedAtUtc:string;authoritative:true}
/** Retrieval coverage. Missing observations are counted and named, never filled. */
export interface FuturesSeriesCoverage {source:string;apiStatus?:string;resolutionMs:number;requestedStart:number;requestedEnd:number;expectedPoints:number;receivedPoints:number;missingPoints:number;missingTimestamps:number[];missingTimestampsTruncated?:boolean;status:"complete"|"partial"|"unavailable";forwardFilled:false}
export interface FuturesFundingCoverage {source:string;host?:string;intervalMs:number;rateField:string;requestedStart:number;requestedEnd:number;expectedPoints:number;receivedPoints:number;missingPoints:number;missingTimestamps:number[];missingTimestampsTruncated?:boolean;status:"complete"|"partial"|"unavailable";assumedZeroWhenMissing:false}
/**
 * Persisted, genuine Deribit futures evidence. Index/spot candles are
 * deliberately not accepted here. `price` is the bar close; `open` is the
 * causal fill reference. Absent bars stay absent.
 */
export interface FuturesMarketSnapshot {instrument:string;instrumentKind:"perpetual"|"dated_future";source:"deribit";priceBasis?:"traded_ohlc";retrievedAtUtc?:string;retrievalVersion?:string;instrumentMetadata?:FuturesInstrumentMetadata|null;reference:Array<{timestamp:number;price:number;indexPrice?:number;open?:number;high?:number;low?:number;close?:number;volume?:number}>;referenceCoverage?:FuturesSeriesCoverage|null;trades?:Array<{tradeId:string;timestamp:number;price:number;amountUsd:number;direction:"buy"|"sell";markPrice?:number|null;indexPrice?:number|null;source?:string}>;funding?:Array<{timestamp:number;rate:number;rate8h?:number|null;indexPrice?:number|null}>;fundingCoverage?:FuturesFundingCoverage|null;feeRate?:number;retrievalErrors?:Array<{stage:string;cause:string;retryable:boolean}>;}
export interface GenerationSnapshot { generatedAtUtc: string; configuration: ReproducibilitySnapshot; candidates: GenerationCandidateSnapshot[]; underlyingHourlyPath: Candle[]; futuresMarket?:FuturesMarketSnapshot }
export interface EvidenceTradeDto { evidenceId:string; venue:Venue; instrument:string|null; tradeId:string|null; timestamp:number|null; direction:string|null; price:number|null; amount:number|null; indexPrice:number|null; ivApiPercent:number|null; ivDecimal:number|null; blockTradeId:string|null; rfqId:string|null; }
export interface EvidenceUsageDto { evidenceId:string; candidateId:string; role:string; valuationTimestamp:number|null; pricingTrack:string|null; leg:string|null; executionScenario:"maker"|"taker"|null; }
export type ExecutionScenarioEvaluationStatus = "evaluated" | "unavailable" | "not_evaluated";
export type ContractResolutionStatus = "exact_resolved"|"nearest_listed_resolved"|"confirmed_not_listed"|"retrieval_failure"|"metadata_unavailable";
/**
 * What actually produced a Reference valuation.
 *
 * `same_expiry_linear_interpolation` and `local_iv_anchor` are the two tiers of
 * the validated hybrid promoted in Phase 2C. They are deliberately NOT folded
 * into the older `local_iv_interpolation` label: that label names the historical
 * estimator, and overloading it would make it impossible to tell which
 * methodology priced any given saved structure.
 */
export type ReferenceValuationSource = "causal_exact_trade_anchor"|"historical_mark"|"same_expiry_linear_interpolation"|"local_iv_anchor"|"local_iv_interpolation"|"surface_interpolation"|"surface_extrapolation"|"dvol_anchored_smile_proxy"|"unavailable";
export interface ContractMetadataSnapshot {instrumentName:string|null;creationTimestamp:number|null;expirationTimestamp:number|null;strike:number|null;optionType:string|null;contractSize:number|null;source:string|null;retrievedAtUtc:string|null;authoritative:boolean;}
export interface ContractResolutionSnapshot {status:ContractResolutionStatus;reason:string|null;short:ContractMetadataSnapshot|null;long:ContractMetadataSnapshot|null;}
export interface IndependentTrackSnapshot {status:"valued"|"unavailable"|"not_evaluated";reason:string|null;source:ReferenceValuationSource;entrySnapshot:JsonValue;valuationPathSnapshot:JsonValue[];outcomeSnapshots:JsonValue[];provenance:JsonValue;}
/**
 * One execution scenario's independently-evaluated entry/path/outcomes for a
 * structure. `status:"unavailable"` means this scenario was attempted but
 * rejected by scenario-specific evidence or economics; `status:"not_evaluated"`
 * means it was intentionally not run. Neither state is coerced into a priced
 * estimate, borrowed from the other scenario, or displayed as 0.
 */
export interface ExecutionScenarioSnapshot {
  status: ExecutionScenarioEvaluationStatus;
  /** Why this scenario is not_evaluated; null when evaluated. */
  reason: string | null;
  /**
   * Set only on data migrated from schema < 1.2.0, before entry evidence was
   * filtered by tape direction. The evidence is preserved as originally
   * computed, but it was not scenario-differentiated when it was produced.
   */
  legacyUndifferentiated?: boolean;
  entrySnapshot: JsonValue; valuationPathSnapshot: JsonValue[]; outcomeSnapshots: JsonValue[];
  /** Audit record for canonical path observations removed while reading persisted state. */
  valuationWindowMigration?: { originatingSchema:string; removedCount:number; beforeEntryCount:number; afterExpiryCount:number };
}
export interface SelectedStructure {
  /**
   * Structural selection (immutable during research refresh): selectionId,
   * eventId, candidateId, strategyVariantId, venue, selectedAtUtc, quantity,
   * candidateSnapshot and contractResolution. Everything below is derived and
   * may be atomically replaced by an explicitly requested engine recompute.
   */
  selectionId: string; eventId: string; candidateId: string; venue: Venue; selectedAtUtc: string; quantity: number;
  candidateSnapshot: JsonValue;
  /** Maker opportunity and taker execution, evaluated independently against the same structure. Neither is derived from the other. */
  executionScenarios: { maker: ExecutionScenarioSnapshot; taker: ExecutionScenarioSnapshot };
  /** A non-identical model track retained while migrating legacy 1.5 data. Identical model/reference aliases are collapsed. */
  legacyModelTrack?: ExecutionScenarioSnapshot;
  selectionProvenance?: "model-only-diagnostic"|"raw-priced"|"legacy";
  statusLayers?: JsonValue;
  /** Canonical structural key. Equal to candidateId during the compatibility period. */
  strategyVariantId?: string;
  contractResolution?: ContractResolutionSnapshot;
  referenceValuation?: IndependentTrackSnapshot;
  /** Versioned causal delayed-entry analysis. Kept separate from immediate and reference tracks. */
  delayedExecution?: JsonValue;
  modeledExecution?: JsonValue;
  /** Engine provenance for recomputable outputs; absence on legacy data is a stale diagnostic, never evidence of evaluation. */
  derivedVersions?: Partial<Record<"immediateExecution"|"referenceValuation"|"delayedExecution"|"modeledExecution"|"settlementAccounting"|"margin",string>>;
  derivedRefreshedAtUtc?: string;
  marginSnapshot: JsonValue; evidenceTradeSnapshots?: JsonValue[]; evidenceUsages?: EvidenceUsageDto[];
}
export interface ResearchSelectionEvent { eventId: string; sourceRun: JsonValue; generationSnapshot: GenerationSnapshot; selectedStructures: SelectedStructure[]; evidenceCatalog?: EvidenceTradeDto[] }
export interface ResearchSelectionStore { schemaVersion: typeof RESEARCH_SELECTION_SCHEMA_VERSION; datasetId: string; updatedAtUtc: string; events: ResearchSelectionEvent[] }
export interface SelectionValidationError { path: string; message: string }

const SAFE_ID=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const iso=(v:unknown)=>typeof v==="string" && Number.isFinite(Date.parse(v)) && /(?:Z|[+-]\d\d:\d\d)$/.test(v);
const venue=(v:unknown):v is Venue=>v==="deribit"||v==="bybit"||v==="binance";
function inspectJson(value:unknown,path:string,errors:SelectionValidationError[]):void {
  if(value===null||typeof value==="string"||typeof value==="boolean")return;
  if(typeof value==="number"){if(!Number.isFinite(value))errors.push({path,message:"Numbers must be finite; use null for unavailable values."});return;}
  if(Array.isArray(value)){value.forEach((item,index)=>inspectJson(item,`${path}[${index}]`,errors));return;}
  if(typeof value==="object"){for(const [key,item] of Object.entries(value as Record<string,unknown>))inspectJson(item,`${path}.${key}`,errors);return;}
  errors.push({path,message:"Only JSON values may be persisted."});
}
export function validateResearchSelectionStore(value:unknown):{ok:true;store:ResearchSelectionStore}|{ok:false;errors:SelectionValidationError[]} {
  const errors:SelectionValidationError[]=[];
  if(!value||typeof value!=="object")return{ok:false,errors:[{path:"$",message:"Selection store must be a JSON object."}]};
  const store=value as Partial<ResearchSelectionStore>;
  if(store.schemaVersion!==RESEARCH_SELECTION_SCHEMA_VERSION&&!(LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS as readonly string[]).includes(String(store.schemaVersion)))errors.push({path:"schemaVersion",message:`Expected ${RESEARCH_SELECTION_SCHEMA_VERSION} (or a migratable version: ${LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS.join(", ")}).`});
  if(typeof store.datasetId!=="string"||!SAFE_ID.test(store.datasetId))errors.push({path:"datasetId",message:"Use a safe lowercase dataset ID."});
  if(!iso(store.updatedAtUtc))errors.push({path:"updatedAtUtc",message:"A UTC ISO-8601 timestamp is required."});
  if(!Array.isArray(store.events))errors.push({path:"events",message:"Events must be an array."});
  const eventIds=new Set<string>();
  for(const [i,event] of (Array.isArray(store.events)?store.events:[]).entries()){
    const p=`events[${i}]`;
    if(!event||typeof event!=="object"){errors.push({path:p,message:"Event selection must be an object."});continue;}
    if(typeof event.eventId!=="string"||!event.eventId)errors.push({path:`${p}.eventId`,message:"Event ID is required."});else if(eventIds.has(event.eventId))errors.push({path:`${p}.eventId`,message:"Event IDs must be unique."});else eventIds.add(event.eventId);
    if(!event.generationSnapshot||!Array.isArray(event.generationSnapshot.candidates))errors.push({path:`${p}.generationSnapshot.candidates`,message:"Complete generated candidate universe is required."});
    if(!Array.isArray(event.selectedStructures))errors.push({path:`${p}.selectedStructures`,message:"Selected structures must be an array."});
    const keys=new Set<string>();
    const generationAttempts=new Set<string>();
    for(const [j,c] of (Array.isArray(event.generationSnapshot?.candidates)?event.generationSnapshot.candidates:[]).entries()){
      if(!c||typeof c!=="object")continue;
      const attempt=JSON.stringify([c.candidateId,c.requestedStrikes,c.targetHorizon,c.strikeMethod]);
      if(generationAttempts.has(attempt))errors.push({path:`${p}.generationSnapshot.candidates[${j}]`,message:"Duplicate generation attempt; distinct requested variants may share candidateId, but an identical attempt must occur only once."});
      generationAttempts.add(attempt);
    }
    for(const [j,s] of (Array.isArray(event.selectedStructures)?event.selectedStructures:[]).entries()){
      const q=`${p}.selectedStructures[${j}]`;
      if(!s||typeof s!=="object"){errors.push({path:q,message:"Selection must be an object."});continue;}
      if(s.eventId!==event.eventId)errors.push({path:`${q}.eventId`,message:"Selection event ID must match its event."});
      if(typeof s.candidateId!=="string"||!s.candidateId)errors.push({path:`${q}.candidateId`,message:"Stable candidate ID is required."});
      if(!venue(s.venue))errors.push({path:`${q}.venue`,message:"Venue must be deribit, bybit, or binance."});
      if(!iso(s.selectedAtUtc))errors.push({path:`${q}.selectedAtUtc`,message:"A UTC ISO-8601 timestamp is required."});
      if(typeof s.quantity!=="number"||!Number.isFinite(s.quantity)||s.quantity<=0)errors.push({path:`${q}.quantity`,message:"Quantity must be finite and positive."});
      const key=`${s.venue}:${s.candidateId}`;if(keys.has(key))errors.push({path:q,message:"Duplicate event/candidate selection."});keys.add(key);
      const generated=Array.isArray(event.generationSnapshot?.candidates)?event.generationSnapshot.candidates:[];
      if(typeof s.candidateId==="string"&&!generated.some(c=>c&&typeof c==="object"&&(c as GenerationCandidateSnapshot).candidateId===s.candidateId))errors.push({path:`${q}.candidateId`,message:"Selected candidate is stale/unmatched in the current generation snapshot; remove/reselect or restore the producing snapshot before export."});
      const scenarios=(s as Partial<SelectedStructure>).executionScenarios;
      for(const mode of ["maker","taker"] as const){const scenario=scenarios?.[mode];if(scenario){if(!["evaluated","unavailable","not_evaluated"].includes(String(scenario.status)))errors.push({path:`${q}.executionScenarios.${mode}.status`,message:"Scenario status must be evaluated, unavailable, or not_evaluated."});if(scenario.status!=="evaluated"&&scenario.reason===null)errors.push({path:`${q}.executionScenarios.${mode}.reason`,message:"Unavailable and not_evaluated scenarios require an explicit reason."});if(scenario.status==="evaluated"){const entry=asObj(scenario.entrySnapshot),sold=finite(asObj(entry.sold).priceBtcPerContract),bought=finite(asObj(entry.bought).priceBtcPerContract);if((sold!==null||bought!==null)&&(sold===null||bought===null))errors.push({path:`${q}.executionScenarios.${mode}.entrySnapshot`,message:"Evaluated scenario requires both finite scenario-specific short and long entry premiums."});else if(sold!==null&&bought!==null&&sold<=bought)errors.push({path:`${q}.executionScenarios.${mode}.entrySnapshot`,message:sold===bought?"Credit spread entry has zero gross credit; evaluated scenarios require short premium > long premium.":"Credit spread entry prices imply a debit, not a credit; persist this scenario as unavailable with an explicit reason."});}}}
      // Legacy stores are audited after deterministic migration because their
      // one flat execution track predates executionScenarios. Current stores
      // must already satisfy the canonical retention rule at persistence time.
      if(store.schemaVersion===RESEARCH_SELECTION_SCHEMA_VERSION){
        const eventSource=asObj(asObj(event.sourceRun).event??event.sourceRun);
        const audit=assessCandidateAnalyticalTracks({referenceValuation:s.referenceValuation,executionScenarios:scenarios,contractResolution:s.contractResolution,candidateSnapshot:s.candidateSnapshot,quantity:s.quantity,eventEntryTimestamp:eventSource.entryTimestamp});
        if(!audit.admissible)errors.push({path:q,message:`Selected candidate has no valid analytical track.${audit.referenceErrors.length?` Reference valuation: ${audit.referenceErrors.join("; ")}.`:""}`});
      }
    }
  }
  inspectJson(value,"$",errors);
  return errors.length?{ok:false,errors}:{ok:true,store:store as ResearchSelectionStore};
}

export function emptyResearchSelectionStore(datasetId:string,now=new Date().toISOString()):ResearchSelectionStore{return{schemaVersion:RESEARCH_SELECTION_SCHEMA_VERSION,datasetId,updatedAtUtc:now,events:[]};}
export interface SelectionChangeSet { toAdd:Set<string>; toRemove:Set<string>; toKeep:Set<string> }
/** The complete selection transition. Callers must never infer it from UI toggles. */
export function selectionChangeSet(saved:Iterable<string>,draft:Iterable<string>):SelectionChangeSet{
 const savedSet=new Set(saved),draftSet=new Set(draft);
 return{
  toAdd:new Set([...draftSet].filter(id=>!savedSet.has(id))),
  toRemove:new Set([...savedSet].filter(id=>!draftSet.has(id))),
  toKeep:new Set([...draftSet].filter(id=>savedSet.has(id))),
 };
}
export function sameSelectionIds(left:Iterable<string>,right:Iterable<string>){const a=new Set(left),b=new Set(right);return a.size===b.size&&[...a].every(id=>b.has(id));}
/** Reconciles persisted ids against a regenerated universe without remapping identities. */
export function reconcileGeneratedSelection(saved:Iterable<string>,currentCandidates:Iterable<string>){
 const candidateSet=new Set(currentCandidates),visible=new Set<string>(),stale=new Set<string>();
 for(const id of saved)(candidateSet.has(id)?visible:stale).add(id);
 return{visible,stale};
}
export function canSelectResearchCandidate(status:"priced"|"unavailable",quality?:QualityFlag){void quality;return status==="priced";}

export function candidateIdentity(datasetId:string,eventId:string,spread:RetrievedSpread):CandidateIdentityInput{return{venue:"deribit",datasetId,eventId,structure:spread.spreadKind,optionType:spread.optionType,expiryTimestamp:spread.expiryTimestamp??0,shortStrike:spread.resolvedSoldStrike??spread.soldStrike,longStrike:spread.resolvedBoughtStrike??spread.boughtStrike,strikeMethod:spread.buffered?"buffered":"anchor",targetHorizon:spread.targetDte};}
export function eventReference(event:BacktestEvent):JsonValue{return{id:event.id,label:event.label,direction:event.direction,entryDate:event.entryDate,entryPrice:event.entryPrice,entryTimestamp:event.entryTimestamp??null,entryTimeSource:event.entryTimeSource??null,exitDate:event.exitDate??null,exitPrice:event.exitPrice??null,exitTimestamp:event.exitTimestamp??null,extremePrice:event.extremePrice??null,extremeDate:event.extremeDate??null,extremeTimestamp:event.extremeTimestamp??null,vpocPrice:event.vpocPrice??null,vpocDate:event.vpocDate??null,vpocTimestamp:event.vpocTimestamp??null,invalidationPrice:event.invalidationPrice??null,rangeLow:event.rangeLow??null,rangeHigh:event.rangeHigh??null,notes:event.notes??null};}
/** Converts deliberate DTO data to JSON while preserving unavailable values as null. */
export function canonicalJson(value:unknown):JsonValue { if(value===undefined||typeof value==="number"&&!Number.isFinite(value))return null;if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return value;if(Array.isArray(value))return value.map(canonicalJson);if(typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,canonicalJson(v)]));throw new Error("Research snapshots may contain only JSON data."); }


const asObj=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const finite=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const text=(v:unknown)=>typeof v==="string"&&v?v:null;
const close=(a:number,b:number)=>Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b));

/**
 * The single canonical definition of whether a selected structure has a real
 * analytical track. Delayed/modeled placeholders do not qualify: the current
 * bundle schema exports those states as metadata, not standalone analytical
 * rows. A reference track qualifies only after its contents (not merely its
 * status label) have passed the same structural, temporal and economic audit.
 */
export function assessCandidateAnalyticalTracks(input:{
  referenceValuation?:unknown; executionScenarios?:unknown; contractResolution?:unknown;
  candidateSnapshot?:unknown; quantity?:unknown; eventEntryTimestamp?:unknown;
}){
  const scenarios=asObj(input.executionScenarios);
  const evaluatedExecution=["maker","taker"].some(mode=>asObj(scenarios[mode]).status==="evaluated");
  const reference=asObj(input.referenceValuation),referenceErrors:string[]=[];
  if(reference.status==="valued"){
    const resolution=asObj(input.contractResolution),entry=asObj(reference.entrySnapshot),candidate=asObj(input.candidateSnapshot);
    const sold=finite(asObj(entry.sold).priceBtcPerContract),bought=finite(asObj(entry.bought).priceBtcPerContract);
    const timestamp=finite(entry.valuationTimestamp)??finite(entry.targetTimestamp),expiry=finite(candidate.expiryTimestamp);
    const eventEntry=finite(input.eventEntryTimestamp),quantity=finite(input.quantity);
    const gross=finite(entry.grossSpreadBtc),fees=finite(entry.openingFeesBtc),net=finite(entry.netOpeningCashFlowBtc);
    if(!["exact_resolved","nearest_listed_resolved"].includes(String(resolution.status))||!text(asObj(resolution.short).instrumentName)||!text(asObj(resolution.long).instrumentName))referenceErrors.push("exact structural contracts are not resolved");
    if(reference.source==="unavailable"||!text(reference.source))referenceErrors.push("reference source is unavailable");
    if(!reference.provenance||typeof reference.provenance!=="object"||Array.isArray(reference.provenance)||asObj(reference.provenance).executionIndependent!==true)referenceErrors.push("execution-independent reference provenance is missing");
    if(entry.status!=="priced"||sold===null||bought===null||sold<=bought||quantity===null||quantity<=0)referenceErrors.push("priced reference entry economics are incomplete or invalid");
    if(timestamp===null||!plausibleTimestamp(timestamp)||expiry===null||timestamp>expiry||(eventEntry!==null&&timestamp<eventEntry))referenceErrors.push("reference entry timestamp is outside the candidate lifetime");
    if(gross!==null&&sold!==null&&bought!==null&&quantity!==null&&!close(gross,(sold-bought)*quantity))referenceErrors.push("reference opening gross does not reconcile");
    if(gross!==null&&fees!==null&&net!==null&&!close(net,gross-fees))referenceErrors.push("reference opening total does not reconcile");
    for(const point of Array.isArray(reference.valuationPathSnapshot)?reference.valuationPathSnapshot:[]){const t=finite(asObj(point).timestamp);if(t===null||timestamp===null||expiry===null||t<timestamp||t>expiry){referenceErrors.push("reference valuation timestamp is outside entry-to-expiry bounds");break}}
    const futureTimestamp=(value:unknown):boolean=>{if(Array.isArray(value))return value.some(futureTimestamp);if(value&&typeof value==="object")return Object.entries(value as Record<string,unknown>).some(([key,child])=>/(anchorTimestamp|evidenceTimestamp|supportingTimestamps)$/.test(key)&&(Array.isArray(child)?child.some(x=>finite(x)!==null&&timestamp!==null&&finite(x)!>timestamp):finite(child)!==null&&timestamp!==null&&finite(child)!>timestamp)||futureTimestamp(child));return false};
    if(futureTimestamp(entry))referenceErrors.push("reference entry uses future information");
  }
  const validReference=reference.status==="valued"&&referenceErrors.length===0;
  return{admissible:validReference||evaluatedExecution,validReference,evaluatedExecution,referenceErrors};
}
function plausibleTimestamp(v:number){return Number.isInteger(v)&&v>=946684800000&&v<=4102444800000}
/** Canonical, causal representation for a finite Unix-millisecond value. */
export function canonicalEvidenceTimestamp(value:unknown):number|null{const timestamp=finite(value);return timestamp===null?null:Math.floor(timestamp)}
export function stableEvidenceId(venue:Venue,trade:Record<string,unknown>):string{const instrument=text(trade.instrumentName)??text(trade.instrument)??"unknown",tradeId=text(trade.tradeId)??text(trade.exchangeTradeId);if(tradeId)return `evidence~${part(venue)}~${part(instrument)}~${part(tradeId)}`;return `evidence~${part(venue)}~${part(instrument)}~${part(canonicalEvidenceTimestamp(trade.timestamp)??"no-time")}~${part(text(trade.direction)??"no-side")}~${part(finite(trade.price)??"no-price")}~${part(finite(trade.amount)??"no-amount")}`;}
export function evidenceTradeDto(venue:Venue,trade:Record<string,unknown>):EvidenceTradeDto{return{evidenceId:stableEvidenceId(venue,trade),venue,instrument:text(trade.instrumentName)??text(trade.instrument),tradeId:text(trade.tradeId)??text(trade.exchangeTradeId),timestamp:canonicalEvidenceTimestamp(trade.timestamp),direction:text(trade.direction),price:finite(trade.price),amount:finite(trade.amount),indexPrice:finite(trade.indexPrice),ivApiPercent:finite(trade.ivApiPercent),ivDecimal:finite(trade.ivDecimal),blockTradeId:text(trade.blockTradeId),rfqId:text(trade.rfqId)};}
function addEvidenceUsage(usages:EvidenceUsageDto[],usage:EvidenceUsageDto){const key=JSON.stringify(usage);if(!usages.some(item=>JSON.stringify(item)===key))usages.push(usage);}
function stripEvidence(value:unknown,venue:Venue,candidateId:string,role:string,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,timestamp:number|null=null,track:string|null=null,leg:string|null=null,executionScenario:"maker"|"taker"|null=null):JsonValue{if(value===undefined||typeof value==="number"&&!Number.isFinite(value))return null;if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return value;if(Array.isArray(value))return value.map(v=>stripEvidence(v,venue,candidateId,role,usages,catalog,timestamp,track,leg,executionScenario));if(typeof value==="object"){const input=value as Record<string,unknown>,out:Record<string,JsonValue>={};for(const [k,v] of Object.entries(input)){if(k==="supportingTrades"&&Array.isArray(v)){const ids=[...new Set(v.map(t=>{const dto=evidenceTradeDto(venue,asObj(t));catalog.set(dto.evidenceId,dto);addEvidenceUsage(usages,{evidenceId:dto.evidenceId,candidateId,role,valuationTimestamp:timestamp,pricingTrack:track,leg,executionScenario});return dto.evidenceId}))];out.supportingEvidenceIds=ids;out.supportingTradeCount=ids.length;continue;}out[k]=stripEvidence(v,venue,candidateId,role,usages,catalog,timestamp,track,leg??(k==="sold"||k==="bought"?k:leg),executionScenario);}return out;}throw new Error("Research snapshots may contain only JSON data.");}
export function compactCandidateMetadata(input:unknown):JsonValue{return canonicalJson(input)}
export function compactEntryEconomics(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{return stripEvidence(input,venue,candidateId,"entry-pricing",usages,catalog,finite(asObj(input).targetTimestamp)??finite(asObj(input).valuationTimestamp),String(asObj(input).priceSource??"entry"),null,executionScenario)}
/** Explicit persisted valuation DTO. Runtime aliases and intermediate pricing objects are deliberately excluded. */
export function compactValuationPoint(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{const p=asObj(input),ts=finite(p.timestamp);const estimate=(value:unknown)=>{if(!value)return null;const e=asObj(value),leg=(value:unknown,name:string)=>{const l=asObj(value);return stripEvidence({instrumentName:l.instrumentName,economicSide:l.economicSide,priceBtcPerContract:l.priceBtcPerContract,unslippedPriceBtcPerContract:l.unslippedPriceBtcPerContract,source:l.source,supportingTrades:l.supportingTrades,supportingTimestamps:l.supportingTimestamps,observedAmount:l.observedAmount,nearestGapMinutes:l.nearestGapMinutes,model:l.model?{anchorTimestamp:asObj(l.model).anchorTimestamp,anchorTradeId:asObj(l.model).anchorTradeId,anchorIvApiPercent:asObj(l.model).anchorIvApiPercent,anchorIvDecimal:asObj(l.model).anchorIvDecimal,anchorIndex:asObj(l.model).anchorIndex,targetIndex:asObj(l.model).targetIndex,dte:asObj(l.model).dte,forwardRateAssumption:asObj(l.model).forwardRateAssumption,modelPriceBtc:asObj(l.model).modelPriceBtc,modelName:asObj(l.model).modelName}:null},venue,candidateId,"valuation",usages,catalog,ts,text(e.priceSource),name,executionScenario)};return canonicalJson({valuationTimestamp:e.valuationTimestamp,status:e.status,sold:leg(e.sold,"sold"),bought:leg(e.bought,"bought"),openingFeesBtc:e.openingFeesBtc,evidenceWindowMinutes:e.evidenceWindowMinutes,synchronizationGapMinutes:e.synchronizationGapMinutes,priceSource:e.priceSource,estimateQuality:e.estimateQuality,qualityReason:e.qualityReason});};return canonicalJson({timestamp:p.timestamp,status:p.status,targetIndex:p.targetIndex,indexResolution:p.indexResolution,unavailableReason:p.unavailableReason,rawUnavailableReason:p.rawUnavailableReason,missingField:p.missingField,rawEstimate:estimate(p.rawEstimate),modelEstimate:estimate(p.modelEstimate??p.ivNormalizedEstimate),ivSource:p.ivSource,soldIvSource:p.soldIvSource,longIvSource:p.longIvSource,shortIvDecimal:p.shortIvDecimal,longIvDecimal:p.longIvDecimal,shortModelPriceBtc:p.shortModelPriceBtc,longModelPriceBtc:p.longModelPriceBtc,closingSpreadValueBtcPerContract:p.closingSpreadValueBtcPerContract,closingSpreadValueBtc:p.closingSpreadValueBtc,closingFeesBtc:p.closingFeesBtc,estimatedNetPnlBtc:p.estimatedNetPnlBtc,rawClosingSpreadValueBtcPerContract:p.rawClosingSpreadValueBtcPerContract,rawClosingSpreadValueBtc:p.rawClosingSpreadValueBtc,rawClosingFeesBtc:p.rawClosingFeesBtc,rawEstimatedNetPnlBtc:p.rawEstimatedNetPnlBtc,estimateQuality:p.estimateQuality});}
export function compactOutcomeSnapshot(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{return stripEvidence(input,venue,candidateId,"outcome",usages,catalog,finite(asObj(input).valuationTimestamp),null,null,executionScenario)}
export function compactMarginResult(input:unknown):JsonValue{return stripEvidence(input,"deribit","margin","margin",[],new Map())}

/** Persisted delayed rows are diagnostics, not copies of the runtime tape search. */
export function compactDelayedAttempt(input:unknown):JsonValue{const a=asObj(input),w=asObj(a.window),short=asObj(a.shortLeg),long=asObj(a.longLeg);return canonicalJson({windowId:w.id,startMs:w.startMs,endMs:w.endMs,scenario:a.scenario,status:a.status,reasonCode:a.reasonCode,preEntryResolution:a.preEntryResolution,shortEvidenceAvailable:Boolean(short.tradeCount),longEvidenceAvailable:Boolean(long.tradeCount),shortSupportedAmount:short.supportedAmount??0,longSupportedAmount:long.supportedAmount??0,synchronizationGapMs:a.synchronizationGapMs??null});}
function compactDelayedLeg(input:unknown,venue:Venue,candidateId:string,mode:"maker"|"taker",usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>):JsonValue{const leg=asObj(input);return stripEvidence({instrumentName:leg.instrumentName,action:leg.action,requiredTapeDirection:leg.requiredTapeDirection,requestedAmount:leg.requestedAmount,supportedAmount:leg.supportedAmount,remainingAmount:leg.remainingAmount,tradeCount:leg.tradeCount,firstEvidenceTimestamp:leg.firstEvidenceTimestamp,completionTimestamp:leg.completionTimestamp,evidenceIds:leg.evidenceIds,rawQualifyingAmount:leg.rawQualifyingAmount,vwapBtc:leg.vwapBtc,slippedPriceBtc:leg.slippedPriceBtc,supportingTrades:leg.supportingTrades},venue,candidateId,"delayed-entry",usages,catalog,finite(leg.completionTimestamp),"delayed",text(leg.action),mode);}
export function compactDelayedExecution(input:unknown,venue:Venue,candidateId:string,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>):JsonValue{const root=asObj(input),policy=asObj(root.policy);if(!Object.hasOwn(root,"maker")&&!Object.hasOwn(root,"taker"))return canonicalJson(input);const track=(mode:"maker"|"taker")=>{const t=asObj(root[mode]),entry=asObj(t.entrySnapshot);return canonicalJson({status:t.status,reason:t.reason,reasonCode:t.reasonCode,source:t.source,preEntryResolution:t.preEntryResolution,entrySnapshot:!t.entrySnapshot||!Object.keys(entry).length?null:{valuationTimestamp:entry.valuationTimestamp,targetTimestamp:entry.targetTimestamp,requestedOrderTimestamp:entry.requestedOrderTimestamp,delayHours:entry.delayHours,requestedDelayHours:entry.requestedDelayHours,actualDteRemaining:entry.actualDteRemaining,entryTargetIndex:entry.entryTargetIndex,grossSpreadBtc:entry.grossSpreadBtc,openingFeesBtc:entry.openingFeesBtc,netOpeningCashFlowBtc:entry.netOpeningCashFlowBtc,creditChangeVsReferenceBtc:entry.creditChangeVsReferenceBtc,estimateQuality:entry.estimateQuality,shortLeg:compactDelayedLeg(entry.shortLeg,venue,candidateId,mode,usages,catalog),longLeg:compactDelayedLeg(entry.longLeg,venue,candidateId,mode,usages,catalog),synchronizationGapMs:entry.synchronizationGapMs,policyId:entry.policyId,provenance:entry.provenance},valuationPathSnapshot:Array.isArray(t.valuationPathSnapshot)?t.valuationPathSnapshot.map(canonicalJson):[],outcomeSnapshots:Array.isArray(t.outcomeSnapshots)?t.outcomeSnapshots.map(canonicalJson):[],attempts:Array.isArray(t.attempts)?t.attempts.map(compactDelayedAttempt):[]});};return canonicalJson({version:root.version,policy:{id:policy.id,version:policy.version,maximumDelayMs:policy.maximumDelayMs,maximumLegSynchronizationMs:policy.maximumLegSynchronizationMs,requirePositiveNetCredit:policy.requirePositiveNetCredit,windows:policy.windows},maker:track("maker"),taker:track("taker")});}

export function compactModeledCalibration(input:unknown):JsonValue{const c=asObj(input);return canonicalJson({scenario:c.scenario,status:c.status,count:c.count,minimum:c.minimum,trainingPolicy:c.trainingPolicy,cutoffExclusive:c.cutoffExclusive,sampleFingerprint:c.sampleFingerprint,medianPenaltyBps:c.medianPenaltyBps,upperTailPenaltyBps:c.upperTailPenaltyBps,validation:c.validation});}
function compactModeledTrack(input:unknown):JsonValue{const t=asObj(input);return canonicalJson({status:t.status,reasonCode:t.reasonCode,reason:t.reason,source:t.source,modelVersion:t.modelVersion,penaltyBps:t.penaltyBps,assumptionOrCalibration:t.assumptionOrCalibration,calibrationCount:t.calibrationCount,calibration:compactModeledCalibration(t.calibration),entryTimestamp:t.entryTimestamp,entrySnapshot:t.entrySnapshot,attemptedEntrySnapshot:t.attemptedEntrySnapshot,economicRejection:t.economicRejection,artifactEligibleTradeCount:t.artifactEligibleTradeCount,outcomeSnapshots:t.outcomeSnapshots,uncertainty:t.uncertainty,referenceQuality:t.referenceQuality,provenance:t.provenance,pathDerivation:t.status==="evaluated"?{kind:"reference-marks-plus-modeled-opening-ledger",reference:"referenceValuation.valuationPathSnapshot",version:"1"}:null});}
export function compactModeledSensitivity(input:unknown):JsonValue{const s=asObj(input);return canonicalJson({status:s.status,reason:s.reason,source:s.source,modelVersion:s.modelVersion,calibrationCount:s.calibrationCount,calibration:compactModeledCalibration(s.calibration),assumptionGrid:s.assumptionGrid,grid:Array.isArray(s.grid)?s.grid.map(row=>{const r=asObj(row);return{penaltyBps:r.penaltyBps,label:r.label,track:compactModeledTrack(r.track)}}):[],provenance:s.provenance});}
export function compactModeledExecution(input:unknown):JsonValue{const m=asObj(input);if(!Object.hasOwn(m,"expected")&&!Object.hasOwn(m,"conservative")&&!Object.hasOwn(m,"penaltySensitivity"))return canonicalJson(input);return canonicalJson({expected:compactModeledTrack(m.expected),conservative:compactModeledTrack(m.conservative),penaltySensitivity:compactModeledSensitivity(m.penaltySensitivity)});}

/** The authoritative runtime -> persisted event boundary used by save, refresh and migration. */
export function compactResearchSelectionEvent(event:ResearchSelectionEvent):ResearchSelectionEvent{const evidenceIdRemap=new Map<string,string>(),catalog=new Map<string,EvidenceTradeDto>();for(const evidence of event.evidenceCatalog??[]){const normalized=evidenceTradeDto(evidence.venue,evidence as unknown as Record<string,unknown>);evidenceIdRemap.set(evidence.evidenceId,normalized.evidenceId);catalog.set(normalized.evidenceId,normalized)}const selectedStructures=event.selectedStructures.map(s=>{const usages=(s.evidenceUsages??[]).map(usage=>({...usage,evidenceId:evidenceIdRemap.get(usage.evidenceId)??usage.evidenceId}));const delayedExecution=s.delayedExecution===undefined?undefined:compactDelayedExecution(s.delayedExecution,s.venue,s.candidateId,usages,catalog),modeledExecution=s.modeledExecution===undefined?undefined:compactModeledExecution(s.modeledExecution);return{...s,...(delayedExecution===undefined?{}:{delayedExecution}),...(modeledExecution===undefined?{}:{modeledExecution}),...(s.evidenceTradeSnapshots===undefined?{}:{evidenceTradeSnapshots:[]}),...(!usages.length&&s.evidenceUsages===undefined?{}:{evidenceUsages:[...new Map(usages.map(u=>[JSON.stringify(u),u])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})}});return{...event,selectedStructures,...(event.evidenceCatalog===undefined&&!catalog.size?{}:{evidenceCatalog:[...catalog.values()].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId))})};}
/**
 * Migrates a store from any known legacy schema version to current.
 *
 * Pre-1.2.0 stores have one flat scenario (entrySnapshot/valuationPathSnapshot/
 * outcomeSnapshots) rather than executionScenarios.maker/taker, because entry
 * evidence was not yet filtered by tape direction -- there was no genuine
 * maker/taker distinction to preserve. That single scenario is kept, under
 * whichever execution mode label the generation run recorded, flagged
 * legacyUndifferentiated so it is never mistaken for a direction-aware
 * evaluation. The OTHER scenario is explicitly not_evaluated: never fabricated
 * as 0, never silently dropped.
 */
export function migrateResearchSelectionStore(value:unknown):ResearchSelectionStore{const checked=validateResearchSelectionStore(value);if(!checked.ok)throw new Error(checked.errors.map(e=>`${e.path}: ${e.message}`).join(" | "));const store=checked.store;const originatingSchema=String(store.schemaVersion);let changed=false;const canonicalize=(scenario:ExecutionScenarioSnapshot,expiry:number|null):ExecutionScenarioSnapshot=>{if(scenario.status!=="evaluated")return scenario;const entryObject=asObj(scenario.entrySnapshot),entry=finite(entryObject.valuationTimestamp)??finite(entryObject.targetTimestamp);if(entry===null||expiry===null)return scenario;let beforeEntryCount=0,afterExpiryCount=0;const valuationPathSnapshot=scenario.valuationPathSnapshot.filter(point=>{const timestamp=finite(asObj(point).timestamp);if(timestamp===null)return true;if(timestamp<entry){beforeEntryCount++;return false}if(timestamp>expiry){afterExpiryCount++;return false}return true});const removedCount=beforeEntryCount+afterExpiryCount;if(!removedCount)return scenario;changed=true;return{...scenario,valuationPathSnapshot,valuationWindowMigration:{originatingSchema,removedCount,beforeEntryCount,afterExpiryCount}}};if(store.schemaVersion===RESEARCH_SELECTION_SCHEMA_VERSION){const events=store.events.map(event=>compactResearchSelectionEvent({...event,selectedStructures:event.selectedStructures.map(structure=>{const expiry=finite(asObj(structure.candidateSnapshot).expiryTimestamp),maker=canonicalize(structure.executionScenarios.maker,expiry),taker=canonicalize(structure.executionScenarios.taker,expiry);return maker===structure.executionScenarios.maker&&taker===structure.executionScenarios.taker?structure:{...structure,executionScenarios:{maker,taker}}})}));return {...store,events}}const wasLegacy=true;changed=true;const events=store.events.map(event=>{const catalog=new Map<string,EvidenceTradeDto>((event.evidenceCatalog??[]).map(t=>[t.evidenceId,t]));const selectedStructures=event.selectedStructures.map(raw=>{const legacy=raw as unknown as Record<string,unknown>;const usages:EvidenceUsageDto[]=[...(raw.evidenceUsages??[])];for(const t of (legacy.evidenceTradeSnapshots as unknown[]|undefined)??[]){const dto=evidenceTradeDto(raw.venue,asObj(t));catalog.set(dto.evidenceId,dto);usages.push({evidenceId:dto.evidenceId,candidateId:raw.candidateId,role:"legacy-saved-source-trade",valuationTimestamp:finite(asObj(t).timestamp),pricingTrack:null,leg:null,executionScenario:null});}
  const existing=legacy.executionScenarios as {maker:ExecutionScenarioSnapshot;taker:ExecutionScenarioSnapshot}|undefined;
  let executionScenarios:{maker:ExecutionScenarioSnapshot;taker:ExecutionScenarioSnapshot};
  if(existing){executionScenarios=existing;}
  else{
    const legacyMode=String(asObj(event.generationSnapshot?.configuration).executionMode)==="maker"?"maker":"taker";
    const evaluated:ExecutionScenarioSnapshot={status:"evaluated",reason:null,legacyUndifferentiated:true,
      entrySnapshot:compactEntryEconomics(raw.venue,raw.candidateId,legacy.entrySnapshot,usages,catalog),
      valuationPathSnapshot:((legacy.valuationPathSnapshot as unknown[]|undefined)??[]).map(p=>compactValuationPoint(raw.venue,raw.candidateId,p,usages,catalog)),
      outcomeSnapshots:((legacy.outcomeSnapshots as unknown[]|undefined)??[]).map(o=>compactOutcomeSnapshot(raw.venue,raw.candidateId,o,usages,catalog))};
    const notEvaluated:ExecutionScenarioSnapshot={status:"not_evaluated",reason:"Predates independent maker/taker evaluation; this store was migrated from an earlier schema version.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]};
    executionScenarios=legacyMode==="maker"?{maker:evaluated,taker:notEvaluated}:{maker:notEvaluated,taker:evaluated};
  }
  const expiry=finite(asObj(raw.candidateSnapshot).expiryTimestamp);
  executionScenarios={maker:canonicalize(executionScenarios.maker,expiry),taker:canonicalize(executionScenarios.taker,expiry)};
  const {entrySnapshot:_es,valuationPathSnapshot:_vp,outcomeSnapshots:_os,modelTrack:_modelTrack,...rest}=legacy;void _es;void _vp;void _os;
  const notImplemented="Schema placeholder only; no search or modeled execution was performed.";
  const referenceValuation=(legacy.referenceValuation as IndependentTrackSnapshot|undefined)??{status:"not_evaluated" as const,reason:"Legacy record; reference valuation was not independently evaluated.",source:"unavailable" as const,entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[],provenance:{legacy:true}};
  const modelTrack=_modelTrack as ExecutionScenarioSnapshot|undefined;
  const equivalent=modelTrack!==undefined&&JSON.stringify([modelTrack.entrySnapshot,modelTrack.valuationPathSnapshot,modelTrack.outcomeSnapshots])===JSON.stringify([referenceValuation.entrySnapshot,referenceValuation.valuationPathSnapshot,referenceValuation.outcomeSnapshots]);
  const uniqueUsages=[...new Map(usages.map(usage=>[JSON.stringify(usage),usage])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return{...(rest as unknown as SelectedStructure),strategyVariantId:String(legacy.strategyVariantId??raw.candidateId),contractResolution:(legacy.contractResolution as ContractResolutionSnapshot|undefined)??{status:"metadata_unavailable",reason:"Legacy record; contract metadata status was not recorded.",short:null,long:null},referenceValuation,delayedExecution:(legacy.delayedExecution as SelectedStructure["delayedExecution"]|undefined)??{status:"not_evaluated",reason:notImplemented},modeledExecution:(legacy.modeledExecution as SelectedStructure["modeledExecution"]|undefined)??{expected:{status:"not_evaluated",reason:notImplemented},conservative:{status:"not_evaluated",reason:notImplemented}},executionScenarios,...(modelTrack&&!equivalent?{legacyModelTrack:modelTrack}:{}),selectionProvenance:(legacy.selectionProvenance as SelectedStructure["selectionProvenance"]|undefined)??(wasLegacy?"legacy":undefined),statusLayers:(legacy.statusLayers as JsonValue|undefined)??null,marginSnapshot:compactMarginResult(legacy.marginSnapshot),evidenceTradeSnapshots:[],evidenceUsages:uniqueUsages};
 });return{...event,selectedStructures,evidenceCatalog:[...catalog.values()].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId))};});return {...store,schemaVersion:RESEARCH_SELECTION_SCHEMA_VERSION,events:events.map(compactResearchSelectionEvent)};}
export function researchEventPayloadDiagnostics(event:ResearchSelectionEvent){const encoder=new TextEncoder(),bytes=(v:unknown)=>encoder.encode(JSON.stringify(v)).byteLength,track=(t:ExecutionScenarioSnapshot|IndependentTrackSnapshot|undefined)=>({totalBytes:bytes(t??null),entryBytes:bytes(t?.entrySnapshot??null),pathBytes:bytes(t?.valuationPathSnapshot??[]),outcomeBytes:bytes(t?.outcomeSnapshots??[]),pathPointCount:t?.valuationPathSnapshot?.length??0});return{sourceEventBytes:bytes(event.sourceRun),generationConfigurationBytes:bytes(event.generationSnapshot.configuration),candidateSnapshotBytes:bytes(event.generationSnapshot.candidates),underlyingHourlyPathBytes:bytes(event.generationSnapshot.underlyingHourlyPath),selectedStructuresBytes:bytes(event.selectedStructures),selectedCandidateBytes:event.selectedStructures.map(s=>({candidateId:s.candidateId,totalBytes:bytes(s),candidateSnapshotBytes:bytes(s.candidateSnapshot),contractResolutionBytes:bytes(s.contractResolution??null),statusLayersBytes:bytes(s.statusLayers??null),maker:track(s.executionScenarios.maker),taker:track(s.executionScenarios.taker),reference:track(s.referenceValuation),legacyModel:track(s.legacyModelTrack),makerEntrySnapshotBytes:bytes(s.executionScenarios.maker.entrySnapshot),makerValuationPathBytes:bytes(s.executionScenarios.maker.valuationPathSnapshot),makerOutcomesBytes:bytes(s.executionScenarios.maker.outcomeSnapshots),takerEntrySnapshotBytes:bytes(s.executionScenarios.taker.entrySnapshot),takerValuationPathBytes:bytes(s.executionScenarios.taker.valuationPathSnapshot),takerOutcomesBytes:bytes(s.executionScenarios.taker.outcomeSnapshots),delayedExecutionBytes:bytes(s.delayedExecution??null),modeledExecutionBytes:bytes(s.modeledExecution??null),marginBytes:bytes(s.marginSnapshot),evidenceBytes:bytes(s.evidenceTradeSnapshots??[]),evidenceUsageBytes:bytes(s.evidenceUsages??[])})),eventEvidenceCatalogBytes:bytes(event.evidenceCatalog??[]),totalBytes:bytes(event)};}

/**
 * Removing an event from the research selection store.
 *
 * Every canonical bundle table -- availability, candidates, valuations,
 * outcomes, margin scenarios, evidence trades and futures comparisons -- is
 * derived from `store.events` when the bundle is built, so dropping the event
 * here is what actually cascades: there are no separate rows to sweep and no
 * need to filter the exported ZIP after the fact.
 *
 * Deliberately event-owned and therefore removed with it: the generation
 * snapshot (including its stored hourly underlying path), the selected
 * structures and their scenario snapshots, and this event's own evidence
 * catalogue. Other events keep their own catalogues, and no shared raw market
 * data is touched -- candles and contract tapes are fetched from the venue,
 * never owned by an event.
 */
export function deleteResearchSelectionEvent(store:ResearchSelectionStore,eventId:string,now=new Date().toISOString()):ResearchSelectionStore{
 const events=store.events.filter(event=>event.eventId!==eventId);
 return events.length===store.events.length?store:{...store,updatedAtUtc:now,events};
}

/**
 * Renaming an event's canonical id, propagating the change through every
 * reference that embeds it.
 *
 * `stableCandidateId` bakes `venue~datasetId~eventId~...` into each candidate
 * id, and `stableSelectionId` embeds the event id again, so a bare field write
 * would leave every selected structure pointing at an identity that no longer
 * exists. Candidate ids are remapped by replacing that literal leading
 * `venue~datasetId~eventId~` prefix rather than by splitting on "~": `part()`
 * is `encodeURIComponent`, which leaves "~" untouched, so an id containing one
 * would break positional parsing while a whole-prefix match stays exact.
 *
 * Selection ids are recomputed from the canonical helper rather than patched,
 * so they cannot drift from the function that generates them.
 */
export function renameResearchSelectionEvent(store:ResearchSelectionStore,oldEventId:string,newEventId:string,now=new Date().toISOString()):ResearchSelectionStore{
 if(oldEventId===newEventId)return store;
 const target=store.events.find(event=>event.eventId===oldEventId);
 if(!target)return store;

 const remap=new Map<string,string>();
 const candidateIdFor=(candidateId:string,venue:Venue)=>{
  const cached=remap.get(candidateId);if(cached)return cached;
  const oldPrefix=[venue,store.datasetId,oldEventId].map(part).join("~")+"~";
  const next=candidateId.startsWith(oldPrefix)
   ?[venue,store.datasetId,newEventId].map(part).join("~")+"~"+candidateId.slice(oldPrefix.length)
   :candidateId;
  remap.set(candidateId,next);return next;
 };

 const events=store.events.map(event=>{
  if(event.eventId!==oldEventId)return event;
  const selectedStructures=event.selectedStructures.map(structure=>{
   const candidateId=candidateIdFor(structure.candidateId,structure.venue);
   return {
    ...structure,eventId:newEventId,candidateId,
    selectionId:stableSelectionId(newEventId,structure.venue,candidateId),
    evidenceUsages:structure.evidenceUsages?.map(usage=>({...usage,candidateId:candidateIdFor(usage.candidateId,structure.venue)})),
   } satisfies SelectedStructure;
  });
  const candidates=event.generationSnapshot.candidates.map(candidate=>({...candidate,candidateId:candidateIdFor(candidate.candidateId,candidate.venue)}));
  // sourceRun carries the event reference the bundle reads its event_id from.
  const sourceRun=renameEventReference(event.sourceRun,newEventId);
  return {...event,eventId:newEventId,sourceRun,generationSnapshot:{...event.generationSnapshot,candidates},selectedStructures};
 });
 return {...store,updatedAtUtc:now,events};
}

/** Rewrites the `id` on a stored event reference, at the top level or nested under `event`. */
function renameEventReference(sourceRun:JsonValue,newEventId:string):JsonValue{
 if(!sourceRun||typeof sourceRun!=="object"||Array.isArray(sourceRun))return sourceRun;
 const record=sourceRun as {[key:string]:JsonValue};
 const nested=record.event;
 if(nested&&typeof nested==="object"&&!Array.isArray(nested))return {...record,event:{...(nested as {[key:string]:JsonValue}),id:newEventId}};
 return "id" in record?{...record,id:newEventId}:record;
}
