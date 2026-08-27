/* eslint-disable @typescript-eslint/no-explicit-any -- adversarial mutation harness intentionally edits decoded JSON */
import test from "node:test";import assert from "node:assert/strict";
import {execFile} from "node:child_process";import {createServer,type RequestListener} from "node:http";import {mkdtemp,readFile,writeFile} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";import {promisify} from "node:util";
import {RESEARCH_SELECTION_SCHEMA_VERSION,compactEntryEconomics,migrateResearchSelectionStore,type EvidenceTradeDto,type EvidenceUsageDto} from "../app/lib/research-selections.ts";
import {buildResearchBundle,RESEARCH_BUNDLE_FILES,REQUIRED_OUTCOMES,summarizeResearchBundleErrors,validateResearchBundle} from "../app/lib/research-bundle.ts";
import {ResearchSelectionService} from "../scripts/research-selection-service.ts";import {createResearchBundleZip,researchBundleApiPlugin} from "../scripts/research-bundle-service.ts";
import {cand,now,sel,store,ts} from "./fixtures/research-selection-store.ts";
const execFileAsync=promisify(execFile);
test("canonical persisted bundle semantics",()=>{const b=buildResearchBundle(structuredClone(store),now);assert.deepEqual(Object.keys(b.files),RESEARCH_BUNDLE_FILES);for(const [n,text] of Object.entries(b.files))if(n.endsWith("jsonl"))for(const line of text.trim().split("\n").filter(Boolean))assert.doesNotThrow(()=>JSON.parse(line));const c=b.files["candidates.jsonl"].trim().split("\n").map(JSON.parse),a=b.files["availability.jsonl"].trim().split("\n").map(JSON.parse),v=b.files["valuations.jsonl"].trim().split("\n").map(JSON.parse),o=b.files["outcomes.jsonl"].trim().split("\n").map(JSON.parse);assert.equal(c.length,8,"one maker row and one taker row per selected structure");assert.equal(new Set(c.map(x=>x.candidate_id)).size,4,"four distinct structures");assert.equal(new Set(c.map(x=>x.structure_execution_id)).size,8,"structure_execution_id is the genuine per-row key");assert.equal(a.length,7);assert.ok(!c.some(x=>x.candidate_id.includes("~u")));assert.ok(a.some(x=>x.status==="unavailable"));assert.ok(c.every(x=>x.venue==="deribit"&&x.native_currency==="BTC"));assert.ok(c.every(x=>x.execution_scenario==="maker"||x.execution_scenario==="taker"));
 // This fixture is a legacy (schemaVersion 1.0.0) store configured taker; migration must
 // preserve that evidence under taker and mark maker explicitly not_evaluated -- never 0.
 assert.ok(c.filter(x=>x.execution_scenario==="taker").every(x=>x.execution_scenario_status==="evaluated"));
 assert.ok(c.filter(x=>x.execution_scenario==="maker").every((x:any)=>x.execution_scenario_status==="not_evaluated"&&x.execution_scenario_reason!==null&&x.gross_credit_debit_native===null&&x.entry_index_price===null));
 // reconcileCandidateSpread normalizes entry_legs to {short:{},long:{}} for
 // every row (its own established shape); no price field is ever present
 // with a fabricated 0 -- absence, not zero, is how "not evaluated" reads.
 assert.ok(c.filter(x=>x.execution_scenario==="maker").every((x:any)=>x.entry_legs.short.price_native===undefined&&x.entry_legs.long.price_native===undefined));
 assert.equal(new Set(o.map(x=>x.outcome_type)).size,REQUIRED_OUTCOMES.length);assert.deepEqual(new Set(v.map(x=>x.pricing_track)),new Set(["raw_vwap","iv_normalized"]));assert.ok(v.some(x=>x.valuation_status==="unavailable"&&x.net_pnl_native===null));assert.ok(v.every(x=>x.execution_scenario==="taker"),"only the evaluated scenario produces valuation rows");assert.equal(b.run.selected_structure_count,4);assert.equal(b.run.selected_structure_execution_row_count,8);assert.equal(b.run.generated_denominator_count,7);assert.equal(validateResearchBundle(b.files).ok,true);assert.match(b.files["margin_scenarios.jsonl"],/margin_no_canonical_valuation_path/,"an unavailable margin now names the specific missing input rather than a generic code");assert.match(b.files["futures_comparisons.jsonl"],/futures_instrument_unavailable/);assert.match(b.files["evidence_trades.jsonl"],/"trade_id":"t1"/)});
