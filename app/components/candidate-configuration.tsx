"use client";
import type {AnalysisConfiguration} from "../lib/analysis-configuration";
import type {AnalysisDataset} from "../lib/research-analysis";
import {structuralConfigurationIdentity,structuralConfigurationLabel,type StructuralConfigurationFields} from "../lib/economics/strategy-configuration";

const EXIT_POLICIES=["thesis","capture_50","capture_70","time_cap_3d","time_cap_5d","time_cap_7d","settlement_benchmark"] as const;
export interface CandidateConfigurationOption {id:string;fields:StructuralConfigurationFields;candidateIds:readonly string[]}
export interface CandidateConfigurationCatalog {options:readonly CandidateConfigurationOption[];unmappedCandidateIds:readonly string[]}

export function candidateConfigurationCatalog(dataset:AnalysisDataset):CandidateConfigurationCatalog{
 const byId=new Map<string,{fields:StructuralConfigurationFields;candidateIds:Set<string>}>(),unmapped:string[]=[];
 for(const row of dataset.tables.configuration_opportunities??[]){const identity=structuralConfigurationIdentity(row);if(identity.id&&!byId.has(identity.id))byId.set(identity.id,{fields:identity.fields,candidateIds:new Set<string>()})}
 for(const row of dataset.tables.candidates??[]){const candidateId=typeof row.candidate_id==="string"?row.candidate_id:null,identity=structuralConfigurationIdentity(row);if(!candidateId)continue;if(!identity.id){unmapped.push(candidateId);continue}const current=byId.get(identity.id)??{fields:identity.fields,candidateIds:new Set<string>()};current.candidateIds.add(candidateId);byId.set(identity.id,current)}
 return{options:[...byId].map(([id,item])=>({id,fields:item.fields,candidateIds:[...item.candidateIds]})).sort((a,b)=>structuralConfigurationLabel(a.fields).localeCompare(structuralConfigurationLabel(b.fields))),unmappedCandidateIds:[...new Set(unmapped)]};
}

export function CandidateConfiguration({catalog,value,onChange}:{catalog:CandidateConfigurationCatalog;value:AnalysisConfiguration;onChange:(next:AnalysisConfiguration)=>void}){
 const selected=catalog.options.find(option=>option.id===value.selectedStructuralConfigurationId);
 const set=<K extends keyof AnalysisConfiguration>(key:K,next:AnalysisConfiguration[K])=>onChange({...value,[key]:next});
 return <details className="candidate-configuration" data-testid="candidate-configuration" key={selected?.id??"unselected"} open={!selected}><summary><span><small>Candidate</small><strong>{selected?structuralConfigurationLabel(selected.fields):"Select a canonical structural configuration"}</strong><small>Exit: {value.exitPolicy??"not configured"}</small></span><span className="edit-configuration">{selected?"Edit configuration":"Configure"}</span></summary><div className="candidate-configuration-editor">
  {catalog.options.length?<label>Structural configuration<select value={value.selectedStructuralConfigurationId??""} onChange={event=>set("selectedStructuralConfigurationId",event.target.value||null)}><option value="">Select a canonical configuration</option>{catalog.options.map(option=><option key={option.id} value={option.id}>{structuralConfigurationLabel(option.fields)}</option>)}</select></label>:<p className="preflight-warning">Unavailable — no complete canonical structural configuration identity is present in this bundle.</p>}
  <label>Complete exit policy<small className="dd-note">Used by Economics. The Futures benchmark retains its exported canonical endpoint.</small><select value={value.exitPolicy??""} onChange={event=>set("exitPolicy",event.target.value as AnalysisConfiguration["exitPolicy"]||null)}><option value="">Required for Economics</option>{EXIT_POLICIES.map(policy=><option key={policy}>{policy}</option>)}</select></label>
  {catalog.unmappedCandidateIds.length>0&&<small className="metric-unavailable">Unmapped diagnostic: {catalog.unmappedCandidateIds.length} candidate{catalog.unmappedCandidateIds.length===1?"":"s"} lack a complete canonical structural configuration identity.</small>}
 </div></details>;
}
