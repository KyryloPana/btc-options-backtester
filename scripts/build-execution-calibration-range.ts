#!/usr/bin/env node
/**
 * Day-sharded materializer for the execution-calibration universe.
 *
 * Each day is an independent subprocess against the same builder, so an
 * interrupted run resumes simply by being re-run: completed shards reuse their
 * cached raw source and their observations are rewritten deterministically,
 * while an incomplete shard refetches. Progress is reported per shard on stderr
 * as one JSON object per line.
 *
 *   node --experimental-strip-types scripts/build-execution-calibration-range.ts \
 *     2023-10-01 2026-08-28 [--concurrency=N]
 *
 * `--concurrency` runs N days in flight at once. Shard boundaries are disjoint
 * and targets are half-open per day, so ordering never affects the output; the
 * flag only trades wall clock against load on the history API. It defaults to 1.
 */
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const DAY=86_400_000;
export function calibrationDayRanges(startMs:number,endExclusiveMs:number){const out:Array<{start:string;end:string}>=[];for(let cursor=startMs;cursor<endExclusiveMs;cursor+=DAY){const next=Math.min(cursor+DAY,endExclusiveMs);out.push({start:new Date(cursor).toISOString().slice(0,10),end:new Date(next).toISOString().slice(0,10)})}return out}

export function parseConcurrency(argv:readonly string[]):number{
 const flag=argv.find(a=>a.startsWith("--concurrency="));
 if(!flag)return 1;
 const value=Number(flag.slice("--concurrency=".length));
 if(!Number.isInteger(value)||value<1||value>16)throw new Error("--concurrency must be an integer between 1 and 16");
 return value;
}

async function main(){
 const positional=process.argv.slice(2).filter(a=>!a.startsWith("--"));
 const [startArg,endArg]=positional,start=Date.parse(`${startArg}T00:00:00Z`),end=Date.parse(`${endArg}T00:00:00Z`);
 if(!startArg||!endArg||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)
  throw new Error("usage: build-execution-calibration-range.ts YYYY-MM-DD YYYY-MM-DD [--concurrency=N]");
 const concurrency=parseConcurrency(process.argv.slice(2));
 const ranges=calibrationDayRanges(start,end),builder=fileURLToPath(new URL("build-execution-calibration.ts",import.meta.url));
 let next=0,completed=0;
 const runOne=(range:{start:string;end:string},index:number)=>new Promise<void>((resolve,reject)=>{
  console.error(JSON.stringify({status:"starting",shard:index+1,total:ranges.length,...range}));
  // The builder's own manifest goes to stdout; only progress belongs on stderr,
  // so a long run stays readable and a shard's output stays machine-parseable.
  const child=spawn(process.execPath,["--experimental-strip-types",builder,range.start,range.end],{stdio:["ignore","ignore","inherit"]});
  child.once("error",reject);
  child.once("exit",code=>{
   if(code!==0)return reject(new Error(`calibration shard ${range.start} failed with exit ${code}`));
   completed+=1;
   console.error(JSON.stringify({status:"complete",shard:index+1,total:ranges.length,completed,...range}));
   resolve();
  });
 });
 const worker=async()=>{for(;;){const index=next++;if(index>=ranges.length)return;await runOne(ranges[index]!,index)}};
 await Promise.all(Array.from({length:Math.min(concurrency,ranges.length)},worker));
 console.error(JSON.stringify({status:"finished",total:ranges.length,completed}));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await main();
