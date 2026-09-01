#!/usr/bin/env node
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {OPTION_HISTORY_HOST} from "../app/lib/volatility/reference-series.ts";
import type {DvolPoint} from "../app/lib/volatility/reference-series.ts";
import type {HourlyClose} from "../app/lib/volatility/realized-volatility.ts";
import {DeribitPerpetualHistoryService,PERPETUAL_REFERENCE_SOURCE,PERPETUAL_RETRIEVAL_VERSION} from "./deribit-perpetual-history.ts";
import {LOCAL_ARCHIVE_SOURCE,type ArchiveManifest} from "./local-contract-archive.ts";
import {LOCAL_AUX_DIRECTORY,LOCAL_DVOL_STORE,LOCAL_INSTRUMENT_MANIFEST,LOCAL_OPTION_TAPE_DIRECTORY,LOCAL_PERPETUAL_STORE,LOCAL_SOURCE_MANIFEST,localDataRoot,type LocalSeriesStore} from "./local-volatility-retrieval.ts";
import {VOLATILITY_RETRIEVAL_VERSION,VolatilityReferenceRetrieval,hourlyClosesFromPerpetualSeries} from "./volatility-reference-cache.ts";

const HOUR=3_600_000,CHUNK=28*86_400_000;
function args(values:string[]){const out:Record<string,string>={};for(let i=0;i<values.length;i++){const key=values[i];if(key?.startsWith("--")){const value=values[++i];if(!value||value.startsWith("--"))throw new Error(`${key} requires a value`);out[key.slice(2)]=value}}return out}
async function existing<T>(path:string):Promise<T|null>{try{return JSON.parse(await readFile(path,"utf8")) as T}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error}}
const coverage=<T>(rows:T[],timestamp:(x:T)=>number)=>({coverageStartMs:rows.length?timestamp(rows[0]!):null,coverageEndMs:rows.length?timestamp(rows.at(-1)!):null});
function merge<T>(before:T[],incoming:T[],timestamp:(x:T)=>number){const rows=new Map(before.map(x=>[timestamp(x),x]));for(const row of incoming)rows.set(timestamp(row),row);return [...rows.values()].sort((a,b)=>timestamp(a)-timestamp(b))}
function missingRanges<T>(store:LocalSeriesStore<T>|null,start:number,end:number){if(!store||store.coverageStartMs===null||store.coverageEndMs===null)return[[start,end]] as const;const ranges:[number,number][]=[];if(start<store.coverageStartMs)ranges.push([start,Math.min(end,store.coverageStartMs-HOUR)]);if(end>store.coverageEndMs)ranges.push([Math.max(start,store.coverageEndMs+HOUR),end]);return ranges}
async function writeStore<T>(path:string,source:string,method:string,prior:LocalSeriesStore<T>|null,incoming:T[],timestamp:(x:T)=>number){const rows=merge(prior?.rows??[],incoming,timestamp),span=coverage(rows,timestamp),store:LocalSeriesStore<T>={source,method,...span,rows};await writeFile(path,JSON.stringify(store,null,2)+"\n");return store}

export async function prepareLocalVolatilityData(input:{root?:string;startMs:number;endMs:number}){
 if(!Number.isFinite(input.startMs)||!Number.isFinite(input.endMs)||input.endMs<input.startMs)throw new Error("--start and --end must define a valid interval");
 const root=localDataRoot(input.root),tape=join(root,LOCAL_OPTION_TAPE_DIRECTORY),aux=join(root,LOCAL_AUX_DIRECTORY);await mkdir(aux,{recursive:true});
 const archivePath=join(tape,"archive-manifest.json"),archive=await existing<ArchiveManifest>(archivePath);if(!archive||archive.source!==LOCAL_ARCHIVE_SOURCE||!archive.data_content_fingerprint)throw new Error(`Indexed option archive is missing or invalid: ${archivePath}. Run index-local-contract-archive first. Option history will not be downloaded.`);
 console.error("Network: updating Deribit instrument metadata, BTC-PERPETUAL 1h bars, and DVOL hourly data only. Option trades remain local-only.");
 const retrieval=new VolatilityReferenceRetrieval(),instruments=await retrieval.instrumentManifest(true);if(instruments.some(x=>x.createdAtMs===null))throw new Error("Deribit instrument response omitted creation_timestamp; refusing to infer it from trades.");await writeFile(join(aux,LOCAL_INSTRUMENT_MANIFEST),JSON.stringify(instruments,null,2)+"\n");
 const perpetualPath=join(aux,LOCAL_PERPETUAL_STORE),oldPerpetual=await existing<LocalSeriesStore<HourlyClose>>(perpetualPath),perpetualService=new DeribitPerpetualHistoryService(OPTION_HISTORY_HOST),newBars:HourlyClose[]=[];
 for(const range of missingRanges(oldPerpetual,input.startMs,input.endMs))for(let start=range[0];start<=range[1];start+=CHUNK+HOUR){const end=Math.min(range[1],start+CHUNK);newBars.push(...hourlyClosesFromPerpetualSeries((await perpetualService.referenceSeries("BTC-PERPETUAL",start,end,60)).points))}
 const perpetual=await writeStore(perpetualPath,PERPETUAL_REFERENCE_SOURCE,PERPETUAL_RETRIEVAL_VERSION,oldPerpetual,newBars,x=>x.timestampMs);
 const dvolPath=join(aux,LOCAL_DVOL_STORE),oldDvol=await existing<LocalSeriesStore<DvolPoint>>(dvolPath),newDvol:DvolPoint[]=[];for(const range of missingRanges(oldDvol,input.startMs,input.endMs))for(let start=range[0];start<=range[1];start+=CHUNK+HOUR)newDvol.push(...await retrieval.dvolRange(start,Math.min(range[1],start+CHUNK)));
 const dvol=await writeStore(dvolPath,"deribit-volatility-index","get_volatility_index_data:BTC:3600",oldDvol,newDvol,x=>x.timestampMs);
 const sourceManifest={generatedAtUtc:new Date().toISOString(),archive:{source:archive.source,fingerprint:archive.data_content_fingerprint,coverageStart:archive.coverage_start,coverageEnd:archive.coverage_end,acceptedRows:archive.accepted_rows},instrumentManifest:{rows:instruments.length,source:"get_instruments:BTC:option:expired=true+false",method:VOLATILITY_RETRIEVAL_VERSION},auxiliary:{btcPerpetual:{source:perpetual.source,method:perpetual.method,coverageStartMs:perpetual.coverageStartMs,coverageEndMs:perpetual.coverageEndMs,rows:perpetual.rows.length},dvol:{source:dvol.source,method:dvol.method,coverageStartMs:dvol.coverageStartMs,coverageEndMs:dvol.coverageEndMs,rows:dvol.rows.length}},optionTradeNetworkRequests:0};
 await writeFile(join(aux,LOCAL_SOURCE_MANIFEST),JSON.stringify(sourceManifest,null,2)+"\n");return sourceManifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const options=args(process.argv.slice(2)),startMs=Date.parse(options.start??""),endMs=Date.parse(options.end??"");console.log(JSON.stringify(await prepareLocalVolatilityData({root:options["data-root"],startMs,endMs}),null,2))}
