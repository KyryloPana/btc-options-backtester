import type {AnalysisDataset} from "./research-analysis.ts";
import type {AnalysisConfiguration} from "./analysis-configuration.ts";

/**
 * Executive Summary & Data Sufficiency.
 *
 * This module deliberately performs no analysis. It derives provenance identity and a sufficiency
 * statement directly from the canonical research bundle, so the retained summary never depends on
 * an analytical layer. Future analytics are expected to consume the canonical dataset directly
 * rather than extend this module.
 */
export type SufficiencyState="available"|"degraded";
export interface ResearchIdentity {readonly datasetId:string;readonly bundleId:string;readonly sourceRunIds:readonly string[];readonly analysisRunId:string}
export interface ResearchSummary {readonly dataset:AnalysisDataset;readonly identity:ResearchIdentity;readonly sufficiency:{readonly state:SufficiencyState;readonly detail:string}}

const hash=(s:string)=>{let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0).toString(16).padStart(8,"0")};

/**
 * `analysisRunId` stays keyed on dataset, bundle, source runs and the locked configuration so a
 * configuration change is still a distinct, reproducible analysis run.
 */
export function buildResearchSummary(dataset:AnalysisDataset,configuration:AnalysisConfiguration):ResearchSummary{
 const datasetId=String(dataset.run.dataset_id??"unknown-dataset"),
  bundleId=String(dataset.run.bundle_id??dataset.run.run_id??"unknown-bundle"),
  analysisRunId=`analysis-${hash(JSON.stringify({datasetId,bundleId,sourceRuns:dataset.sourceRuns,configuration}))}`;
 return Object.freeze({
  dataset,
  identity:Object.freeze({datasetId,bundleId,sourceRunIds:Object.freeze([...dataset.sourceRuns]),analysisRunId}),
  sufficiency:Object.freeze({
   state:dataset.eventUniverseComplete?"available":"degraded" as SufficiencyState,
   detail:`${dataset.counts.selectedCandidates} selected candidates / ${dataset.counts.denominator} generated opportunities`,
  }),
 });
}
