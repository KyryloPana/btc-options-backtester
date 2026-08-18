import test from "node:test";
import assert from "node:assert/strict";
import {buildResearchReport,createResearchPdf} from "../app/lib/research-report.ts";
import type {AnalysisDataset} from "../app/lib/research-analysis.ts";
import {DEFAULT_ANALYSIS_CONFIGURATION} from "../app/lib/portfolio-strategy-analysis.ts";

const dataset={filename:"fixture.zip",schemaVersion:"2.0.0",migratedFrom:null,run:Object.freeze({dataset_id:"ds-audit",bundle_id:"bundle-audit"}),tables:Object.freeze({events:Object.freeze([]),availability:Object.freeze([]),candidates:Object.freeze([]),underlying_path:Object.freeze([]),valuations:Object.freeze([]),outcomes:Object.freeze([]),margin_scenarios:Object.freeze([]),futures_path:Object.freeze([])}),counts:Object.freeze({tradeDatasetMrEvents:5,selectedCandidates:0,denominator:5}),venues:Object.freeze(["DERIBIT"]),sourceRuns:Object.freeze(["source-one"]),eventUniverseComplete:true,capabilities:Object.freeze([])} as unknown as AnalysisDataset;
const configuration={...DEFAULT_ANALYSIS_CONFIGURATION,pricingTrack:"raw_vwap" as const,executionAssumption:"maker",includedQualityLevels:["green"],exitPolicy:"settlement",trainingEndTimestampUtc:"2025-01-01T00:00:00.000Z",accountEquity:100000,maximumRiskPerTrade:.01,maximumMarginUtilization:.2,dteMinimumDays:1,dteMaximumDays:30,maximumTailLossRiskUnits:1,maximumDrawdown:.2};

test("one immutable result drives status taxonomy and deterministic real PDF",()=>{const a=buildResearchReport(dataset,configuration),b=buildResearchReport(dataset,configuration);assert.equal(a.identity.analysisRunId,b.identity.analysisRunId);assert.ok(a.sections.some(x=>x.state==="insufficient sample"));assert.equal(a.sections.find(x=>x.id==="futures")?.state,"unavailable");assert.equal(a.portfolio.portfolio.noTradeOpportunities,0);const at=new Date("2026-08-16T00:00:00.000Z"),x=createResearchPdf(a,at),y=createResearchPdf(a,at);assert.deepEqual(x,y);const text=new TextDecoder().decode(x);assert.match(text,/^%PDF-1\.4/);assert.match(text,/Dataset ID: ds-audit/);assert.match(text,/Analysis-run ID: analysis-/);assert.match(text,/Page 1 of/);assert.match(text,/xref/)});

import { readFile as readTextFile } from "node:fs/promises";

test("research ZIP import is delegated to a module worker with immediate loading state",async()=>{
 const component=await readTextFile(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");
 const client=await readTextFile(new URL("../app/lib/research-analysis-worker-client.ts",import.meta.url),"utf8");
 assert.match(component,/setImporting\(true\)/);
 assert.match(component,/createResearchImportWorker\(\)/);
 assert.doesNotMatch(component,/importResearchBundle\(/);
 assert.match(component,/requestId\.current\+\+/);
 assert.match(client,/new Worker\(new URL\("\.\.\/workers\/research-import\.worker\.ts",import\.meta\.url\),\{type:"module"\}\)/);
});