test("validator rejects broken joins and versions",()=>{const b=buildResearchBundle(store,now);assert.equal(validateResearchBundle({...b.files,"candidates.jsonl":b.files["candidates.jsonl"].replace('"event_id":"e1"','"event_id":"gone"')}).ok,false);assert.equal(validateResearchBundle({...b.files,"run.json":b.files["run.json"].replace('"3.7.0"','"9.0.0"')}).ok,false)});
test("margin diagnostics stay separate from strict canonical reason codes",()=>{const fixture=structuredClone(store) as any;fixture.events.forEach((event:any)=>event.selectedStructures.forEach((selected:any)=>selected.marginSnapshot={status:"unavailable",reason:"No margin result was produced."}));const bundle=buildResearchBundle(fixture,now),rows=bundle.files["margin_scenarios.jsonl"].trim().split("\n").map(JSON.parse);assert.equal(rows.length,4);assert.ok(rows.every((row:any)=>row.margin_status==="unavailable"),"this fixture has no reference valuation, so margin genuinely cannot be reconstructed");assert.ok(rows.every((row:any)=>row.reason_codes[0]==="margin_no_canonical_valuation_path"),"the legacy placeholder is recomputed through the versioned estimator into a specific reason");assert.ok(rows.every((row:any)=>!row.reason_codes.includes("margin_not_recomputed")),"margin_not_recomputed is no longer a valid exported outcome");assert.ok(rows.every((row:any)=>typeof row.unavailable_reason==="string"&&row.unavailable_reason!=="No margin result was produced."),"the engine reports its own reason, not the legacy placeholder prose");assert.ok(rows.every((row:any)=>!row.reason_codes.includes(row.unavailable_reason)));assert.equal(validateResearchBundle(bundle.files).ok,true);const mutated=structuredClone(bundle.files);mutated["margin_scenarios.jsonl"]=mutated["margin_scenarios.jsonl"].replace('"margin_no_canonical_valuation_path"','"arbitrary human prose"');assert.equal(validateResearchBundle(mutated).ok,false,"strict validation still rejects arbitrary codes")});
test("strict validator independently rejects valuations before entry and after expiry",()=>{const base=buildResearchBundle(store,now).files,rows=base["valuations.jsonl"].trim().split("\n").map(JSON.parse),candidate=base["candidates.jsonl"].trim().split("\n").map(JSON.parse).find((c:any)=>c.candidate_id===rows[0].candidate_id&&c.execution_scenario===rows[0].execution_scenario);for(const timestamp of [Date.parse(candidate.structure_entry_timestamp_utc)-1,Date.parse(candidate.expiry_timestamp_utc)+1]){const mutated=structuredClone(rows);mutated[0].timestamp_utc=new Date(timestamp).toISOString();const result=validateResearchBundle({...base,"valuations.jsonl":mutated.map(JSON.stringify).join("\n")+"\n"});assert.equal(result.ok,false);assert.ok(result.errors.some(error=>error.includes("outside entry-to-expiry bounds")))}});

