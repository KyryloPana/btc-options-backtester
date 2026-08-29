import { canonicalJson, compactResearchSelectionEvent, type JsonValue, type ResearchSelectionStore, type SelectedStructure } from "./research-selections.ts";
import { buildModeledExecution } from "./modeled-execution.ts";
import { buildResearchMarginSnapshot, LEGACY_MARGIN_NOT_COMPUTED_REASON } from "./research-margin.ts";

export const CURRENT_RESEARCH_ENGINE_VERSIONS={
 immediateExecution:"immediate-scenario-v2",referenceValuation:"causal-reference-v3-expiry-forward-hybrid/repricing-v2",
 delayedExecution:"causal-delayed-v2",modeledExecution:"modeled-execution-v3-empirical-taker",
 settlementAccounting:"inverse-settlement-v2",margin:"deribit-standard-margin-v2",
} as const;
export type DerivedLayer=keyof typeof CURRENT_RESEARCH_ENGINE_VERSIONS;
export type RefreshScope={kind:"structure";eventId:string;candidateId:string}|{kind:"event";eventId:string}|{kind:"all"};

export interface DerivedResearchOutput {
 executionScenarios:SelectedStructure["executionScenarios"]; referenceValuation?:SelectedStructure["referenceValuation"];
 delayedExecution?:JsonValue; modeledExecution?:JsonValue;
 marginSnapshot:JsonValue; evidenceTradeSnapshots?:JsonValue[]; evidenceUsages?:SelectedStructure["evidenceUsages"];
 statusLayers?:JsonValue; versions:Partial<Record<DerivedLayer,string>>;
}
export type ResearchRecomputeEngine=(input:Readonly<{eventId:string;sourceRun:JsonValue;generationSnapshot:ResearchSelectionStore["events"][number]["generationSnapshot"];structure:Readonly<SelectedStructure>}>)=>Promise<DerivedResearchOutput>;

const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const placeholder=(v:unknown)=>{const o=object(v),raw=String(o.reason??""),reason=raw.toLowerCase();return raw===LEGACY_MARGIN_NOT_COMPUTED_REASON||o.reasonCode==="margin_not_recomputed"||o.status==="not_evaluated"&&(/placeholder|not supported by this generated run|no .* execution was performed|feature did not exist|not implemented/.test(reason));};

export interface DerivedStaleness {stale:boolean;layers:Partial<Record<DerivedLayer,string[]>>}
/** Deterministic diagnostics distinguish an engine-attempted unavailable result from a never-run placeholder. */
export function diagnoseDerivedStaleness(structure:SelectedStructure,current:Partial<Record<DerivedLayer,string>>=CURRENT_RESEARCH_ENGINE_VERSIONS):DerivedStaleness{
 const layers:Partial<Record<DerivedLayer,string[]>>={};
 const add=(layer:DerivedLayer,reason:string)=>(layers[layer]??=[]).push(reason);
 const snapshots:Partial<Record<DerivedLayer,unknown>>={immediateExecution:structure.executionScenarios,referenceValuation:structure.referenceValuation,delayedExecution:structure.delayedExecution,modeledExecution:structure.modeledExecution,margin:structure.marginSnapshot};
 for(const layer of Object.keys(current) as DerivedLayer[]){
  const version=structure.derivedVersions?.[layer];
  if(!version)add(layer,"missing_engine_version"); else if(version!==current[layer])add(layer,"engine_version_mismatch");
  const snapshot=snapshots[layer];
  if(layer==="immediateExecution"){
   for(const mode of ["maker","taker"] as const)if(placeholder(object(snapshot)[mode]))add(layer,`${mode}_placeholder`);
  }else if(snapshot!==undefined&&placeholder(snapshot))add(layer,"placeholder_snapshot");
  if(layer==="modeledExecution")for(const mode of ["expected","conservative"] as const)if(placeholder(object(snapshot)[mode]))add(layer,`${mode}_placeholder`);
 }
 return{stale:Object.keys(layers).length>0,layers};
}

const selected=(scope:RefreshScope,eventId:string,candidateId:string)=>scope.kind==="all"||(scope.kind==="event"&&scope.eventId===eventId)||(scope.kind==="structure"&&scope.eventId===eventId&&scope.candidateId===candidateId);
/**
 * Recomputes into a detached draft. Structural fields and exact contracts are
 * copied from the saved selection, never accepted from an engine result. If
 * any engine call fails, no store is returned and the caller persists nothing.
 */
export async function recomputeSelectedResearch(store:ResearchSelectionStore,scope:RefreshScope,engine:ResearchRecomputeEngine,now=new Date().toISOString()):Promise<{store:ResearchSelectionStore;refreshed:number}>{
 let refreshed=0;
 const events=[] as ResearchSelectionStore["events"];
 for(const event of store.events){const structures=[] as SelectedStructure[];for(const structure of event.selectedStructures){
  if(!selected(scope,event.eventId,structure.candidateId)){structures.push(structure);continue;}
  const output=await engine({eventId:event.eventId,sourceRun:event.sourceRun,generationSnapshot:event.generationSnapshot,structure});
  const referenceValuation=output.referenceValuation;
  const recomputedStructure={...structure,referenceValuation};structures.push({...structure,executionScenarios:output.executionScenarios,referenceValuation,delayedExecution:canonicalJson(output.delayedExecution),modeledExecution:output.modeledExecution??buildModeledExecution(referenceValuation),marginSnapshot:buildResearchMarginSnapshot(recomputedStructure),evidenceTradeSnapshots:output.evidenceTradeSnapshots?.map(canonicalJson),evidenceUsages:output.evidenceUsages,statusLayers:canonicalJson(output.statusLayers),derivedVersions:{...output.versions,modeledExecution:CURRENT_RESEARCH_ENGINE_VERSIONS.modeledExecution},derivedRefreshedAtUtc:now});refreshed++;
 }events.push({...event,selectedStructures:structures});}
 if(scope.kind!=="all"&&refreshed===0)throw new Error("No saved selected structure matched the requested refresh scope.");
 return{store:{...store,updatedAtUtc:now,events:events.map(compactResearchSelectionEvent)},refreshed};
}
