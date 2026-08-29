import type {ResearchSelectionStore} from "../app/lib/research-selections.ts";
import type {ResearchVolatilityStates} from "../app/lib/research-bundle.ts";
import {legVolatility} from "../app/lib/research-tracks.ts";
import {buildEventVolatilityState,buildStructureVolatilityState} from "../app/lib/volatility/volatility-state.ts";
import {REFERENCE_SERIES_ID,referenceSeriesContentHash,type ReferenceSeriesRow} from "../app/lib/volatility/reference-series.ts";
import {causalIvPercentile,type ReferenceObservation} from "../app/lib/volatility/iv-percentile.ts";
import {listCachedShards,readReferenceShard,VOLATILITY_CACHE_ROOT} from "./volatility-reference-cache.ts";
type R=Record<string,unknown>;const o=(v:unknown):R=>v&&typeof v==="object"&&!Array.isArray(v)?v as R:{};const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:null;

/** Asynchronous, cache-backed upstream materialization for synchronous bundle assembly. */
export async function materializeVolatilityStates(store:ResearchSelectionStore,cacheRoot=VOLATILITY_CACHE_ROOT):Promise<ResearchVolatilityStates>{
 const shards=await listCachedShards(REFERENCE_SERIES_ID,cacheRoot),all:ReferenceSeriesRow[]=(await Promise.all(shards.map(x=>readReferenceShard(x,cacheRoot)))).flat();
 const history:ReferenceObservation[]=all.filter(x=>x.passes_market_state_rule&&typeof x.reference_iv_decimal==="number").map(x=>({timestampMs:x.timestamp_ms,ivDecimal:x.reference_iv_decimal!,tenor:x.nominal_tenor,referenceSeriesId:REFERENCE_SERIES_ID}));
 const hash=referenceSeriesContentHash(all),events=[],structures=[];
 for(const event of store.events){const source=o(o(event.sourceRun).event),entry=n(source.entryTimestamp);if(entry===null)continue;const referenceRows=all.filter(x=>x.timestamp_ms===entry),percentiles=Object.fromEntries((["7d","14d","30d"] as const).map(t=>[t,causalIvPercentile({subjectIvDecimal:referenceRows.find(x=>x.nominal_tenor===t)?.reference_iv_decimal??null,targetTimestampMs:entry,history,tenor:t,referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash})]));
  events.push(buildEventVolatilityState({eventId:event.eventId,entryTimestampMs:entry,underlyingInstrument:"BTC-PERPETUAL",entryUnderlyingPrice:n(source.entryPrice),referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash,referenceRows,realizedVolatility:{},percentiles}));
  for(const selected of event.selectedStructures){const c=o(selected.candidateSnapshot),ref=o(selected.referenceValuation),e=o(ref.entrySnapshot),sold=o(e.sold),bought=o(e.bought),expiry=n(c.expiryTimestamp),instruments=o(c.instruments),expiryIso=expiry===null?null:new Date(expiry).toISOString();
   // A nominal reference is not silently relabeled same-expiry; subject-leg
   // exclusion must already be explicit in the authoritative cache row.
   const exact=referenceRows.find(x=>x.reference_expiry_timestamp_utc===expiryIso&&x.own_legs_excluded===true)??null;
   structures.push(buildStructureVolatilityState({eventId:event.eventId,candidateId:selected.candidateId,entryTimestampMs:entry,actualExpiryTimestampMs:expiry,actualDteDays:expiry===null?null:(expiry-entry)/86400000,shortStrike:n(c.shortStrike),longStrike:n(c.longStrike),optionType:typeof c.optionType==="string"?c.optionType:null,shortInstrument:typeof instruments.short==="string"?instruments.short:null,longInstrument:typeof instruments.long==="string"?instruments.long:null,referenceSeriesId:REFERENCE_SERIES_ID,referenceSeriesContentHash:hash,shortLeg:legVolatility(sold,e.shortIvDecimal,e.soldIvSource),longLeg:legVolatility(bought,e.longIvDecimal,e.longIvSource),reference:exact}));
  }
 }
 return{events,structures};
}
