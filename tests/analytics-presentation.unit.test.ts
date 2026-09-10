import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assessEconomicPositions,matchesAttentionFilter,summarizeAttention,ECONOMICS_TAIL_ATTENTION_MIN_N} from "../app/lib/analytics-attention.ts";
import type {PositionEconomics} from "../app/lib/economics/position.ts";

const position=(id:string,pnl:number|null,status:PositionEconomics["status"]="priced",reason:string|null=null)=>({candidateId:id,eventId:`event-${id}`,structureExecutionId:id,exitPolicy:"thesis",status,pnlBtc:pnl,missingReason:reason,trackMaximumNetLossBtc:{value:.1,reason:null},incrementalInitialMarginBtc:{value:.1,reason:null},peakInitialMarginBtc:{value:.1,reason:null},capitalDaysBtc:{value:.1,reason:null},maximumStructuralLossBtc:{value:.1,reason:null},maximumStructuralLossUsd:{value:5000,reason:null},trackMaximumNetLossUsd:{value:5000,reason:null},incrementalMaintenanceMarginBtc:{value:.05,reason:null},peakMaintenanceMarginBtc:{value:.05,reason:null},pnlUsd:pnl===null?null:pnl*50000,diagnosticCode:null} as PositionEconomics);

test("PRESENTATION: a losing valid observation is adverse economics, never invalid evidence",()=>{const rows=Array.from({length:ECONOMICS_TAIL_ATTENTION_MIN_N},(_,i)=>position(String(i),i-10)),map=assessEconomicPositions(rows),loss=map.get("0|thesis")!;assert.equal(loss.evidence,"VALID");assert.ok(loss.attention.some(x=>x.kind==="ADVERSE"));assert.ok(!loss.attention.some(x=>x.kind as string==="INVALID"))});
test("PRESENTATION: canonical invalidity and unavailable evidence stay distinct",()=>{const map=assessEconomicPositions([{...position("bad",1,"priced","Changed prose."),diagnosticCode:"pre_entry_outcome"},position("missing",null,"unavailable","Exit valuation unavailable.")]);assert.equal(map.get("bad|thesis")!.evidence,"INVALID");assert.equal(map.get("missing|thesis")!.evidence,"UNAVAILABLE")});
test("PRESENTATION: attention summary exactly counts detailed assessments",()=>{const rows=Array.from({length:20},(_,i)=>position(String(i),i)),map=assessEconomicPositions(rows),summary=summarizeAttention(map.values());assert.equal(summary.unusualAdverse,[...map.values()].filter(x=>x.attention.some(a=>a.kind==="UNUSUAL")&&x.attention.some(a=>a.kind==="ADVERSE")).length);assert.equal(summary.unusualFavorable,[...map.values()].filter(x=>x.attention.some(a=>a.kind==="UNUSUAL")&&x.attention.some(a=>a.kind==="FAVORABLE")).length);assert.ok(matchesAttentionFilter(map.get("0|thesis")!,"attention"));assert.ok(!matchesAttentionFilter(map.get("10|thesis")!,"attention"))});
test("PRESENTATION: Economics is summary-first and raw rows are a closed audit",()=>{const source=readFileSync(new URL("../app/components/economic-analysis-report.tsx",import.meta.url),"utf8");assert.ok(source.indexOf("economics-primary-kpis")<source.indexOf('title="Per-position details"'));assert.match(source,/<details className="exit-details economics-audit"/);assert.match(source,/Attention only/);assert.match(source,/aria-pressed/);assert.match(source,/x===null\?UNAVAILABLE/);assert.doesNotMatch(source,/[-−]\$0(?:\.0+)?/)});
test("PRESENTATION: shared badges expose textual accessibility labels",()=>{const source=readFileSync(new URL("../app/components/research-evidence-status.tsx",import.meta.url),"utf8");assert.match(source,/aria-label={`Evidence:/);assert.match(source,/aria-label={`Attention:/)});
test("PRESENTATION: large report audit datasets default collapsed while Exit Policy keeps its primary surface",()=>{for(const file of ["underlying-resolution-report.tsx","duration-dte-report.tsx","short-strike-report.tsx","spread-width-report.tsx","futures-comparison-report.tsx"]){const source=readFileSync(new URL(`../app/components/${file}`,import.meta.url),"utf8");assert.match(source,/<details[^>]*(?:exit-details|ur-block|dd-event-block)/,file);assert.match(source,/AuditAttentionControls/,`${file} exposes shared attention controls`)}const exit=readFileSync(new URL("../app/components/exit-policy-report.tsx",import.meta.url),"utf8");assert.match(exit,/Primary decision surface/);assert.match(exit,/Candidate and missing-data audit/)});

test("PRESENTATION: outcome-after-expiry is unavailable, not invalid by prose",()=>{const p={...position("late",null,"unavailable","after expiry wording"),diagnosticCode:"outcome_after_expiry"} as PositionEconomics;assert.equal(assessEconomicPositions([p]).get("late|thesis")!.evidence,"UNAVAILABLE")});
test("PRESENTATION: a fully observed no-resolution-before-expiry row is not partial solely for its outcome",()=>{const source=readFileSync(new URL("../app/components/duration-dte-report.tsx",import.meta.url),"utf8");const eventRow=source.slice(source.indexOf("function EventRow"),source.indexOf("function EventAudit"));assert.doesNotMatch(eventRow,/outcomeBeforeExpiry===\"no_resolution_before_expiry\"/);assert.match(eventRow,/capture50===null\|\|c\.worstAdverseUsd===null/)});

test("PRESENTATION: Research Analytics has one shared import boundary and nested evaluation tabs",()=>{
 const source=readFileSync(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");
 assert.equal(source.match(/accept="\.zip,application\/zip"/g)?.length,1,"one research-bundle ZIP input");
 assert.equal(source.match(/createResearchImportWorker\(\)/g)?.length,1,"one worker pipeline");
 assert.match(source,/useState<WorkspaceMode>\("research"\)/,"Research is the default mode");
 assert.match(source,/useState<EvaluationMode>\("economics"\)/,"Economics is the default evaluation");
 assert.match(source,/role="tablist"/);
 assert.match(source,/role="tab"/);
 assert.match(source,/aria-selected=/);
 assert.match(source,/Research Analytics mode/);
 assert.match(source,/Strategy evaluation report/);
 const tabs=source.slice(source.indexOf("function SegmentedTabs"),source.indexOf("const WORKSPACE_TABS"));
 assert.doesNotMatch(tabs,/\bload\s*\(/,"tab interaction never invokes bundle import");
 assert.doesNotMatch(tabs,/arrayBuffer|createResearchImportWorker|setResult/,"tab interaction neither reads nor resets the imported bundle");
 const research=source.slice(source.indexOf('workspaceMode==="research"'),source.indexOf('workspaceMode==="strategy"'));
 assert.doesNotMatch(research,/EconomicAnalysisReportView|FuturesComparisonReportView/);
 const strategy=source.slice(source.indexOf('workspaceMode==="strategy"'));
 assert.match(strategy,/EconomicAnalysisReportView report=/);
 assert.match(strategy,/FuturesComparisonReportView report=/);
});

test("PRESENTATION: scoped configuration controls edit only genuine report inputs",()=>{
 const research=readFileSync(new URL("../app/components/research-controls.tsx",import.meta.url),"utf8"),economics=readFileSync(new URL("../app/components/economics-policy-controls.tsx",import.meta.url),"utf8"),candidate=readFileSync(new URL("../app/components/candidate-configuration.tsx",import.meta.url),"utf8"),shell=readFileSync(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8"),benchmark=readFileSync(new URL("../app/components/futures-benchmark-scope.tsx",import.meta.url),"utf8");
 for(const field of ["pricingTrack","includedQualityLevels","capitalBasis","researchExitPolicy","nearFullLossFraction"])assert.match(research,new RegExp(field));
 for(const field of ["marginModel","collateralMode","accountEquity","maximumRiskFraction","maximumMarginUtilization","maximumDrawdown"])assert.doesNotMatch(research,new RegExp(field));
 for(const field of ["marginModel","collateralMode","accountEquity","maximumRiskFraction","maximumMarginUtilization"])assert.match(economics,new RegExp(field));
 assert.doesNotMatch(economics,/maximumDrawdown/,"an output-only configuration echo is not presented as an active policy input");
 assert.doesNotMatch(economics,/executionAssumption|capitalBasis/);
 assert.match(candidate,/set\("selectedStructuralConfigurationId"/);
 assert.match(candidate,/structuralConfigurationIdentity/);
 assert.match(candidate,/structuralConfigurationLabel/);
 assert.match(shell,/onSelectConfiguration=\{id=>setConfiguration\(current=>\(\{\.\.\.current,selectedStructuralConfigurationId:id\}\)\)\}/,"Economics cards update the same parent state");
 assert.equal(shell.match(/useState<AnalysisConfiguration>/g)?.length,1,"one shared configuration state survives all inner tabs");
 assert.equal(shell.match(/<CandidateConfiguration /g)?.length,1,"Candidate Configuration is persistent above both evaluation subtabs");
 assert.doesNotMatch(benchmark,/<select|<input|<button/,"Futures benchmark scope is read-only");
 assert.match(benchmark,/candidate policy does not rewrite it/i);
 for(const component of [research,economics,candidate,benchmark,readFileSync(new URL("../app/components/futures-comparison-report.tsx",import.meta.url),"utf8")])assert.doesNotMatch(component,/buildEconomicReport|buildFuturesComparisonReport|buildDurationDteReport/,"presentation components do not duplicate analytical builders");
});

test("PRESENTATION: research and candidate exit policies are isolated UI state",()=>{
 const shell=readFileSync(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8"),research=readFileSync(new URL("../app/components/research-controls.tsx",import.meta.url),"utf8");
 assert.match(shell,/useState<PrimaryExitPolicy\|null>\(null\)/);
 assert.match(shell,/exitPolicy:researchExitPolicy/,"Duration and Exit derive from the research-only policy");
 assert.match(shell,/exitPolicy:configuration\.exitPolicy/,"Economics derives from candidate policy");
 assert.match(research,/onResearchExitPolicyChange/);
 assert.doesNotMatch(research,/set\("exitPolicy"/,"Research controls cannot mutate candidate policy");
});

test("PRESENTATION: loaded workspaces expose ordered, responsive section navigation without import side effects",()=>{
 const nav=readFileSync(new URL("../app/components/research-section-nav.tsx",import.meta.url),"utf8"),shell=readFileSync(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8"),css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8");
 const researchIds=["research-summary","research-context","research-controls","research-underlying","research-volatility","research-duration","research-strike","research-spread","research-exit","research-workbench"],economicsIds=["strategy-dataset","strategy-candidate","strategy-account","strategy-economics"],futuresIds=["strategy-dataset","strategy-candidate","strategy-benchmark","strategy-futures"];
 const positions=(ids:string[])=>ids.map(id=>nav.indexOf(`id:\"${id}\"`));
 assert.ok(positions(researchIds).every((position,index,list)=>position>=0&&(index===0||position>list[index-1]!)),"Research links follow report order");
 assert.ok(positions(economicsIds).every(position=>position>=0));assert.ok(positions(futuresIds).every(position=>position>=0));
 for(const id of new Set([...researchIds,...economicsIds,...futuresIds]))assert.equal(shell.match(new RegExp(`id=\"${id}\"`,"g"))?.length,1,`${id} has one real anchor`);
 assert.match(shell,/summary&&workspaceMode/,"navigation is mounted only with loaded summary content");
 assert.doesNotMatch(nav,/\bload\s*\(|arrayBuffer|createResearchImportWorker|setResult/);
 assert.match(css,/grid-template-columns:190px minmax\(0,1fr\)/);assert.match(css,/\.analytics-section-content\{[^}]*min-width:0/);assert.match(css,/@media\(max-width:1180px\)/);assert.match(css,/overflow-x:auto/);
});

test("PRESENTATION: partial portfolio chronology is explicit and cannot present a required account",()=>{const source=readFileSync(new URL("../app/components/economic-analysis-report.tsx",import.meta.url),"utf8");assert.match(source,/Partial diagnostic chronology — account conclusions unavailable/);assert.match(source,/selectedPortfolio\.status==="partial"/)});
