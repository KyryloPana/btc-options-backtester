import {createHash} from "node:crypto";
import {createReadStream,createWriteStream} from "node:fs";
import {mkdir,opendir,readFile,rm,writeFile} from "node:fs/promises";
import {basename,join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {once} from "node:events";
import {parseInstrumentName} from "../app/lib/backtester.ts";
import {tradeIdentityKey,type RawOptionPrint} from "../app/lib/volatility/cross-section.ts";

export const LOCAL_ARCHIVE_SOURCE="local-deribit-contract-archive" as const;
export const LOCAL_ARCHIVE_MANIFEST="archive-manifest.json" as const;
const DAY=86_400_000,BUCKETS=64;
const finite=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:null;

export function parseLocalContractRow(value:unknown,fallbackName?:string):RawOptionPrint|null{
 if(!value||typeof value!=="object")return null;const row=value as Record<string,unknown>;
 const instrumentName=String(row.instrument_name??fallbackName??"").toUpperCase();
 const parsed=parseInstrumentName(instrumentName),timestampMs=finite(row.timestamp),price=finite(row.price),amount=finite(row.amount),indexPrice=finite(row.index_price);
 const direction=row.direction==="buy"||row.direction==="sell"?row.direction:null;
 if(!parsed||timestampMs===null||timestampMs<=0||price===null||price<0||amount===null||amount<0||indexPrice===null||indexPrice<=0||direction===null)return null;
 const tradeSeq=finite(row.trade_seq),tickDirection=finite(row.tick_direction),iv=finite(row.iv),mark=finite(row.mark_price);
 return{instrumentName,timestampMs,strike:parsed.strike,optionType:parsed.optionType,expiryTimestampMs:parsed.expiryTimestamp,contractCreatedAtMs:null,settlementPeriod:null,tradeId:row.trade_id===undefined||row.trade_id===null||row.trade_id===""?null:String(row.trade_id),tradeSeq,price,markPrice:mark,ivApiPercent:iv,indexPrice,amount,direction,tickDirection};
}
const canonical=(row:RawOptionPrint)=>JSON.stringify(row);
const day=(ms:number)=>new Date(ms).toISOString().slice(0,10);
async function* files(root:string):AsyncGenerator<string>{const dir=await opendir(root);for await(const entry of dir){const path=join(root,entry.name);if(entry.isDirectory())yield*files(path);else if(entry.isFile()&&entry.name.toLowerCase().endsWith(".jsonl"))yield path}}
async function write(stream:ReturnType<typeof createWriteStream>,text:string){if(!stream.write(text))await once(stream,"drain")}
async function close(stream:ReturnType<typeof createWriteStream>){stream.end();await once(stream,"close")}
export interface ArchiveManifest{source:string;files_scanned:number;files_successfully_parsed:number;malformed_files:number;malformed_rows:number;raw_trade_rows:number;accepted_rows:number;duplicate_rows:number;conflicting_duplicates:number;unique_instruments:number;coverage_start:string|null;coverage_end:string|null;unique_calendar_days:number;buy_count:number;sell_count:number;rows_with_iv:number;rows_with_mark_price:number;rows_with_index_price:number;rows_with_amount:number;rows_with_trade_id:number;data_content_fingerprint:string;coverage_by_year:Record<string,number>}

/** Two bounded passes: identity buckets detect global duplicates, then day shards sort locally. */
export async function indexLocalContractArchive(inputRoot:string,outputRoot:string):Promise<ArchiveManifest>{
 if(resolve(inputRoot)===resolve(outputRoot))throw new Error("input and output directories must differ");await rm(outputRoot,{recursive:true,force:true});await mkdir(outputRoot,{recursive:true});const work=join(outputRoot,".indexing");await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});
 const bucketStreams=Array.from({length:BUCKETS},(_,i)=>createWriteStream(join(work,`bucket-${i}.jsonl`)));
 let filesScanned=0,filesParsed=0,malformedFiles=0,malformedRows=0,rawRows=0;
 for await(const path of files(inputRoot)){filesScanned++;let bad=false,opened=false;try{const rl=createInterface({input:createReadStream(path),crlfDelay:Infinity});opened=true;for await(const line of rl){if(!line.trim())continue;rawRows++;let value:unknown;try{value=JSON.parse(line)}catch{malformedRows++;bad=true;continue}const row=parseLocalContractRow(value,basename(path,".jsonl"));if(!row){malformedRows++;bad=true;continue}const bucket=parseInt(createHash("sha256").update(tradeIdentityKey(row)).digest("hex").slice(0,8),16)%BUCKETS;await write(bucketStreams[bucket]!,canonical(row)+"\n")}}catch{bad=true}if(opened&&!bad)filesParsed++;else if(bad)malformedFiles++}
 await Promise.all(bucketStreams.map(close));
 const dayStreams=new Map<string,ReturnType<typeof createWriteStream>>();let accepted=0,duplicates=0,conflicts=0;
 for(let i=0;i<BUCKETS;i++){const seen=new Map<string,string>(),rl=createInterface({input:createReadStream(join(work,`bucket-${i}.jsonl`)),crlfDelay:Infinity});for await(const line of rl){const row=JSON.parse(line) as RawOptionPrint,key=tradeIdentityKey(row),body=canonical(row),prior=seen.get(key);if(prior!==undefined){if(prior===body)duplicates++;else conflicts++;continue}seen.set(key,body);accepted++;const d=day(row.timestampMs);let stream=dayStreams.get(d);if(!stream){stream=createWriteStream(join(work,`day-${d}.jsonl`));dayStreams.set(d,stream)}await write(stream,body+"\n")}}
 await Promise.all([...dayStreams.values()].map(close));
 const instruments=new Set<string>(),years:Record<string,number>={};let buy=0,sell=0,withIv=0,withMark=0,withIndex=0,withAmount=0,withId=0,start=Infinity,end=-Infinity;
 const dates=[...dayStreams.keys()].sort(),hash=createHash("sha256");
 for(const d of dates){const text=await readFile(join(work,`day-${d}.jsonl`),"utf8"),rows=text.trim().split("\n").filter(Boolean).map(x=>JSON.parse(x) as RawOptionPrint).sort((a,b)=>a.timestampMs-b.timestampMs||tradeIdentityKey(a).localeCompare(tradeIdentityKey(b)));const out=rows.map(canonical).join("\n")+(rows.length?"\n":"");await writeFile(join(outputRoot,`${d}.jsonl`),out);hash.update(d+"\n"+out);for(const r of rows){instruments.add(r.instrumentName);start=Math.min(start,r.timestampMs);end=Math.max(end,r.timestampMs);years[d.slice(0,4)]=(years[d.slice(0,4)]??0)+1;if(r.direction==="buy")buy++;else sell++;if(r.ivApiPercent!=null)withIv++;if(r.markPrice!=null)withMark++;if(r.indexPrice!=null)withIndex++;if(r.amount!=null)withAmount++;if(r.tradeId)withId++}}
 const manifest:ArchiveManifest={source:LOCAL_ARCHIVE_SOURCE,files_scanned:filesScanned,files_successfully_parsed:filesParsed,malformed_files:malformedFiles,malformed_rows:malformedRows,raw_trade_rows:rawRows,accepted_rows:accepted,duplicate_rows:duplicates,conflicting_duplicates:conflicts,unique_instruments:instruments.size,coverage_start:Number.isFinite(start)?new Date(start).toISOString():null,coverage_end:Number.isFinite(end)?new Date(end).toISOString():null,unique_calendar_days:dates.length,buy_count:buy,sell_count:sell,rows_with_iv:withIv,rows_with_mark_price:withMark,rows_with_index_price:withIndex,rows_with_amount:withAmount,rows_with_trade_id:withId,data_content_fingerprint:hash.digest("hex"),coverage_by_year:Object.fromEntries(Object.entries(years).sort())};
 await writeFile(join(outputRoot,LOCAL_ARCHIVE_MANIFEST),JSON.stringify(manifest,null,2)+"\n");await rm(work,{recursive:true,force:true});if(conflicts)throw new Error(`conflicting duplicate trade identities: ${conflicts}; see ${LOCAL_ARCHIVE_MANIFEST}`);return manifest;
}
export async function readLocalDay(root:string,date:string):Promise<RawOptionPrint[]>{try{return (await readFile(join(root,`${date}.jsonl`),"utf8")).split("\n").filter(Boolean).map(line=>JSON.parse(line) as RawOptionPrint)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error}}
export const previousUtcDate=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)-DAY).toISOString().slice(0,10);
