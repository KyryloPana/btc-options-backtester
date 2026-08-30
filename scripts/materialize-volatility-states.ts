import type {ResearchSelectionStore} from "../app/lib/research-selections.ts";
import type {ResearchVolatilityStates} from "../app/lib/research-bundle.ts";
import {resolveEventTiming} from "../app/lib/event-timing.ts";
import {buildEventVolatilityState,buildStructureVolatilityState,type BroadVolatilityState,type LegVolatilitySnapshot} from "../app/lib/volatility/volatility-state.ts";
import {DVOL_FIRST_AVAILABLE_MS,DVOL_METHOD_VERSION,DVOL_SERIES_ID,REFERENCE_SERIES_ID,buildExpiryReferenceRow,buildReferenceSeriesRows,referenceSeriesContentHash,type ListedExpiry,type ReferenceSeriesRow} from "../app/lib/volatility/reference-series.ts";
import {MARKET_IV_MAX_AGE_MINUTES,type RawIvTradeCandidate} from "../app/lib/volatility/market-iv-evidence.ts";
import {causalIvPercentile,type ReferenceObservation} from "../app/lib/volatility/iv-percentile.ts";
import {HOUR_MS,realizedVolatilityProfile,type HourlyClose} from "../app/lib/volatility/realized-volatility.ts";
import {DeribitPerpetualHistoryService} from "./deribit-perpetual-history.ts";
import {OPTION_HISTORY_HOST} from "../app/lib/volatility/reference-series.ts";
import {VolatilityReferenceRetrieval,listCachedShards,readDvolShard,readReferenceShard,VOLATILITY_CACHE_ROOT,writeDvolShards,writeReferenceShards} from "./volatility-reference-cache.ts";

type R=Record<string,unknown>;const o=(v:unknown):R=>v&&typeof v==="object"&&!Array.isArray(v)?v as R:{};const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;const s=(v:unknown)=>typeof v==="string"&&v?v:null;
const TENORS=["7d","14d","30d"] as const;

export interface VolatilityMaterializationDependencies {
 retrieval?:VolatilityReferenceRetrieval;
 perpetualBars?:(startMs:number,endMs:number)=>Promise<HourlyClose[]>;
 /** Tests and offline exporters may deliberately disable network population. */
 populateMissing?:boolean;
}

function eventEntry(event:ResearchSelectionStore["events"][number]){
 return resolveEventTiming({sourceRun:event.sourceRun,underlyingHourlyPath:event.generationSnapshot.underlyingHourlyPath}).entryTimestamp;
}
function sourceEntryPrice(event:ResearchSelectionStore["events"][number]){const source=o(event.sourceRun),raw=o(source.event??source);return n(raw.entryPrice)}
function instrumentNames(selected:ResearchSelectionStore["events"][number]["selectedStructures"][number]){
 const resolution=o(selected.contractResolution),candidate=o(selected.candidateSnapshot),legacy=o(candidate.instruments);
 return {short:s(o(resolution.short).instrumentName)??s(legacy.short),long:s(o(resolution.long).instrumentName)??s(legacy.long)};
}
function raw(meta:{instrumentName:string;strike:number;optionType:"C"|"P";expiryTimestampMs:number;createdAtMs:number|null;settlementPeriod:string|null},trade:Awaited<ReturnType<VolatilityReferenceRetrieval["ivTrades"]>>[number]):RawIvTradeCandidate{return{instrumentName:meta.instrumentName,tradeId:trade.tradeId,tradeSeq:trade.tradeSeq,strike:meta.strike,optionType:meta.optionType,expiryTimestampMs:meta.expiryTimestampMs,settlementPeriod:meta.settlementPeriod,contractCreatedAtMs:meta.createdAtMs,timestampMs:trade.timestampMs,ivApiPercent:trade.ivApiPercent,indexPrice:trade.indexPrice}}
function leg(trades:readonly RawIvTradeCandidate[],instrument:string|null,target:number):LegVolatilitySnapshot|null{const hit=trades.filter(x=>x.instrumentName===instrument&&x.timestampMs<=target&&target-x.timestampMs<=MARKET_IV_MAX_AGE_MINUTES*60_000&&n(x.ivApiPercent)!==null&&x.ivApiPercent!>0).sort((a,b)=>b.timestampMs-a.timestampMs)[0];return hit?{ivDecimal:hit.ivApiPercent!/100,ivApiPercent:hit.ivApiPercent,ivSource:"deribit_trade_iv",ivSourceTimestampMs:hit.timestampMs,observation:"observed"}:null}