test("legacy retained paths migrate per event without changing in-window economics or source evidence",()=>{const fixture=structuredClone(store) as any,entry=ts,expiry=ts+7*864e5,valid=structuredClone(fixture.events[1].selectedStructures[0].valuationPathSnapshot[0]);valid.estimatedNetPnlBtc=.00123456789;fixture.events[1].selectedStructures[0].valuationPathSnapshot=[{...valid,timestamp:entry-144e5},valid,{...valid,timestamp:expiry},{...valid,timestamp:expiry+144e5}];fixture.events[1].selectedStructures[0].evidenceTradeSnapshots.push({instrumentName:"BTC-OLD",tradeId:"post-expiry-source",timestamp:expiry+144e5,price:.03,amount:2,indexPrice:101});const bundle=buildResearchBundle(fixture,now),valuations=bundle.files["valuations.jsonl"].trim().split("\n").map(JSON.parse),eventRows=valuations.filter((row:any)=>row.event_id==="e2"&&row.candidate_id==="deribit~c"),evidence=bundle.files["evidence_trades.jsonl"].trim().split("\n").map(JSON.parse),diagnostics=(bundle.run as any).valuation_window_diagnostics.migrated;assert.equal(validateResearchBundle(bundle.files).ok,true,"multi-event migrated bundle validates");assert.deepEqual(new Set(eventRows.map((row:any)=>Date.parse(row.timestamp_utc))),new Set([entry,expiry]));assert.ok(eventRows.filter((row:any)=>Date.parse(row.timestamp_utc)===entry&&row.pricing_track==="iv_normalized").every((row:any)=>row.net_pnl_native===valid.estimatedNetPnlBtc),"valid economics are bit-equivalent");assert.ok(evidence.some((row:any)=>row.trade_id==="post-expiry-source"&&row.window_role==="raw_source_outside_executable_window"),"raw provenance survives");assert.ok(diagnostics.some((d:any)=>d.event_id==="e2"&&d.candidate_id==="deribit~c"&&d.originatingSchema==="1.0.0"&&d.beforeEntryCount===1&&d.afterExpiryCount===1));assert.equal((bundle.run as any).valuation_window_diagnostics.builder_omitted_before_entry,0);assert.equal((bundle.run as any).valuation_window_diagnostics.builder_omitted_after_expiry,0)});
test("validator adversarial rejection matrix",()=>{const base=buildResearchBundle(store,now).files,mutate=(file:string,fn:(rows:any[])=>void)=>{const copy={...base},rows=file==="run.json"?[JSON.parse(copy[file])]:copy[file].trim().split("\n").map(JSON.parse);fn(rows);copy[file]=file==="run.json"?JSON.stringify(rows[0])+"\n":rows.map(JSON.stringify).join("\n")+"\n";return validateResearchBundle(copy)};
 const cases:[string,ReturnType<typeof validateResearchBundle>][]=[
  ["duplicate primary ID",mutate("candidates.jsonl",r=>r.push(structuredClone(r[0])))],
  ["broken foreign key",mutate("valuations.jsonl",r=>r[0].candidate_id="gone")],
  ["candidate absent from saved selections",mutate("availability.jsonl",r=>r.find(x=>x.is_selected).is_selected=false)],
  ["selected absent from availability",mutate("availability.jsonl",r=>r.splice(r.findIndex(x=>x.is_selected),1))],
  ["missing venue",mutate("events.jsonl",r=>delete r[0].venue)],
  ["venue currency contradiction",mutate("candidates.jsonl",r=>r[0].premium_currency="USDC")],
  ["nonfinite JSON",validateResearchBundle({...base,"valuations.jsonl":base["valuations.jsonl"].replace('"elapsed_hours":0','"elapsed_hours":NaN')})],
  ["timestamp out of bounds",mutate("valuations.jsonl",r=>r[0].timestamp_utc="2099-01-01T00:00:00.000Z")],
  ["missing outcome",mutate("outcomes.jsonl",r=>r.splice(r.findIndex(x=>x.outcome_type==="settlement"),1))],
  ["unknown status",mutate("valuations.jsonl",r=>r[0].valuation_status="invented")],
  ["unknown reason",mutate("valuations.jsonl",r=>r[0].reason_codes=["NOT_A_CODE"])],
  ["missing pricing track",mutate("valuations.jsonl",r=>{for(let i=r.length-1;i>=0;i--)if(r[i].candidate_id===r[0].candidate_id&&r[i].pricing_track==="raw_vwap")r.splice(i,1)})],
  ["unreconciled total",mutate("valuations.jsonl",r=>{const x=r.find(x=>x.net_pnl_usd!==null);x.net_pnl_usd+=1})],
  ["flattened source run",mutate("events.jsonl",r=>r[0].source_run_id="deribit~source~invented")],
  ["unknown version",mutate("run.json",r=>r[0].schema_version="9.0.0")],
 ];for(const [label,result] of cases)assert.equal(result.ok,false,label);
});
test("schema represents a hypothetical Bybit linear-USDC option without BTC premiums",()=>{const files=structuredClone(buildResearchBundle(store,now).files);for(const name of RESEARCH_BUNDLE_FILES.filter(n=>n.endsWith(".jsonl"))){const rows=files[name].trim().split("\n").filter(Boolean).map(JSON.parse);for(const r of rows)if(r.candidate_id==="deribit~a"||r.event_id==="e1"){r.venue="bybit";if(r.candidate_id==="deribit~a"){r.contract_style="linear";r.native_currency="USDC";r.premium_currency="USDC";r.settlement_currency="USDC";r.quote_currency="USD";r.contract_multiplier=1}}files[name]=rows.map(JSON.stringify).join("\n")+(rows.length?"\n":"")}const run=JSON.parse(files["run.json"]);run.venues=["bybit","deribit"];run.source_runs.filter((x:any)=>x.event_id==="e1").forEach((x:any)=>x.venue="bybit");files["run.json"]=JSON.stringify(run)+"\n";assert.doesNotMatch(files["candidates.jsonl"].split("\n").find(x=>x.includes('"candidate_id":"deribit~a"'))!,/"premium_currency":"BTC"/);assert.equal(validateResearchBundle(files).ok,true)});
test("live acceptance: persistence restart, selected-only ZIP, inspection, and reconciliation",async()=>{const dir=await mkdtemp(join(tmpdir(),"bundle-live-"));let service=new ResearchSelectionService(dir);await service.save(store.datasetId,store);service=new ResearchSelectionService(dir);const restored=await service.read(store.datasetId);assert.deepEqual(restored.events.map(e=>e.selectedStructures.length),[2,2]);const bundle=buildResearchBundle(restored,now),zip=createResearchBundleZip(bundle.files),artifact=join(dir,"acceptance-research-bundle.zip");await writeFile(artifact,zip);assert.equal(zip.subarray(0,4).toString("hex"),"504b0304");assert.equal(validateResearchBundle(bundle.files).ok,true);const count=(name:string)=>bundle.files[name].trim().split("\n").filter(Boolean).length;assert.deepEqual({events:count("events.jsonl"),candidates:count("candidates.jsonl"),availability:count("availability.jsonl"),valuations:count("valuations.jsonl"),outcomes:count("outcomes.jsonl"),margins:count("margin_scenarios.jsonl"),evidence:count("evidence_trades.jsonl")},{events:2,candidates:8,availability:7,valuations:16,outcomes:36,margins:4,evidence:2});assert.equal(bundle.run.selected_structure_count,4);assert.equal(bundle.run.selected_structure_execution_row_count,count("candidates.jsonl"));assert.equal(bundle.run.generated_denominator_count,count("availability.jsonl"));});
test("ZIP is independently listable, extractable, and contains parseable bundle files",async()=>{const dir=await mkdtemp(join(tmpdir(),"bundle-zip-")),artifact=join(dir,"research-bundle.zip"),extracted=join(dir,"extracted"),bundle=buildResearchBundle(store,now),zip=createResearchBundleZip(bundle.files);await writeFile(artifact,zip);assert.equal(zip.subarray(0,4).toString("ascii"),"PK\u0003\u0004");const listed=(await execFileAsync("unzip",["-Z1",artifact])).stdout.trim().split("\n");assert.deepEqual(listed.sort(),RESEARCH_BUNDLE_FILES.map(name=>`research_bundle/${name}`).sort());await execFileAsync("unzip",["-q",artifact,"-d",extracted]);for(const name of RESEARCH_BUNDLE_FILES){const text=await readFile(join(extracted,"research_bundle",name),"utf8");if(name.endsWith(".jsonl"))for(const line of text.trim().split("\n").filter(Boolean))assert.doesNotThrow(()=>JSON.parse(line),name);else assert.doesNotThrow(()=>JSON.parse(text),name)}});
test("research bundle endpoint preserves ZIP bytes and download headers",async()=>{const dir=await mkdtemp(join(tmpdir(),"bundle-http-"));await new ResearchSelectionService(dir).save(store.datasetId,store);let middleware:RequestListener|undefined;researchBundleApiPlugin(dir).configureServer?.({middlewares:{use(handler:RequestListener){middleware=handler}}} as any);assert.ok(middleware);const server=createServer(middleware);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));try{const address=server.address();assert.ok(address&&typeof address!=="string");const response=await fetch(`http://127.0.0.1:${address.port}/__local/research-bundle/${store.datasetId}`),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"application/zip");assert.match(response.headers.get("content-disposition")??"",/^attachment; filename="research-bundle-acceptance-[^"]+\.zip"$/);assert.equal(Number(response.headers.get("content-length")),bytes.length);assert.equal(bytes.subarray(0,4).toString("hex"),"504b0304");await writeFile(join(dir,"endpoint.zip"),bytes);await execFileAsync("unzip",["-t",join(dir,"endpoint.zip")])}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}});

