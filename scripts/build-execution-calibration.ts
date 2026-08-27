#!/usr/bin/env node
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {CrossSectionRetrieval,type InstrumentMeta} from "./cross-section-cache.ts";
import {OPTION_HISTORY_HOST,contentHash} from "../app/lib/volatility/reference-series.ts";
import {
  buildCalibrationObservation,CALIBRATION_EVIDENCE_CONTEXT_MINUTES,calibrationContentHash,
  calibrationRawShardId,calibrationTargets,EXECUTION_CALIBRATION_DATASET_ID,
  EXECUTION_CALIBRATION_METHOD_VERSION,type ExecutionCalibrationObservation,
} from "../app/lib/execution-calibration.ts";
import {dedupePrints,type RawOptionPrint} from "../app/lib/volatility/cross-section.ts";
import {REFERENCE_VALUATION_METHOD_VERSION} from "../app/lib/volatility/reference-hybrid.ts";

const DAY=86_400_000,MINUTE=60_000,ROOT=".local-cache/execution-calibration";
const DTE_MIN=1,DTE_MAX=46,ABS_LOG_MONEYNESS_MAX=.35;
const q=(xs:number[],p:number)=>xs.length?xs[Math.min(xs.length-1,Math.max(0,Math.ceil(p*xs.length)-1))]!:null;
const stats=(values:(number|null)[])=>{const x=values.filter((v):v is number=>v!==null&&Number.isFinite(v)).sort((a,b)=>a-b);const mean=x.length?x.reduce((a,b)=>a+b,0)/x.length:null;return{count:x.length,mean,median:q(x,.5),p10:q(x,.1),p25:q(x,.25),p50:q(x,.5),p75:q(x,.75),p90:q(x,.9),p95:q(x,.95),p99:q(x,.99),standard_deviation:mean===null?null:Math.sqrt(x.reduce((s,v)=>s+(v-mean)**2,0)/x.length),minimum:x[0]??null,maximum:x.at(-1)??null}};
const tally=(xs:readonly ExecutionCalibrationObservation[],key:(r:ExecutionCalibrationObservation)=>string)=>Object.fromEntries([...xs.reduce((m,r)=>m.set(key(r),(m.get(key(r))??0)+1),new Map<string,number>())].sort((a,b)=>b[1]-a[1]));

