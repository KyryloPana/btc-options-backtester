import type { BacktestEvent, Candle, QualityFlag, RetrievedSpread } from "./backtester";

export const RESEARCH_SELECTION_SCHEMA_VERSION = "1.2.0" as const;
/** Every schema version this app can still read and migrate forward from. */
export const LEGACY_RESEARCH_SELECTION_SCHEMA_VERSIONS = ["1.0.0", "1.1.0"] as const;
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
export interface GenerationSnapshot { generatedAtUtc: string; configuration: ReproducibilitySnapshot; candidates: GenerationCandidateSnapshot[]; underlyingHourlyPath: Candle[] }
export interface EvidenceTradeDto { evidenceId:string; venue:Venue; instrument:string|null; tradeId:string|null; timestamp:number|null; direction:string|null; price:number|null; amount:number|null; indexPrice:number|null; ivApiPercent:number|null; ivDecimal:number|null; blockTradeId:string|null; rfqId:string|null; }
export interface EvidenceUsageDto { evidenceId:string; candidateId:string; role:string; valuationTimestamp:number|null; pricingTrack:string|null; leg:string|null; executionScenario:"maker"|"taker"|null; }
export type ExecutionScenarioEvaluationStatus = "evaluated" | "unavailable" | "not_evaluated";
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
}
export interface SelectedStructure {
  selectionId: string; eventId: string; candidateId: string; venue: Venue; selectedAtUtc: string; quantity: number;
  candidateSnapshot: JsonValue;
  /** Maker opportunity and taker execution, evaluated independently against the same structure. Neither is derived from the other. */
  executionScenarios: { maker: ExecutionScenarioSnapshot; taker: ExecutionScenarioSnapshot };
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
    }
  }
  inspectJson(value,"$",errors);
  return errors.length?{ok:false,errors}:{ok:true,store:store as ResearchSelectionStore};
}

export function emptyResearchSelectionStore(datasetId:string,now=new Date().toISOString()):ResearchSelectionStore{return{schemaVersion:RESEARCH_SELECTION_SCHEMA_VERSION,datasetId,updatedAtUtc:now,events:[]};}
export function reconcileSelectionIds(saved:Iterable<string>,toggles:ReadonlyMap<string,boolean>){const next=new Set(saved);for(const[id,selected]of toggles){if(selected)next.add(id);else next.delete(id);}return next;}
export function canSelectResearchCandidate(status:"priced"|"unavailable",quality?:QualityFlag){void quality;return status==="priced";}

export function candidateIdentity(datasetId:string,eventId:string,spread:RetrievedSpread):CandidateIdentityInput{return{venue:"deribit",datasetId,eventId,structure:spread.spreadKind,optionType:spread.optionType,expiryTimestamp:spread.expiryTimestamp??0,shortStrike:spread.resolvedSoldStrike??spread.soldStrike,longStrike:spread.resolvedBoughtStrike??spread.boughtStrike,strikeMethod:spread.buffered?"buffered":"anchor",targetHorizon:spread.targetDte};}
export function eventReference(event:BacktestEvent):JsonValue{return{id:event.id,label:event.label,direction:event.direction,entryDate:event.entryDate,entryPrice:event.entryPrice,entryTimestamp:event.entryTimestamp??null,entryTimeSource:event.entryTimeSource??null,exitDate:event.exitDate??null,exitPrice:event.exitPrice??null,exitTimestamp:event.exitTimestamp??null,extremePrice:event.extremePrice??null,vpocPrice:event.vpocPrice??null,vpocDate:event.vpocDate??null,vpocTimestamp:event.vpocTimestamp??null,invalidationPrice:event.invalidationPrice??null,rangeLow:event.rangeLow??null,rangeHigh:event.rangeHigh??null,notes:event.notes??null};}
/** Converts deliberate DTO data to JSON while preserving unavailable values as null. */
export function canonicalJson(value:unknown):JsonValue { if(value===undefined||typeof value==="number"&&!Number.isFinite(value))return null;if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return value;if(Array.isArray(value))return value.map(canonicalJson);if(typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k,canonicalJson(v)]));throw new Error("Research snapshots may contain only JSON data."); }