test("production narrative IV reasons stay prose while typed IV provenance and codes validate",()=>{
 const fixture=structuredClone(store);const selected=fixture.events[0].selectedStructures[0] as any;
 selected.candidateSnapshot.qualityReasonCodes=["local-observed-IV short; local-observed-IV long."];
 selected.entrySnapshot.qualityReason="local-observed-IV short; local-observed-IV long.";
 for(const point of selected.valuationPathSnapshot)if(point.status==="priced"){
  point.soldIvSource="local-observed-IV";
  point.longIvSource="constant-entry-IV";
  point.rawEstimate.qualityReason="local-observed-IV short; local-observed-IV long.";
  point.modelEstimate.qualityReason="local-observed-IV short; constant-entry-IV long.";
 }
 const bundle=buildResearchBundle(fixture,now),candidates=bundle.files["candidates.jsonl"].trim().split("\n").map(JSON.parse),valuations=bundle.files["valuations.jsonl"].trim().split("\n").map(JSON.parse);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 assert.equal(candidates.find((x:any)=>x.candidate_id===selected.candidateId&&x.execution_scenario==="taker").quality_reason,"local-observed-IV short; local-observed-IV long.");
 assert.ok(valuations.some(row=>row.short_leg.iv_source==="local-observed-IV"&&row.long_leg.iv_source==="constant-entry-IV"));
 assert.ok(valuations.some(row=>row.quality_reason.includes("local-observed-IV short")));
 for(const name of ["candidates.jsonl","valuations.jsonl","outcomes.jsonl","availability.jsonl","margin_scenarios.jsonl","futures_comparisons.jsonl"]){for(const record of bundle.files[name].trim().split("\n").filter(Boolean).map(JSON.parse)){for(const key of ["entry_reason_codes","reason_codes","unavailable_reason_codes","missing_field_codes"]){for(const code of record[key]??[])assert.match(code,/^[a-z0-9][a-z0-9_-]*$/,`${name}.${key}`)}}}
});