async function main(){
 const [startArg,endArg]=process.argv.slice(2);
 if(!startArg||!endArg)throw new Error("usage: build-execution-calibration.ts YYYY-MM-DD YYYY-MM-DD");
 const targetStart=Date.parse(`${startArg}T00:00:00Z`),targetEnd=Date.parse(`${endArg}T00:00:00Z`);
 if(!Number.isFinite(targetStart)||!Number.isFinite(targetEnd)||targetEnd<=targetStart)throw new Error("end is exclusive and must follow start");
 const evidenceStart=targetStart-CALIBRATION_EVIDENCE_CONTEXT_MINUTES*MINUTE;
 const rawId=calibrationRawShardId(targetStart,targetEnd,evidenceStart),base=join(ROOT,EXECUTION_CALIBRATION_DATASET_ID),rawPath=join(base,`${rawId}.raw.json`);
 let raw:RawOptionPrint[],instruments:InstrumentMeta[],retrievalHash:string,reused=false;
 try{
  const cached=JSON.parse(await readFile(rawPath,"utf8")) as {target_start_ms:number;target_end_exclusive_ms:number;evidence_start_ms:number;content_hash:string;prints:RawOptionPrint[];instruments:InstrumentMeta[];complete:boolean};
  if(cached.target_start_ms!==targetStart||cached.target_end_exclusive_ms!==targetEnd||cached.evidence_start_ms!==evidenceStart)throw new Error("raw cache identity mismatch");
  if(!cached.complete)throw new Error("cached source shard is explicitly incomplete");
  raw=cached.prints;instruments=cached.instruments;retrievalHash=cached.content_hash;reused=true;
 }catch(error){
  if(error instanceof Error&&(error.message.includes("explicitly incomplete")||error.message.includes("identity mismatch")))throw error;
  const retrieval=new CrossSectionRetrieval({host:OPTION_HISTORY_HOST});
  instruments=[...await retrieval.instrumentManifest()];raw=[...await retrieval.optionPrints(evidenceStart,targetEnd-1)];
  const complete=retrieval.incompleteLeafWindows.length===0;retrievalHash=contentHash({raw,instruments});
  await mkdir(base,{recursive:true});
  await writeFile(rawPath,JSON.stringify({dataset_id:EXECUTION_CALIBRATION_DATASET_ID,raw_source_id:rawId,target_start_ms:targetStart,target_end_exclusive_ms:targetEnd,evidence_start_ms:evidenceStart,source_host:OPTION_HISTORY_HOST,complete,incomplete_leaf_windows:retrieval.incompleteLeafWindows,content_hash:retrievalHash,instruments,prints:raw}));
  if(!complete)throw new Error("source window incomplete; cached for diagnosis but excluded from calibration");
 }
 const tape=[...dedupePrints(raw).prints].sort((a,b)=>a.timestampMs-b.timestampMs||String(a.tradeId).localeCompare(String(b.tradeId)));
 const targets=calibrationTargets(tape,targetStart,targetEnd).filter(t=>{const d=(t.expiryTimestampMs-t.timestampMs)/DAY,k=typeof t.indexPrice==="number"&&t.indexPrice>0?Math.log(t.strike/t.indexPrice):Infinity;return d>=DTE_MIN&&d<=DTE_MAX&&Math.abs(k)<=ABS_LOG_MONEYNESS_MAX});
 const byInstrument=new Map(instruments.map(meta=>[meta.instrumentName,meta]));
 const rows=targets.map(target=>{const meta=byInstrument.get(target.instrumentName);return buildCalibrationObservation({target,tape,sourceHost:OPTION_HISTORY_HOST,retrievalShardId:rawId,retrievalContentHash:retrievalHash,sourceWindowComplete:true,contractSize:meta?.contractSize??null,minimumTradeAmount:meta?.minimumTradeAmount??null,directionSemanticsVerified:true})});
 const hash=calibrationContentHash(rows),obsPath=join(base,`${rawId}.${hash}.observations.jsonl`);await writeFile(obsPath,rows.map(r=>JSON.stringify(r)).join("\n")+"\n");
 const primary=rows.filter(r=>r.primary_fair_eligible),taker=rows.filter(r=>r.taker_concession_eligible);
 const audit={scope:{target_start_utc:new Date(targetStart).toISOString(),target_end_exclusive_utc:new Date(targetEnd).toISOString(),evidence_start_utc:new Date(evidenceStart).toISOString(),raw_retrieved:raw.length,deduplicated:tape.length,calibration_targets:rows.length,primary_fair_available:primary.length,taker_concession_eligible:taker.length,unique_instruments:new Set(rows.map(r=>r.instrument_name)).size,unique_expiries:new Set(rows.map(r=>r.expiry_timestamp_ms)).size,calendar_days:new Set(rows.map(r=>r.features.calendar_date)).size,calendar_weeks:new Set(rows.map(r=>r.features.calendar_week)).size,expiry_date_groups:new Set(rows.map(r=>r.features.expiry_date_group_id)).size,cache_reused:reused},status:tally(rows,r=>r.status),option_type:tally(rows,r=>r.option_type),direction:tally(rows,r=>r.direction??"unknown"),residuals:{signed_iv_decimal:stats(primary.map(r=>r.signed_iv_residual_decimal)),adverse_iv_vol_points:stats(taker.map(r=>r.adverse_iv_concession_vol_points)),adverse_price_btc:stats(taker.map(r=>r.adverse_price_concession_btc)),independent_fair_minus_mark_btc:stats(primary.map(r=>r.mark_price_btc===null||r.primary_fair_price_btc===null?null:r.primary_fair_price_btc-r.mark_price_btc))}};
 const manifest={dataset_id:EXECUTION_CALIBRATION_DATASET_ID,dataset_content_hash:hash,method_version:EXECUTION_CALIBRATION_METHOD_VERSION,fair_value_method_version:REFERENCE_VALUATION_METHOD_VERSION,source_host:OPTION_HISTORY_HOST,generated_at_utc:new Date().toISOString(),raw_source:{id:rawId,file:rawPath,content_hash:retrievalHash,target_start_utc:new Date(targetStart).toISOString(),target_end_exclusive_utc:new Date(targetEnd).toISOString(),evidence_start_utc:new Date(evidenceStart).toISOString()},source_complete:true,filter_configuration:{currency:"BTC",kind:"option",dte_days:[DTE_MIN,DTE_MAX],absolute_log_moneyness_max:ABS_LOG_MONEYNESS_MAX,residual_based_sampling:false},shards:[{id:rawId,raw_content_hash:retrievalHash,observation_content_hash:hash,row_count:rows.length,file:obsPath}],audit};
 const manifestPath=join(base,`manifest.${rawId}.${hash}.json`);try{await readFile(manifestPath,"utf8")}catch{await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n")};console.log(JSON.stringify(manifest,null,2));
}
await main();
