import {readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {unzipSync,strFromU8} from "fflate";
import {validateResearchBundle} from "../app/lib/research-bundle.ts";

const path=process.argv[2];
if(!path)throw new Error("Usage: npm run audit:execution-integration -- <bundle-directory-or-zip>");
const files:Record<string,string>={};
if(statSync(path).isDirectory()){
 for(const name of ["run.json","structure_economics.jsonl","availability.jsonl","candidates.jsonl","valuations.jsonl","outcomes.jsonl","events.jsonl","underlying_path.jsonl","margin_scenarios.jsonl","evidence_trades.jsonl","futures_comparisons.jsonl","futures_path.jsonl","event_volatility_state.jsonl","structure_volatility_state.jsonl"])
  files[name]=readFileSync(join(path,name),"utf8");
}else for(const [name,data] of Object.entries(unzipSync(readFileSync(path))))files[name.split("/").pop()!]=strFromU8(data);
type Row=Record<string,unknown>;
const run=JSON.parse(files["run.json"]!) as Row;
const rows=(name:string)=>(files[name]??"").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line) as Row);
const economics=rows("structure_economics.jsonl");
const tracks=economics.flatMap(x=>(Array.isArray(x.tracks)?x.tracks:[]).map(raw=>({...raw as Row,candidate_id:x.candidate_id})));
const names:Record<string,string>={reference_fair_value:"Reference fair value",modeled_expected:"Empirical expected Q50",modeled_conservative:"Empirical conservative Q90",strict_maker:"Immediate maker",strict_taker:"Immediate taker",delayed_maker:"Delayed maker",delayed_taker:"Delayed taker"};
console.log(`Schema: ${run.schema_version}\nSelected structures: ${run.selected_structure_count}\n\nTrack                         available  unavailable`);
for(const [key,label] of Object.entries(names)){const x=tracks.filter((t:Row)=>t.track===key);console.log(`${label.padEnd(30)} ${String(x.filter((t:Row)=>t.status==="available").length).padStart(9)}  ${String(x.filter((t:Row)=>t.status!=="available").length).padStart(11)}`)}
const modeled=tracks.filter((t:Row)=>["modeled_expected","modeled_conservative"].includes(t.track));
const economic=(track:string)=>modeled.filter((t:Row)=>t.track===track&&t.reason_code==="modeled_execution_non_economic").length;
const pending=modeled.filter((t:Row)=>t.reason_code==="modeled_execution_pending").length;
const insufficient=modeled.filter((t:Row)=>t.reason_code==="modeled_calibration_insufficient").length;
const missing=modeled.filter((t:Row)=>t.reason_code==="modeled_execution_non_economic"&&(!t.provenance||!t.engine_version)).length;
const legacy=modeled.filter((t:Row)=>t.reason_code!=="modeled_execution_pending"&&t.engine_version!==run.modeled_execution_methodology_version).length;
const economicProse=(t:Row)=>/nonpositive\s+credit|non-economic/i.test(String(t.reason??""));
const unclassified=modeled.filter((t:Row)=>t.status!=="available"&&economicProse(t)&&t.reason_code!=="modeled_execution_non_economic").length;
const tagged=tracks.filter((t:Row)=>["modeled_expected","modeled_conservative","reference_fair_value"].includes(t.track)&&t.execution_scenario!=null).length;
console.log(`\nPending empirical recompute: ${pending}\nEconomic Q50 rejections: ${economic("modeled_expected")}\nEconomic Q90 rejections: ${economic("modeled_conservative")}\nCalibration-insufficient: ${insufficient}\nEmpirical unavailable with missing provenance: ${missing}\nLegacy/stale modeled tracks: ${legacy}\nUnclassified empirical unavailable: ${unclassified}\nModeled tracks tagged maker/taker: ${tagged}\nUnscoped current model_assumptions present: ${"model_assumptions" in run?"YES":"NO"}\n\nReference method: ${run.reference_valuation_methodology_version}\nModeled method: ${run.modeled_execution_methodology_version}\nEstimator: ${run.execution_estimator_version}\nCalibration method: ${run.execution_calibration_method_version}\nForward method: ${(run.forward_method_versions??[]).join(", ")}\nArtifact hash: ${(run.execution_estimator_artifact_hashes??[]).join(", ")}`);
const validation=validateResearchBundle(files);
const failures=[...validation.errors,...(!String(run.schema_version).startsWith("3.8")?["schema is not 3.8"]:[]),...(run.model_assumptions?["unscoped model_assumptions present"]:[]),...(unclassified?["legacy/unclassified economic rejection"]:[]),...(pending||missing||legacy||tagged?["execution closure invariant failed"]:[])];
if(failures.length){console.error(failures.join("\n"));process.exitCode=1;}