test("timestamp contract keeps raw evidence separate from executable windows",()=>{
 const fixture=structuredClone(store) as any, ids=[
  "deribit~default-sample-trades~1c454ed4~credit~p~1723795200000~48000~45000~anchor~7",
  "deribit~default-sample-trades~1c454ed4~credit~p~1723795200000~48000~46000~anchor~7",
  "deribit~default-sample-trades~1c454ed4~credit~p~1724400000000~48000~47000~anchor~14",
 ];
 const entry=1723795200000, expiry7=1724400000000, expiry14=1725004800000;
 fixture.datasetId="default-sample-trades";fixture.events=[{...fixture.events[0],eventId:"1c454ed4",sourceRun:{event:{id:"1c454ed4",direction:"long",entryTimestamp:entry,entryDate:"2024-08-16",entryPrice:58000}},generationSnapshot:{...fixture.events[0].generationSnapshot,underlyingHourlyPath:[{openTime:entry,closeTime:entry+3600000,open:1,high:1,low:1,close:58000,volume:1}],candidates:ids.map((id,i)=>({...cand(String(i)),candidateId:id,actualExpiryTimestamp:i<2?expiry7:expiry14,targetHorizon:i<2?7:14,actualStrikes:{short:48000,long:i===0?45000:i===1?46000:47000,width:i===0?3000:i===1?2000:1000},requestedStrikes:{short:48000,long:i===0?45000:i===1?46000:47000,width:i===0?3000:i===1?2000:1000}}))},selectedStructures:ids.map((id,i)=>{const expiry=i<2?expiry7:expiry14, s=sel("1c454ed4","a") as any;s.candidateId=id;s.eventId="1c454ed4";const longStrike=i===0?45000:i===1?46000:47000;s.candidateSnapshot={...s.candidateSnapshot,expiryTimestamp:expiry,shortStrike:48000,longStrike,actualWidth:48000-longStrike,targetDte:i<2?7:14};s.entrySnapshot={...s.entrySnapshot,targetTimestamp:entry,valuationTimestamp:entry,sold:{...s.entrySnapshot.sold,supportingTrades:[{instrumentName:"BTC-S",tradeId:`at-${i}`,timestamp:entry,price:.02,amount:1,indexPrice:58000,ivDecimal:.6}]},bought:{...s.entrySnapshot.bought,supportingTrades:[{instrumentName:"BTC-L",tradeId:`inside-${i}`,timestamp:entry+1,price:.01,amount:1,indexPrice:58000,ivDecimal:.6}]}};s.valuationPathSnapshot=[{timestamp:entry,status:"priced",targetIndex:58000,modelEstimate:s.entrySnapshot,estimatedNetPnlBtc:.01,estimateQuality:"red"},{timestamp:expiry,status:"priced",targetIndex:58000,modelEstimate:s.entrySnapshot,estimatedNetPnlBtc:.01,estimateQuality:"red"}];s.outcomeSnapshots=[{label:"Settlement",status:"estimated",decisionTimestamp:expiry,valuationTimestamp:expiry,estimatedNetPnlBtc:.01,conversionIndex:58000},{label:"14D",status:"unavailable",decisionTimestamp:entry+14*864e5,estimateQuality:"unavailable"}];s.evidenceTradeSnapshots=[{instrumentName:"BTC-RAW",tradeId:`before-${i}`,timestamp:entry-1,price:.01,amount:1,indexPrice:58000,ivDecimal:.6},{instrumentName:"BTC-RAW",tradeId:`after-${i}`,timestamp:expiry+1,price:.01,amount:1,indexPrice:58000,ivDecimal:.6}];return s})}];
 const bundle=buildResearchBundle(fixture,now);assert.equal(validateResearchBundle(bundle.files).ok,true);
 const candidates=bundle.files["candidates.jsonl"].trim().split("\n").map(JSON.parse),vals=bundle.files["valuations.jsonl"].trim().split("\n").map(JSON.parse),evidence=bundle.files["evidence_trades.jsonl"].trim().split("\n").map(JSON.parse),outcomes=bundle.files["outcomes.jsonl"].trim().split("\n").map(JSON.parse);
 for(const id of ids){assert.ok(candidates.find(x=>x.candidate_id===id));assert.ok(vals.filter(x=>x.candidate_id===id).every(x=>x.window_role==="executable_observation"));assert.ok(outcomes.some(x=>x.candidate_id===id&&x.outcome_type==="credit_capture_25"&&x.window_role==="outside_executable_window"&&x.valuation_timestamp_utc===null));}
 assert.ok(evidence.some(x=>x.window_role==="raw_source_outside_executable_window"));
 const bad={...bundle.files,"valuations.jsonl":bundle.files["valuations.jsonl"].replace(new Date(entry).toISOString(),new Date(entry-1).toISOString())};assert.equal(validateResearchBundle(bad).ok,false);
});

test("malformed second timestamps are rejected before export",()=>{const fixture=structuredClone(store) as any;fixture.events[0].selectedStructures[0].entrySnapshot.targetTimestamp=1723795200;assert.throws(()=>buildResearchBundle(fixture,now),/millisecond Unix timestamp/);});

