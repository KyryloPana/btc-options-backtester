import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import type {RawOptionPrint} from "../app/lib/volatility/cross-section.ts";
import type {DvolPoint} from "../app/lib/volatility/reference-series.ts";
import type {HourlyClose} from "../app/lib/volatility/realized-volatility.ts";
import {LOCAL_ARCHIVE_MANIFEST,LOCAL_ARCHIVE_SOURCE,type ArchiveManifest} from "./local-contract-archive.ts";
import type {DeribitIvTradeRow,DeribitOptionInstrument} from "./volatility-reference-cache.ts";
import type {VolatilityMaterializationRetrieval} from "./materialize-volatility-states.ts";

export const LOCAL_DATA_ROOT_ENV="BTC_OPTIONS_LOCAL_DATA_ROOT" as const;
export const LOCAL_AUX_DIRECTORY="aux" as const;
export const LOCAL_OPTION_TAPE_DIRECTORY="options-tape" as const;
export const LOCAL_INSTRUMENT_MANIFEST="deribit-option-instruments.json" as const;
export const LOCAL_PERPETUAL_STORE="btc-perpetual-hourly.json" as const;
export const LOCAL_DVOL_STORE="dvol-hourly.json" as const;
export const LOCAL_SOURCE_MANIFEST="source-manifest.json" as const;

export interface LocalSeriesStore<T>{source:string;method:string;coverageStartMs:number|null;coverageEndMs:number|null;rows:T[]}
export interface LocalSourceManifest{generatedAtUtc:string;archive:{fingerprint:string};optionTradeNetworkRequests:number;[key:string]:unknown}
export function localDataRoot(explicit?:string){const root=explicit??process.env[LOCAL_DATA_ROOT_ENV];if(!root)throw new Error(`${LOCAL_DATA_ROOT_ENV} is required (the directory containing options-tape/ and aux/).`);return resolve(root)}
const actionable=(file:string,detail:string)=>new Error(`Local volatility data ${detail}: ${file}. Run npm run volatility:prepare-local-data -- --start <ISO> --end <ISO>.`);
async function json<T>(path:string,description:string):Promise<T>{try{return JSON.parse(await readFile(path,"utf8")) as T}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw actionable(path,`${description} is missing`);throw new Error(`Cannot read local volatility ${description} at ${path}: ${error instanceof Error?error.message:String(error)}`)}}
const day=(ms:number)=>new Date(ms).toISOString().slice(0,10),DAY=86_400_000;
const ordered=(a:RawOptionPrint,b:RawOptionPrint)=>a.timestampMs-b.timestampMs||a.instrumentName.localeCompare(b.instrumentName)||(a.tradeSeq??0)-(b.tradeSeq??0)||(a.tradeId??"").localeCompare(b.tradeId??"");
export function localPrintToIvTrade(row:RawOptionPrint):DeribitIvTradeRow{return{instrumentName:row.instrumentName,tradeId:row.tradeId,tradeSeq:row.tradeSeq,timestampMs:row.timestampMs,ivApiPercent:row.ivApiPercent,price:row.price,markPrice:row.markPrice,indexPrice:row.indexPrice,direction:row.direction,amount:row.amount}}

/** Network-free retrieval boundary over the canonical indexed RawOptionPrint tape. */
export class LocalVolatilityRetrieval implements VolatilityMaterializationRetrieval{
 readonly requestCount=0;public localDayShardReads=0;public localRowsScanned=0;
 readonly root:string;readonly tapeRoot:string;readonly auxRoot:string;
 private readonly days=new Map<string,Promise<RawOptionPrint[]>>();private archive?:Promise<ArchiveManifest>;private instruments?:Promise<DeribitOptionInstrument[]>;private dvol?:Promise<LocalSeriesStore<DvolPoint>>;
 constructor(root?:string){this.root=localDataRoot(root);this.tapeRoot=join(this.root,LOCAL_OPTION_TAPE_DIRECTORY);this.auxRoot=join(this.root,LOCAL_AUX_DIRECTORY)}
 archiveManifest(){return this.archive??=json<ArchiveManifest>(join(this.tapeRoot,LOCAL_ARCHIVE_MANIFEST),"option archive manifest").then(x=>{if(x.source!==LOCAL_ARCHIVE_SOURCE||!x.data_content_fingerprint)throw actionable(join(this.tapeRoot,LOCAL_ARCHIVE_MANIFEST),"manifest is invalid");return x})}
 async sourceManifest(){const path=join(this.auxRoot,LOCAL_SOURCE_MANIFEST),source=await json<LocalSourceManifest>(path,"source manifest"),archive=await this.archiveManifest();if(source.archive?.fingerprint!==archive.data_content_fingerprint)throw actionable(path,"archive fingerprint does not match the indexed option tape");return source}
 instrumentManifest(){return this.instruments??=json<DeribitOptionInstrument[]>(join(this.auxRoot,LOCAL_INSTRUMENT_MANIFEST),"instrument manifest").then(rows=>{if(!Array.isArray(rows)||rows.some(x=>x.createdAtMs===null||!Number.isFinite(x.createdAtMs)))throw actionable(join(this.auxRoot,LOCAL_INSTRUMENT_MANIFEST),"does not contain genuine creation timestamps");return rows})}
 private loadDay(date:string){let hit=this.days.get(date);if(!hit){this.localDayShardReads++;hit=readFile(join(this.tapeRoot,`${date}.jsonl`),"utf8").then(text=>text.split("\n").filter(Boolean).map(line=>JSON.parse(line) as RawOptionPrint)).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error});this.days.set(date,hit)}return hit}
 private async trades(start:number,end:number,name?:string){if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error("A valid local option trade interval is required.");await this.archiveManifest();const dates:string[]=[];for(let cursor=Date.parse(`${day(start)}T00:00:00Z`);cursor<=end;cursor+=DAY)dates.push(day(cursor));const shards=await Promise.all(dates.map(x=>this.loadDay(x))),rows=shards.flat();this.localRowsScanned+=rows.length;return rows.filter(x=>x.timestampMs>=start&&x.timestampMs<=end&&(!name||x.instrumentName===name)).sort(ordered).map(localPrintToIvTrade)}
 ivTrades(name:string,start:number,end:number){return this.trades(start,end,name)}
 ivTradesByCurrency(start:number,end:number){return this.trades(start,end)}
 async dvolRange(start:number,end:number){const path=join(this.auxRoot,LOCAL_DVOL_STORE),store=await(this.dvol??=json<LocalSeriesStore<DvolPoint>>(path,"DVOL store"));if(store.coverageStartMs===null||store.coverageEndMs===null||start<store.coverageStartMs||end>store.coverageEndMs)throw actionable(path,`DVOL coverage does not include [${new Date(start).toISOString()}, ${new Date(end).toISOString()}]`);return store.rows.filter(x=>x.timestampMs>=start&&x.timestampMs<=end).sort((a,b)=>a.timestampMs-b.timestampMs)}
 async perpetualBars(start:number,end:number):Promise<HourlyClose[]>{const path=join(this.auxRoot,LOCAL_PERPETUAL_STORE),store=await json<LocalSeriesStore<HourlyClose>>(path,"BTC-PERPETUAL store");if(store.coverageStartMs===null||store.coverageEndMs===null||start<store.coverageStartMs||end>store.coverageEndMs)throw actionable(path,`BTC-PERPETUAL coverage does not include [${new Date(start).toISOString()}, ${new Date(end).toISOString()}]`);return store.rows.filter(x=>x.timestampMs>=start&&x.timestampMs<=end).sort((a,b)=>a.timestampMs-b.timestampMs)}
}
