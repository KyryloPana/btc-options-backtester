import {mkdir,readFile,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {tradeIdentityKey,type RawOptionPrint} from "../app/lib/volatility/cross-section.ts";
import {contentHash} from "../app/lib/volatility/reference-series.ts";
import {EXECUTION_CALIBRATION_DATASET_ID,EXECUTION_CALIBRATION_METHOD_VERSION} from "../app/lib/execution-calibration.ts";
import type {InstrumentMeta} from "./cross-section-cache.ts";

/**
 * Schema identity of the RAW Deribit trade shard.
 *
 * Deliberately separate from EXECUTION_CALIBRATION_METHOD_VERSION. The raw
 * shard holds nothing but retrieved exchange prints and the metadata of the
 * instruments those prints reference -- it is methodology-neutral. Every change
 * from v3 to v4 (causal expiry forwards, forward moneyness) happens in DERIVED
 * computation over these same bytes, so keying raw reuse on the derived method
 * version would force a full historical redownload for no new field.
 *
 * Bump this ONLY when the retrieved payload itself must change shape.
 */
export const RAW_CALIBRATION_SCHEMA_VERSION="deribit-option-trade-raw-v1" as const;

/** Fields every v4 derivation reads off a raw print, including forward inversion. */
const REQUIRED_PRINT_FIELDS=["instrumentName","timestampMs","expiryTimestampMs","strike","optionType"] as const;

/**
 * A cached raw shard is reusable only if it genuinely carries what v4 needs.
 * v3 shards predate `raw_schema_version`, so they are accepted on field
 * evidence rather than on a version string they could not have written.
 */
export function rawShardSupportsCurrentMethodology(shard:Partial<RawCalibrationShard>):{ok:true}|{ok:false;reason:string}{
 if(!Array.isArray(shard.prints)||!Array.isArray(shard.instruments))return{ok:false,reason:"missing_prints_or_instruments"};
 if(shard.raw_schema_version!==undefined&&shard.raw_schema_version!==RAW_CALIBRATION_SCHEMA_VERSION)
  return{ok:false,reason:`raw_schema_version ${String(shard.raw_schema_version)} is not ${RAW_CALIBRATION_SCHEMA_VERSION}`};
 for(const print of shard.prints as RawOptionPrint[]){
  for(const field of REQUIRED_PRINT_FIELDS)if((print as unknown as Record<string,unknown>)[field]===undefined)return{ok:false,reason:`print missing ${field}`};
  // Forward inversion needs a premium, an IV and an index on the evidence it
  // actually uses. Individual prints may legitimately lack them (they are then
  // rejected as forward evidence), so absence of the KEY is the defect, not a
  // null value.
  for(const field of ["price","ivApiPercent","indexPrice"])if(!(field in (print as unknown as Record<string,unknown>)))return{ok:false,reason:`print missing ${field}`};
 }
 return{ok:true};
}

export interface RawCalibrationShard {dataset_id:string;method_version:string;raw_schema_version?:string;raw_source_id:string;target_start_ms:number;target_end_exclusive_ms:number;evidence_start_ms:number;source_host:string;complete:boolean;incomplete_leaf_windows:readonly unknown[];content_hash:string;instruments:InstrumentMeta[];prints:RawOptionPrint[];retrieved_at_utc:string}
export interface RetrievedCalibrationSource {prints:RawOptionPrint[];instruments:InstrumentMeta[];complete:boolean;incompleteLeafWindows:readonly unknown[]}

const canonicalPrints=(prints:readonly RawOptionPrint[])=>[...prints].sort((a,b)=>tradeIdentityKey(a).localeCompare(tradeIdentityKey(b))||JSON.stringify(a).localeCompare(JSON.stringify(b))).map(print=>({...print}));
const canonicalMeta=(meta:InstrumentMeta)=>({instrumentName:meta.instrumentName,strike:meta.strike,optionType:meta.optionType,expiryTimestampMs:meta.expiryTimestampMs,createdAtMs:meta.createdAtMs,settlementPeriod:meta.settlementPeriod,contractSize:meta.contractSize,minimumTradeAmount:meta.minimumTradeAmount});

/** Historical content identity: canonical prints plus metadata for referenced instruments only. */
export function rawCalibrationContentIdentity(prints:readonly RawOptionPrint[],manifest:readonly InstrumentMeta[]):{contentHash:string;prints:RawOptionPrint[];instruments:InstrumentMeta[]}{
 const normalizedPrints=canonicalPrints(prints),referenced=new Set(normalizedPrints.map(print=>print.instrumentName));
 const candidates=manifest.filter(meta=>referenced.has(meta.instrumentName)).sort((a,b)=>a.instrumentName.localeCompare(b.instrumentName)||JSON.stringify(canonicalMeta(a)).localeCompare(JSON.stringify(canonicalMeta(b)))),byName=new Map<string,InstrumentMeta>();
 for(const meta of candidates){const prior=byName.get(meta.instrumentName);if(prior&&JSON.stringify(canonicalMeta(prior))!==JSON.stringify(canonicalMeta(meta)))throw new Error(`conflicting metadata for referenced instrument ${meta.instrumentName}`);byName.set(meta.instrumentName,{...meta})}
 const instruments=[...byName.values()];
 return{contentHash:contentHash({prints:normalizedPrints,instruments:instruments.map(canonicalMeta)}),prints:normalizedPrints,instruments};
}

export class IncompleteCalibrationSourceError extends Error{constructor(){super("source window incomplete; cached for diagnosis but excluded from calibration")}}

export async function loadOrRetrieveRawCalibrationShard(input:{path:string;rawSourceId:string;targetStartMs:number;targetEndExclusiveMs:number;evidenceStartMs:number;sourceHost:string;retrieve:()=>Promise<RetrievedCalibrationSource>;retrievedAtUtc?:()=>string}):Promise<{shard:RawCalibrationShard;cacheReused:boolean}>{
 // Reuse is gated on the RAW schema and the retrieval interval, never on the
 // derived method version: regenerating v3 observations as v4 must not
 // redownload historical bytes that did not change. An incomplete shard still
 // falls through to a refetch, so the cache remains self-healing.
 try{const cached=JSON.parse(await readFile(input.path,"utf8")) as RawCalibrationShard;
  const supported=rawShardSupportsCurrentMethodology(cached);
  if(supported.ok&&cached.raw_source_id===input.rawSourceId&&cached.target_start_ms===input.targetStartMs&&cached.target_end_exclusive_ms===input.targetEndExclusiveMs&&cached.evidence_start_ms===input.evidenceStartMs&&cached.complete){
   // Identity is recomputed from the cached bytes rather than trusted from the
   // file. A shard written before referenced-instrument-only hashing carries a
   // hash contaminated by the whole listing manifest; reusing its bytes must
   // not reuse that hash, or dataset identity would depend on when the cache
   // happened to be filled.
   const identity=rawCalibrationContentIdentity(cached.prints,cached.instruments);
   return{shard:{...cached,raw_schema_version:RAW_CALIBRATION_SCHEMA_VERSION,content_hash:identity.contentHash,prints:identity.prints,instruments:identity.instruments},cacheReused:true}}}catch{}
 const retrieved=await input.retrieve(),identity=rawCalibrationContentIdentity(retrieved.prints,retrieved.instruments);
 const shard:RawCalibrationShard={dataset_id:EXECUTION_CALIBRATION_DATASET_ID,method_version:EXECUTION_CALIBRATION_METHOD_VERSION,raw_schema_version:RAW_CALIBRATION_SCHEMA_VERSION,raw_source_id:input.rawSourceId,target_start_ms:input.targetStartMs,target_end_exclusive_ms:input.targetEndExclusiveMs,evidence_start_ms:input.evidenceStartMs,source_host:input.sourceHost,complete:retrieved.complete,incomplete_leaf_windows:retrieved.incompleteLeafWindows,content_hash:identity.contentHash,instruments:identity.instruments,prints:identity.prints,retrieved_at_utc:(input.retrievedAtUtc??(()=>new Date().toISOString()))()};
 await mkdir(dirname(input.path),{recursive:true});await writeFile(input.path,JSON.stringify(shard));
 if(!shard.complete)throw new IncompleteCalibrationSourceError();
 return{shard,cacheReused:false};
}