const asObj=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const finite=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;
const text=(v:unknown)=>typeof v==="string"&&v?v:null;
export function stableEvidenceId(venue:Venue,trade:Record<string,unknown>):string{const instrument=text(trade.instrumentName)??text(trade.instrument)??"unknown",tradeId=text(trade.tradeId)??text(trade.exchangeTradeId);if(tradeId)return `evidence~${part(venue)}~${part(instrument)}~${part(tradeId)}`;return `evidence~${part(venue)}~${part(instrument)}~${part(finite(trade.timestamp)??"no-time")}~${part(text(trade.direction)??"no-side")}~${part(finite(trade.price)??"no-price")}~${part(finite(trade.amount)??"no-amount")}`;}
export function evidenceTradeDto(venue:Venue,trade:Record<string,unknown>):EvidenceTradeDto{return{evidenceId:stableEvidenceId(venue,trade),venue,instrument:text(trade.instrumentName)??text(trade.instrument),tradeId:text(trade.tradeId)??text(trade.exchangeTradeId),timestamp:finite(trade.timestamp),direction:text(trade.direction),price:finite(trade.price),amount:finite(trade.amount),indexPrice:finite(trade.indexPrice),ivApiPercent:finite(trade.ivApiPercent),ivDecimal:finite(trade.ivDecimal),blockTradeId:text(trade.blockTradeId),rfqId:text(trade.rfqId)};}
function stripEvidence(value:unknown,venue:Venue,candidateId:string,role:string,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,timestamp:number|null=null,track:string|null=null,leg:string|null=null,executionScenario:"maker"|"taker"|null=null):JsonValue{if(value===undefined||typeof value==="number"&&!Number.isFinite(value))return null;if(value===null||typeof value==="string"||typeof value==="boolean"||typeof value==="number")return value;if(Array.isArray(value))return value.map(v=>stripEvidence(v,venue,candidateId,role,usages,catalog,timestamp,track,leg,executionScenario));if(typeof value==="object"){const input=value as Record<string,unknown>,out:Record<string,JsonValue>={};for(const [k,v] of Object.entries(input)){if(k==="supportingTrades"&&Array.isArray(v)){const ids=v.map(t=>{const dto=evidenceTradeDto(venue,asObj(t));catalog.set(dto.evidenceId,dto);usages.push({evidenceId:dto.evidenceId,candidateId,role,valuationTimestamp:timestamp,pricingTrack:track,leg,executionScenario});return dto.evidenceId});out.supportingEvidenceIds=ids;out.supportingTradeCount=ids.length;continue;}out[k]=stripEvidence(v,venue,candidateId,role,usages,catalog,timestamp,track,leg??(k==="sold"||k==="bought"?k:leg),executionScenario);}return out;}throw new Error("Research snapshots may contain only JSON data.");}
export function compactCandidateMetadata(input:unknown):JsonValue{return canonicalJson(input)}
export function compactEntryEconomics(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{return stripEvidence(input,venue,candidateId,"entry-pricing",usages,catalog,finite(asObj(input).targetTimestamp)??finite(asObj(input).valuationTimestamp),String(asObj(input).priceSource??"entry"),null,executionScenario)}
export function compactValuationPoint(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{const p=asObj(input),ts=finite(p.timestamp);const out=stripEvidence(input,venue,candidateId,"valuation",usages,catalog,ts,null,null,executionScenario) as Record<string,JsonValue>;return out;}
export function compactOutcomeSnapshot(venue:Venue,candidateId:string,input:unknown,usages:EvidenceUsageDto[],catalog:Map<string,EvidenceTradeDto>,executionScenario:"maker"|"taker"|null=null):JsonValue{return stripEvidence(input,venue,candidateId,"outcome",usages,catalog,finite(asObj(input).valuationTimestamp),null,null,executionScenario)}
export function compactMarginResult(input:unknown):JsonValue{return stripEvidence(input,"deribit","margin","margin",[],new Map())}
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
export function migrateResearchSelectionStore(value:unknown):ResearchSelectionStore{const checked=validateResearchSelectionStore(value);if(!checked.ok)throw new Error(checked.errors.map(e=>`${e.path}: ${e.message}`).join(" | "));const store=checked.store;if(store.schemaVersion===RESEARCH_SELECTION_SCHEMA_VERSION)return store;const events=store.events.map(event=>{const catalog=new Map<string,EvidenceTradeDto>();const selectedStructures=event.selectedStructures.map(raw=>{const legacy=raw as unknown as Record<string,unknown>;const usages:EvidenceUsageDto[]=[];for(const t of (legacy.evidenceTradeSnapshots as unknown[]|undefined)??[]){const dto=evidenceTradeDto(raw.venue,asObj(t));catalog.set(dto.evidenceId,dto);usages.push({evidenceId:dto.evidenceId,candidateId:raw.candidateId,role:"legacy-saved-source-trade",valuationTimestamp:finite(asObj(t).timestamp),pricingTrack:null,leg:null,executionScenario:null});}
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
  const {entrySnapshot:_es,valuationPathSnapshot:_vp,outcomeSnapshots:_os,...rest}=legacy;void _es;void _vp;void _os;
  return{...(rest as unknown as SelectedStructure),executionScenarios,marginSnapshot:compactMarginResult(legacy.marginSnapshot),evidenceTradeSnapshots:[],evidenceUsages:usages};
 });return{...event,selectedStructures,evidenceCatalog:[...catalog.values()].sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId))};});return{...store,schemaVersion:RESEARCH_SELECTION_SCHEMA_VERSION,events};}
export function researchEventPayloadDiagnostics(event:ResearchSelectionEvent){const encoder=new TextEncoder(),bytes=(v:unknown)=>encoder.encode(JSON.stringify(v)).byteLength;return{sourceEventBytes:bytes(event.sourceRun),selectedCandidateBytes:event.selectedStructures.map(s=>({candidateId:s.candidateId,totalBytes:bytes(s),candidateSnapshotBytes:bytes(s.candidateSnapshot),makerEntrySnapshotBytes:bytes(s.executionScenarios.maker.entrySnapshot),makerValuationPathBytes:bytes(s.executionScenarios.maker.valuationPathSnapshot),makerOutcomesBytes:bytes(s.executionScenarios.maker.outcomeSnapshots),takerEntrySnapshotBytes:bytes(s.executionScenarios.taker.entrySnapshot),takerValuationPathBytes:bytes(s.executionScenarios.taker.valuationPathSnapshot),takerOutcomesBytes:bytes(s.executionScenarios.taker.outcomeSnapshots),marginBytes:bytes(s.marginSnapshot),evidenceBytes:bytes(s.evidenceTradeSnapshots??[]),evidenceUsageBytes:bytes(s.evidenceUsages??[])})),candidateSnapshotBytes:bytes(event.generationSnapshot.candidates),eventEvidenceCatalogBytes:bytes(event.evidenceCatalog??[]),totalBytes:bytes(event)};}

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