/**
 * Populate missing market evidence before the synchronous bundle builder runs.
 * Failures are intentionally converted to unavailable metric states, never to a
 * missing event/candidate row. This is the production boundary between IO and
 * deterministic bundle assembly.
 */
export async function materializeVolatilityStates(store:ResearchSelectionStore,cacheRoot=VOLATILITY_CACHE_ROOT,deps:VolatilityMaterializationDependencies={}):Promise<ResearchVolatilityStates>{
 const retrieval=deps.retrieval??new VolatilityReferenceRetrieval(),populate=deps.populateMissing??true;
 const targets=store.events.map(event=>({event,entry:eventEntry(event)}));
 const validTargets=targets.filter((x):x is typeof x&{entry:number}=>x.entry!==null);
 let manifest:Awaited<ReturnType<VolatilityReferenceRetrieval["instrumentManifest"]>>=[];
 if(populate&&validTargets.length)try{manifest=await retrieval.instrumentManifest()}catch{/* explicit unavailable rows are built below */}

 const tapeByEvent=new Map<string,RawIvTradeCandidate[]>(),freshRows:ReferenceSeriesRow[]=[];
 for(const {event,entry} of validTargets){
  const underlying=sourceEntryPrice(event),windowStart=entry-MARKET_IV_MAX_AGE_MINUTES*60_000;
  const relevant=manifest.filter(m=>m.createdAtMs!==null&&m.createdAtMs<=entry&&m.expiryTimestampMs>entry&&((m.expiryTimestampMs-entry)/86_400_000<=38||Object.values(instrumentNamesForEvent(event)).includes(m.instrumentName)));
  const candidates:RawIvTradeCandidate[]=[];
  if(populate)await Promise.all(relevant.map(async m=>{try{for(const t of await retrieval.ivTrades(m.instrumentName,windowStart,entry))candidates.push(raw(m,t))}catch{/* missing tape remains unavailable */}}));
  tapeByEvent.set(event.eventId,candidates);
  if(underlying!==null){const byExpiry=new Map<number,ListedExpiry>();for(const m of relevant){const old=byExpiry.get(m.expiryTimestampMs);if(old)continue;byExpiry.set(m.expiryTimestampMs,{expiryTimestampMs:m.expiryTimestampMs,createdAtMs:m.createdAtMs,settlementPeriod:m.settlementPeriod,strikes:relevant.filter(x=>x.expiryTimestampMs===m.expiryTimestampMs).map(x=>x.strike)})}freshRows.push(...buildReferenceSeriesRows({timestampMs:entry,underlyingInstrument:"BTC-PERPETUAL",underlyingPrice:underlying,listedExpiries:[...byExpiry.values()],candidates,tenors:TENORS}).rows)}
 }
 if(freshRows.length)await writeReferenceShards({rows:freshRows,root:cacheRoot});

 // DVOL and RV are populated by their established venue-specific retrievals.
 if(populate)for(const {entry} of validTargets){try{await writeDvolShards({points:await retrieval.dvolRange(Math.max(DVOL_FIRST_AVAILABLE_MS,entry-HOUR_MS),entry),root:cacheRoot})}catch{/* unavailable */}}
 const shards=await listCachedShards(REFERENCE_SERIES_ID,cacheRoot),all:ReferenceSeriesRow[]=(await Promise.all(shards.map(x=>readReferenceShard(x,cacheRoot)))).flat();
 const dvolShards=await listCachedShards(DVOL_SERIES_ID,cacheRoot),dvol=(await Promise.all(dvolShards.map(x=>readDvolShard(x,cacheRoot)))).flat();
 const history:ReferenceObservation[]=all.filter(x=>x.passes_market_state_rule&&typeof x.reference_iv_decimal==="number").map(x=>({timestampMs:x.timestamp_ms,ivDecimal:x.reference_iv_decimal!,tenor:x.nominal_tenor,referenceSeriesId:REFERENCE_SERIES_ID}));
 const hash=referenceSeriesContentHash(all),events=[],structures=[];
 const bars=deps.perpetualBars??(async(start,end)=>{const service=new DeribitPerpetualHistoryService(OPTION_HISTORY_HOST);const result=await service.referenceSeries("BTC-PERPETUAL",start,end,60);return result.points.map(x=>({timestampMs:x.timestamp,close:x.close}))});
 for(const {event,entry} of targets){
  // A malformed source is diagnosed loudly rather than silently shrinking denominators.
  if(entry===null)throw new Error(`Volatility materialization cannot resolve canonical entry timing for event ${event.eventId}.`);
  const referenceRows=all.filter(x=>x.timestamp_ms===entry),percentiles=Object.fromEntries(TENORS.map(t=>[t,causalIvPercentile({subjectIvDecimal:referenceRows.find(x=>x.nominal_tenor===t)?.reference_iv_decimal??null,targetTimestampMs:entry,history,tenor:t,referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash})]));
  let rv={};if(populate||deps.perpetualBars)try{rv=realizedVolatilityProfile({bars:await bars(entry-31*86_400_000,entry),targetTimestampMs:entry})}catch{/* unavailable profile */}
  const broad=dvol.filter(x=>x.timestamp_ms<=entry&&entry-x.timestamp_ms<=HOUR_MS).sort((a,b)=>b.timestamp_ms-a.timestamp_ms)[0];
  const broadState:BroadVolatilityState|undefined=broad?{series_id:DVOL_SERIES_ID,method_version:DVOL_METHOD_VERSION,value_decimal:broad.dvol_decimal,observation_timestamp_utc:broad.timestamp_utc,age_minutes:(entry-broad.timestamp_ms)/60_000,status:"available",unavailable_reason:null,substitution_permitted:false}:undefined;
  events.push(buildEventVolatilityState({eventId:event.eventId,entryTimestampMs:entry,underlyingInstrument:"BTC-PERPETUAL",entryUnderlyingPrice:sourceEntryPrice(event),referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash,referenceRows,realizedVolatility:rv,percentiles,broadVolatility:broadState}));
  const tape=tapeByEvent.get(event.eventId)??[];
  for(const selected of event.selectedStructures){const c=o(selected.candidateSnapshot),expiry=n(c.expiryTimestamp),names=instrumentNames(selected),underlying=sourceEntryPrice(event);const listed=expiry===null?undefined:manifest.find(x=>x.expiryTimestampMs===expiry);const expiryReference=underlying===null||!listed?null:buildExpiryReferenceRow({timestampMs:entry,underlyingInstrument:"BTC-PERPETUAL",underlyingPrice:underlying,expiry:{expiryTimestampMs:listed.expiryTimestampMs,createdAtMs:listed.createdAtMs,settlementPeriod:listed.settlementPeriod,strikes:manifest.filter(x=>x.expiryTimestampMs===listed.expiryTimestampMs).map(x=>x.strike)},candidates:tape,excludedInstruments:[names.short,names.long].filter((x):x is string=>!!x)});
   structures.push(buildStructureVolatilityState({eventId:event.eventId,candidateId:selected.candidateId,entryTimestampMs:entry,actualExpiryTimestampMs:expiry,actualDteDays:expiry===null?null:(expiry-entry)/86_400_000,shortStrike:n(c.shortStrike),longStrike:n(c.longStrike),optionType:s(c.optionType),shortInstrument:names.short,longInstrument:names.long,referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash,shortLeg:leg(tape,names.short,entry),longLeg:leg(tape,names.long,entry),reference:expiryReference}));
  }
 }
 return{events,structures};
}
function instrumentNamesForEvent(event:ResearchSelectionStore["events"][number]){return event.selectedStructures.flatMap(x=>Object.values(instrumentNames(x)).filter((v):v is string=>!!v))}
