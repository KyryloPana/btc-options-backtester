import { importResearchBundle } from "../lib/research-analysis";
import type { WorkerImportMessage, WorkerImportRequest } from "../lib/research-analysis-worker-client";

const stage=(id:number,stage:"reading-archive"|"parsing-source-data"|"normalizing-records"|"validating-research-bundle"|"preparing-analytics")=>postMessage({type:"stage",id,stage});
self.onmessage=(event:MessageEvent<WorkerImportRequest>)=>{
 const {id,bytes,filename,companionText}=event.data;
 try{
  stage(id,"reading-archive");
  let companion:unknown;
  if(companionText!==undefined){stage(id,"parsing-source-data");companion=JSON.parse(companionText)}
  stage(id,"validating-research-bundle");
  const result=importResearchBundle(bytes,filename,companion);
  stage(id,"preparing-analytics");
  postMessage({type:"result",id,result} satisfies WorkerImportMessage);
 }catch(error){
  postMessage({type:"result",id,result:{status:"invalid",errors:[error instanceof Error?error.message:"Research bundle import failed."]}} satisfies WorkerImportMessage);
 }
};
