import test from "node:test";
import assert from "node:assert/strict";
import { readFile as readTextFile } from "node:fs/promises";
import {buildResearchSummary} from "../app/lib/research-report.ts";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/analysis-configuration.ts";

const dataset={filename:"fixture.zip",schemaVersion:"2.0.0",migratedFrom:null,run:Object.freeze({dataset_id:"ds-audit",bundle_id:"bundle-audit"}),tables:Object.freeze({events:Object.freeze([]),availability:Object.freeze([]),candidates:Object.freeze([]),underlying_path:Object.freeze([]),valuations:Object.freeze([]),outcomes:Object.freeze([]),margin_scenarios:Object.freeze([]),futures_path:Object.freeze([])}),counts:Object.freeze({tradeDatasetMrEvents:5,selectedCandidates:0,denominator:5}),venues:Object.freeze(["DERIBIT"]),sourceRuns:Object.freeze(["source-one"]),eventUniverseComplete:true,capabilities:Object.freeze([])} as unknown as AnalysisDataset;
const configuration={...DEFAULT_ANALYSIS_CONFIGURATION,pricingTrack:"raw_vwap" as const,executionAssumption:"maker",includedQualityLevels:["green"],exitPolicy:"settlement",trainingEndTimestampUtc:"2025-01-01T00:00:00.000Z",accountEquity:100000,maximumRiskPerTrade:.01,maximumMarginUtilization:.2,dteMinimumDays:1,dteMaximumDays:30,maximumTailLossRiskUnits:1,maximumDrawdown:.2};

test("executive summary identity is deterministic and derived only from the canonical bundle",()=>{
 const a=buildResearchSummary(dataset,configuration),b=buildResearchSummary(dataset,configuration);
 assert.equal(a.identity.analysisRunId,b.identity.analysisRunId);
 assert.match(a.identity.analysisRunId,/^analysis-[0-9a-f]{8}$/);
 assert.equal(a.identity.datasetId,"ds-audit");
 assert.equal(a.identity.bundleId,"bundle-audit");
 assert.deepEqual([...a.identity.sourceRunIds],["source-one"]);
 assert.equal(a.sufficiency.state,"available");
 assert.equal(a.sufficiency.detail,"0 selected candidates / 5 generated opportunities");
 // A different locked configuration must be a distinct, reproducible analysis run.
 assert.notEqual(a.identity.analysisRunId,buildResearchSummary(dataset,{...configuration,accountEquity:1}).identity.analysisRunId);
});

test("research analytics exposes only the retained sections plus Underlying Resolution and Duration & DTE",async()=>{
 const component=await readTextFile(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");
 // Strike/width/exit-policy/futures/portfolio downstream analytics stay
 // deleted; Underlying Resolution and Duration & DTE were deliberately
 // rebuilt on the canonical bundle, the latter reusing the former's
 // resolution semantics rather than a competing report.
 for(const gone of ["StructurePolicyEconomicsReport","PortfolioStrategyReport","createResearchPdf","report-nav"])
  assert.doesNotMatch(component,new RegExp(gone),`${gone} must not be referenced`);
 assert.match(component,/Executive Summary/);
 assert.match(component,/AnalysisConfigurationForm/);
 assert.match(component,/UnderlyingResolutionReportView/);
 assert.match(component,/DurationDteReportView/);
});

test("research ZIP import is delegated to a module worker with immediate loading state",async()=>{
 const component=await readTextFile(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");
 const client=await readTextFile(new URL("../app/lib/research-analysis-worker-client.ts",import.meta.url),"utf8");
 assert.match(component,/setImporting\(true\)/);
 assert.match(component,/createResearchImportWorker\(\)/);
 assert.doesNotMatch(component,/importResearchBundle\(/);
 assert.match(component,/requestId\.current\+\+/);
 assert.match(client,/new Worker\(new URL\("\.\.\/workers\/research-import\.worker\.ts",import\.meta\.url\),\{type:"module"\}\)/);
});
