import type { BacktestEvent, Candle, QualityFlag, RetrievedSpread } from "./backtester";

export const RESEARCH_SELECTION_SCHEMA_VERSION = "1.0.0" as const;
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
export interface SelectedStructure {
  selectionId: string; eventId: string; candidateId: string; venue: Venue; selectedAtUtc: string; quantity: number;
  candidateSnapshot: JsonValue; entrySnapshot: JsonValue; valuationPathSnapshot: JsonValue[]; outcomeSnapshots: JsonValue[];
  marginSnapshot: JsonValue; evidenceTradeSnapshots: JsonValue[];
}
export interface ResearchSelectionEvent { eventId: string; sourceRun: JsonValue; generationSnapshot: GenerationSnapshot; selectedStructures: SelectedStructure[] }
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
  if(store.schemaVersion!==RESEARCH_SELECTION_SCHEMA_VERSION)errors.push({path:"schemaVersion",message:`Expected ${RESEARCH_SELECTION_SCHEMA_VERSION}.`});
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
    for(const [j,s] of (Array.isArray(event.selectedStructures)?event.selectedStructures:[]).entries()){
      const q=`${p}.selectedStructures[${j}]`;
      if(!s||typeof s!=="object"){errors.push({path:q,message:"Selection must be an object."});continue;}
      if(s.eventId!==event.eventId)errors.push({path:`${q}.eventId`,message:"Selection event ID must match its event."});
      if(typeof s.candidateId!=="string"||!s.candidateId)errors.push({path:`${q}.candidateId`,message:"Stable candidate ID is required."});
      if(!venue(s.venue))errors.push({path:`${q}.venue`,message:"Venue must be deribit, bybit, or binance."});
      if(!iso(s.selectedAtUtc))errors.push({path:`${q}.selectedAtUtc`,message:"A UTC ISO-8601 timestamp is required."});
      if(typeof s.quantity!=="number"||!Number.isFinite(s.quantity)||s.quantity<=0)errors.push({path:`${q}.quantity`,message:"Quantity must be finite and positive."});
      const key=`${s.venue}:${s.candidateId}`;if(keys.has(key))errors.push({path:q,message:"Duplicate event/candidate selection."});keys.add(key);
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
