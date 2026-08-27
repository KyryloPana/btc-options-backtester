import {mkdir,readFile,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {tradeIdentityKey,type RawOptionPrint} from "../app/lib/volatility/cross-section.ts";
import {contentHash} from "../app/lib/volatility/reference-series.ts";
import {EXECUTION_CALIBRATION_DATASET_ID,EXECUTION_CALIBRATION_METHOD_VERSION} from "../app/lib/execution-calibration.ts";
import type {InstrumentMeta} from "./cross-section-cache.ts";

export interface RawCalibrationShard {dataset_id:string;method_version:string;raw_source_id:string;target_start_ms:number;target_end_exclusive_ms:number;evidence_start_ms:number;source_host:string;complete:boolean;incomplete_leaf_windows:readonly unknown[];content_hash:string;instruments:InstrumentMeta[];prints:RawOptionPrint[];retrieved_at_utc:string}
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
 try{const cached=JSON.parse(await readFile(input.path,"utf8")) as RawCalibrationShard;if(cached.method_version===EXECUTION_CALIBRATION_METHOD_VERSION&&cached.raw_source_id===input.rawSourceId&&cached.target_start_ms===input.targetStartMs&&cached.target_end_exclusive_ms===input.targetEndExclusiveMs&&cached.evidence_start_ms===input.evidenceStartMs&&cached.complete)return{shard:cached,cacheReused:true}}catch{}
 const retrieved=await input.retrieve(),identity=rawCalibrationContentIdentity(retrieved.prints,retrieved.instruments);
 const shard:RawCalibrationShard={dataset_id:EXECUTION_CALIBRATION_DATASET_ID,method_version:EXECUTION_CALIBRATION_METHOD_VERSION,raw_source_id:input.rawSourceId,target_start_ms:input.targetStartMs,target_end_exclusive_ms:input.targetEndExclusiveMs,evidence_start_ms:input.evidenceStartMs,source_host:input.sourceHost,complete:retrieved.complete,incomplete_leaf_windows:retrieved.incompleteLeafWindows,content_hash:identity.contentHash,instruments:identity.instruments,prints:identity.prints,retrieved_at_utc:(input.retrievedAtUtc??(()=>new Date().toISOString()))()};
 await mkdir(dirname(input.path),{recursive:true});await writeFile(input.path,JSON.stringify(shard));
 if(!shard.complete)throw new IncompleteCalibrationSourceError();
 return{shard,cacheReused:false};
}