test("fractional interpolation evidence is normalized without changing selection identity",()=>{const fixture=structuredClone(store) as any,event=fixture.events[0],selected=event.selectedStructures[0],timestamp=1714815638094.0405,oldId=`evidence~deribit~btc-10may24-56000-p~${timestamp}~no-side~no-price~no-amount`;event.evidenceCatalog=[{evidenceId:oldId,venue:"deribit",instrument:"BTC-10MAY24-56000-P",tradeId:null,timestamp,direction:null,price:null,amount:null,indexPrice:null,ivApiPercent:null,ivDecimal:.5,blockTradeId:null,rfqId:null}];selected.evidenceUsages=[{evidenceId:oldId,candidateId:selected.candidateId,role:"valuation",valuationTimestamp:ts,pricingTrack:"model-reconstructed",leg:"sold",executionScenario:null}];const identities=fixture.events.flatMap((e:any)=>e.selectedStructures.map((s:any)=>[s.selectionId,s.candidateId,s.strategyVariantId??s.candidateId]));const migrated=migrateResearchSelectionStore(fixture),normalized=migrated.events[0].evidenceCatalog[0];assert.equal(normalized.timestamp,1714815638094);assert.ok(Number.isInteger(normalized.timestamp));assert.ok(normalized.timestamp<=timestamp);assert.match(normalized.evidenceId,/~1714815638094~/);assert.equal(migrated.events[0].selectedStructures[0].evidenceUsages[0].evidenceId,normalized.evidenceId);assert.deepEqual(migrated.events.flatMap((e:any)=>e.selectedStructures.map((s:any)=>[s.selectionId,s.candidateId,s.strategyVariantId??s.candidateId])),identities);const bundle=buildResearchBundle(migrated,now);assert.equal(validateResearchBundle(bundle.files).ok,true);assert.match(bundle.files["evidence_trades.jsonl"],/2024-05-04T09:40:38\.094Z/);});

test("validation summaries deduplicate repeated failures with occurrence counts",()=>{
 const summary=summarizeResearchBundleErrors(["valuations.jsonl reason_codes has unknown reason code bad.","valuations.jsonl reason_codes has unknown reason code bad.","outcomes.jsonl reason_codes has unknown reason code nope."],1);
 assert.equal(summary.total,3);assert.equal(summary.unique.length,2);assert.match(summary.summary,/\(2 rows\)/);assert.match(summary.summary,/1 more unique errors/);
});

test("semantic validation failure returns JSON and never ZIP bytes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"bundle-invalid-"));
 await writeFile(join(dir,"acceptance.json"),"{malformed persisted selection");let middleware:RequestListener|undefined;
 researchBundleApiPlugin(dir).configureServer?.({middlewares:{use(handler:RequestListener){middleware=handler}}} as any);assert.ok(middleware);const server=createServer(middleware);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));try{const address=server.address();assert.ok(address&&typeof address!=="string");const response=await fetch(`http://127.0.0.1:${address.port}/__local/research-bundle/acceptance`),bytes=Buffer.from(await response.arrayBuffer());assert.equal(response.status,422);assert.match(response.headers.get("content-type")??"",/application\/json/);assert.notEqual(bytes.subarray(0,2).toString("ascii"),"PK")}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});

test("a structure genuinely evaluated under both maker and taker exports two independent, paired rows",()=>{
 const dual=structuredClone(store) as any;
 const s=dual.events[0].selectedStructures[0];
 s.executionScenarios={
  maker:{status:"evaluated",reason:null,entrySnapshot:{...s.entrySnapshot,sold:{priceBtcPerContract:.03},bought:{priceBtcPerContract:.02},netOpeningCashFlowBtc:.009},valuationPathSnapshot:s.valuationPathSnapshot,outcomeSnapshots:s.outcomeSnapshots},
  taker:{status:"evaluated",reason:null,entrySnapshot:s.entrySnapshot,valuationPathSnapshot:s.valuationPathSnapshot,outcomeSnapshots:s.outcomeSnapshots},
 };
 delete s.entrySnapshot;delete s.valuationPathSnapshot;delete s.outcomeSnapshots;
 // Isolate this one already-current-shape structure so the fixture's other
 // (legacy-shaped) structures don't need migrating for this test's purpose.
 dual.events=[{...dual.events[0],selectedStructures:[s]}];
 dual.schemaVersion=RESEARCH_SELECTION_SCHEMA_VERSION;
 const bundle=buildResearchBundle(dual,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const rows=bundle.files["candidates.jsonl"].trim().split("\n").map(JSON.parse).filter((x:any)=>x.candidate_id===s.candidateId);
 assert.equal(rows.length,2);
 const maker=rows.find((x:any)=>x.execution_scenario==="maker"),taker=rows.find((x:any)=>x.execution_scenario==="taker");
 assert.equal(maker.execution_scenario_status,"evaluated");assert.equal(taker.execution_scenario_status,"evaluated");
 // Same structural identity, independently priced evidence.
 assert.equal(maker.expiry_timestamp_utc,taker.expiry_timestamp_utc);
 assert.deepEqual(maker.actual_strikes,taker.actual_strikes);
 assert.notEqual(maker.entry_legs.short.price_native,taker.entry_legs.short.price_native,"scenarios must not converge on the same evidence");
 assert.notEqual(maker.structure_execution_id,taker.structure_execution_id);
 const vals=bundle.files["valuations.jsonl"].trim().split("\n").map(JSON.parse).filter((x:any)=>x.candidate_id===s.candidateId);
 assert.ok(vals.some((v:any)=>v.execution_scenario==="maker"));assert.ok(vals.some((v:any)=>v.execution_scenario==="taker"));
});

test("structure_execution_id is unique per row even though candidate_id is intentionally shared",()=>{
 const b=buildResearchBundle(structuredClone(store),now);
 const rows=b.files["candidates.jsonl"].trim().split("\n").map(JSON.parse);
 const ids=rows.map((r:any)=>r.structure_execution_id);
 assert.equal(new Set(ids).size,ids.length);
 assert.ok(new Set(rows.map((r:any)=>r.candidate_id)).size<rows.length,"candidate_id is deliberately not row-unique");
});

test("a not_evaluated scenario produces zero valuation and outcome rows, never fabricated ones",()=>{
 const b=buildResearchBundle(structuredClone(store),now);
 const makerCandidateIds=b.files["candidates.jsonl"].trim().split("\n").map(JSON.parse).filter((x:any)=>x.execution_scenario==="maker").map((x:any)=>x.candidate_id);
 const vals=b.files["valuations.jsonl"].trim().split("\n").map(JSON.parse),outs=b.files["outcomes.jsonl"].trim().split("\n").map(JSON.parse);
 for(const id of makerCandidateIds){
  assert.equal(vals.filter((v:any)=>v.candidate_id===id&&v.execution_scenario==="maker").length,0);
  assert.equal(outs.filter((o:any)=>o.candidate_id===id&&o.execution_scenario==="maker").length,0);
 }
});

test("evidence usage provenance is tagged with the execution scenario it supported",()=>{
 const dual=structuredClone(store) as any;
 const s=dual.events[0].selectedStructures[0];
 const path=s.valuationPathSnapshot,outcomes=s.outcomeSnapshots;
 const makerEntry={...s.entrySnapshot,sold:{priceBtcPerContract:.03,supportingTrades:[{instrumentName:"BTC-M",tradeId:"maker-t1",timestamp:ts,price:.03,amount:1,indexPrice:100}]},bought:{priceBtcPerContract:.02}};
 const takerEntry={...s.entrySnapshot,sold:{priceBtcPerContract:.02,supportingTrades:[{instrumentName:"BTC-T",tradeId:"taker-t1",timestamp:ts,price:.02,amount:1,indexPrice:100}]},bought:{priceBtcPerContract:.01}};
 // Mirror the real production path: compactEntryEconomics is what actually
 // extracts embedded supportingTrades into the evidence catalog + usages.
 const catalog=new Map<string,EvidenceTradeDto>(),usages:EvidenceUsageDto[]=[];
 const compactedMaker=compactEntryEconomics("deribit",s.candidateId,makerEntry,usages,catalog,"maker");
 const compactedTaker=compactEntryEconomics("deribit",s.candidateId,takerEntry,usages,catalog,"taker");
 s.executionScenarios={
  maker:{status:"evaluated",reason:null,entrySnapshot:compactedMaker,valuationPathSnapshot:path,outcomeSnapshots:outcomes},
  taker:{status:"evaluated",reason:null,entrySnapshot:compactedTaker,valuationPathSnapshot:path,outcomeSnapshots:outcomes},
 };
 delete s.entrySnapshot;delete s.valuationPathSnapshot;delete s.outcomeSnapshots;delete s.evidenceTradeSnapshots;
 s.evidenceUsages=usages;
 dual.events=[{...dual.events[0],selectedStructures:[s],evidenceCatalog:[...catalog.values()]}];
 dual.schemaVersion=RESEARCH_SELECTION_SCHEMA_VERSION;
 const bundle=buildResearchBundle(dual,now);
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const evidence=bundle.files["evidence_trades.jsonl"].trim().split("\n").map(JSON.parse);
 const makerTrade=evidence.find((e:any)=>e.trade_id==="maker-t1"),takerTrade=evidence.find((e:any)=>e.trade_id==="taker-t1");
 assert.ok(makerTrade);assert.ok(takerTrade);
 assert.ok(makerTrade.usage_references.some((u:any)=>u.execution_scenario==="maker"));
 assert.ok(takerTrade.usage_references.some((u:any)=>u.execution_scenario==="taker"));
});


test("availability keeps distinct generation attempts when requested widths collapse to one structure",()=>{
 const fixture=structuredClone(store) as any;
 const duplicate={...fixture.events[0].generationSnapshot.candidates[0],requestedStrikes:{short:100,long:80,width:20},actualStrikes:{short:100,long:90,width:10}};
 fixture.events[0].generationSnapshot.candidates.push(duplicate);
 const bundle=buildResearchBundle(fixture,now);assert.equal(validateResearchBundle(bundle.files).ok,true);
 const rows=bundle.files["availability.jsonl"].trim().split("\n").map(JSON.parse).filter((r:any)=>r.candidate_id===duplicate.candidateId);
 assert.equal(rows.length,2,"two requested generation attempts remain visible");
 assert.equal(new Set(rows.map((r:any)=>r.availability_id)).size,2,"availability_id, not candidate_id, is the denominator row key");
 assert.ok(rows.some((r:any)=>r.requested_strikes.width===20&&r.actual_strikes.width===10));
 const reordered=structuredClone(fixture);reordered.events[0].generationSnapshot.candidates.reverse();
 const reorderedIds=buildResearchBundle(reordered,now).files["availability.jsonl"].trim().split("\n").map(JSON.parse).filter((r:any)=>r.candidate_id===duplicate.candidateId).map((r:any)=>r.availability_id).sort();
 assert.deepEqual(reorderedIds,rows.map((r:any)=>r.availability_id).sort(),"generation row identity is stable across regeneration order");
 const exactDuplicate=structuredClone(fixture);exactDuplicate.events[0].generationSnapshot.candidates.push(structuredClone(duplicate));
 assert.throws(()=>buildResearchBundle(exactDuplicate,now),/Duplicate generation attempt/);
});

test("debit evaluated evidence is rejected before persistence/export",()=>{
 const fixture=structuredClone(store) as any;const s=fixture.events[0].selectedStructures[0];
 s.executionScenarios={
  maker:{status:"evaluated",reason:null,entrySnapshot:{...s.entrySnapshot,sold:{priceBtcPerContract:.01},bought:{priceBtcPerContract:.02},grossSpreadBtc:-.01,openingFeesBtc:.001,netOpeningCashFlowBtc:-.011},valuationPathSnapshot:s.valuationPathSnapshot,outcomeSnapshots:s.outcomeSnapshots},
  taker:{status:"evaluated",reason:null,entrySnapshot:{...s.entrySnapshot,sold:{priceBtcPerContract:.03},bought:{priceBtcPerContract:.01},grossSpreadBtc:.02,openingFeesBtc:.001,netOpeningCashFlowBtc:.019},valuationPathSnapshot:s.valuationPathSnapshot,outcomeSnapshots:s.outcomeSnapshots},
 };delete s.entrySnapshot;delete s.valuationPathSnapshot;delete s.outcomeSnapshots;fixture.events=[{...fixture.events[0],selectedStructures:[s]}];fixture.schemaVersion="1.2.0";
 assert.throws(()=>buildResearchBundle(fixture,now),/debit, not a credit/);
});

test("stale selected candidates are rejected at store validation before bundle export",()=>{
 const fixture=structuredClone(store) as any;fixture.schemaVersion="1.2.0";fixture.events[0].selectedStructures[0]={...fixture.events[0].selectedStructures[0],candidateId:"deribit~missing"};
 assert.throws(()=>buildResearchBundle(fixture,now),/stale\/unmatched/);
});

test("reference-only candidates are admissible without fabricating maker/taker execution",()=>{
 const fixture=migrateResearchSelectionStore(structuredClone(store)) as any;
 const event=fixture.events[0],s=event.selectedStructures[0],entry=structuredClone(s.executionScenarios.taker.entrySnapshot);
 s.contractResolution={status:"exact_resolved",reason:null,short:{instrumentName:"BTC-S",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:100,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true},long:{instrumentName:"BTC-L",creationTimestamp:ts-1,expirationTimestamp:ts+7*864e5,strike:90,optionType:"P",contractSize:1,source:"fixture",retrievedAtUtc:now,authoritative:true}};
 s.referenceValuation={status:"valued",reason:null,source:"local_iv_interpolation",entrySnapshot:entry,valuationPathSnapshot:[],outcomeSnapshots:[],provenance:{executionIndependent:true,method:"causal fixture"}};
 s.executionScenarios={maker:{status:"unavailable",reason:"No maker tape.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]},taker:{status:"not_evaluated",reason:"Taker was intentionally skipped.",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[]}};
 s.selectionProvenance="model-only-diagnostic";fixture.events=[{...event,selectedStructures:[s]},{...fixture.events[1],selectedStructures:[]}];
 const bundle=buildResearchBundle(fixture,now),candidateRows=bundle.files["candidates.jsonl"].trim().split("\n").map(JSON.parse);
 assert.deepEqual(candidateRows.map((r:any)=>r.execution_scenario_status),["unavailable","not_evaluated"]);
 assert.ok(candidateRows.every((r:any)=>r.structure_entry_timestamp_utc===null&&r.gross_credit_debit_native===null));
 assert.equal(bundle.files["valuations.jsonl"],"");assert.equal(bundle.files["outcomes.jsonl"],"");
 assert.equal(validateResearchBundle(bundle.files).ok,true);
 const unsupported=candidateRows.map((r:any)=>JSON.stringify({...r,reference_valuation:{status:"unavailable",reason:"No valuation.",source:"unavailable",entrySnapshot:null,valuationPathSnapshot:[],outcomeSnapshots:[],provenance:{executionIndependent:true}}})).join("\n")+"\n";
 assert.match(validateResearchBundle({...bundle.files,"candidates.jsonl":unsupported}).errors.join(" "),/no valid analytical track/);
 for(const mutation of [
  (r:any)=>{r.reference_valuation.provenance={};},
  (r:any)=>{r.reference_valuation.entrySnapshot.targetTimestamp=ts+8*864e5;},
  (r:any)=>{r.reference_valuation.entrySnapshot.sold.priceBtcPerContract=.005;r.reference_valuation.entrySnapshot.bought.priceBtcPerContract=.01;},
 ]){const rows=structuredClone(candidateRows);rows.forEach(mutation);const checked=validateResearchBundle({...bundle.files,"candidates.jsonl":rows.map(JSON.stringify).join("\n")+"\n"});assert.equal(checked.ok,false,"status alone must not validate malformed reference economics");}
});
