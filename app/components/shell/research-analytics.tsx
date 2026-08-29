"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import type {ImportResult} from "../../lib/research-analysis";
import {createResearchImportWorker,type ImportStage,type WorkerImportMessage} from "../../lib/research-analysis-worker-client";
import {DEFAULT_ANALYSIS_CONFIGURATION,type AnalysisConfiguration} from "../../lib/analysis-configuration";
import {AnalysisConfigurationForm} from "../analysis-configuration-form";
import {buildResearchSummary} from "../../lib/research-report";
import {buildUnderlyingResolutionReport} from "../../lib/underlying-resolution/report";
import {UnderlyingResolutionReportView} from "../underlying-resolution-report";
import {buildDurationDteReport} from "../../lib/duration-dte/report";
import {DurationDteReportView} from "../duration-dte-report";
import {buildShortStrikeReport} from "../../lib/short-strike/report";
import {ShortStrikeReportView} from "../short-strike-report";
import {buildSpreadWidthReport} from "../../lib/spread-width/report";
import {SpreadWidthReportView} from "../spread-width-report";
import {buildExitPolicyReport} from "../../lib/exit-policy/report";
import {ExitPolicyReportView} from "../exit-policy-report";
import {buildEconomicReport} from "../../lib/economics/report";
import {EconomicAnalysisReportView} from "../economic-analysis-report";
import {buildFuturesComparisonReport} from "../../lib/futures-comparison/report";
import {FuturesComparisonReportView} from "../futures-comparison-report";
import {ResearchAnalyticsWorkbench} from "../research-analytics-workbench";
import {AnalyticalTrackLegend} from "../analytical-track-legend";
import {buildResearchAnalyticsModel} from "../../lib/research-analytics-model";
import {buildVolatilityReport} from "../../lib/volatility/volatility-report";
import {VolatilityReportView} from "../volatility-report";

/**
 * Duration & DTE is NOT a maker report. Its structural timing, actual DTE and
 * thesis-resolution analyses are execution-independent and have their own
 * denominator. This is the display scenario for the report's explicitly
 * execution-dependent subsections only -- scenario coverage, leg
 * synchronization and the operational holding period -- and the report states
 * that scope itself rather than implying the whole report is maker.
 */
const DURATION_DISPLAY_SCENARIO="maker" as const;

export function ResearchAnalytics(){
 const [bundle,setBundle]=useState<File>(),[companion,setCompanion]=useState<File>(),[result,setResult]=useState<ImportResult>(),[importing,setImporting]=useState(false),[stage,setStage]=useState<ImportStage>(),[configuration,setConfiguration]=useState<AnalysisConfiguration>(DEFAULT_ANALYSIS_CONFIGURATION),input=useRef<HTMLInputElement>(null),workerRef=useRef<Worker|null>(null),requestId=useRef(0);
 useEffect(()=>()=>workerRef.current?.terminate(),[]);
 async function load(b=bundle,c=companion){if(!b)return;const id=++requestId.current;setImporting(true);setStage("reading-archive");setResult(undefined);try{const [bytes,companionText]=await Promise.all([b.arrayBuffer(),c?.text()]);workerRef.current?.terminate();const worker=createResearchImportWorker();workerRef.current=worker;worker.onmessage=(event:MessageEvent<WorkerImportMessage>)=>{const msg=event.data;if(msg.id!==requestId.current)return;if(msg.type==="stage")setStage(msg.stage);else{setResult(msg.result);setImporting(false);setStage(undefined);worker.terminate();if(workerRef.current===worker)workerRef.current=null;}};worker.onerror=()=>{if(id===requestId.current){setResult({status:"invalid",errors:["Research bundle worker failed."]});setImporting(false);setStage(undefined)}};worker.postMessage({id,bytes:new Uint8Array(bytes),filename:b.name,companionText},[bytes]);}catch(error){if(id===requestId.current){setResult({status:"invalid",errors:[error instanceof Error?error.message:"Research bundle import failed."]});setImporting(false);setStage(undefined)}}}
 function choose(file?:File){requestId.current++;setBundle(file);setResult(undefined);setStage(undefined);if(file)void load(file,companion)}
 const d=result&&result.status!=="invalid"?result.dataset:undefined;
 const durationConfiguration=useMemo(()=>({...DEFAULT_ANALYSIS_CONFIGURATION,pricingTrack:configuration.pricingTrack,includedQualityLevels:configuration.includedQualityLevels,exitPolicy:configuration.exitPolicy,capitalBasis:configuration.capitalBasis}),[configuration.pricingTrack,configuration.includedQualityLevels,configuration.exitPolicy,configuration.capitalBasis]);
 const exitConfiguration=useMemo(()=>({...DEFAULT_ANALYSIS_CONFIGURATION,exitPolicy:configuration.exitPolicy,nearFullLossFraction:configuration.nearFullLossFraction}),[configuration.exitPolicy,configuration.nearFullLossFraction]);
 const economicConfiguration=useMemo(()=>({...DEFAULT_ANALYSIS_CONFIGURATION,exitPolicy:configuration.exitPolicy,marginModel:configuration.marginModel,collateralMode:configuration.collateralMode,accountEquity:configuration.accountEquity,maximumRiskFraction:configuration.maximumRiskFraction,maximumMarginUtilization:configuration.maximumMarginUtilization}),[configuration.exitPolicy,configuration.marginModel,configuration.collateralMode,configuration.accountEquity,configuration.maximumRiskFraction,configuration.maximumMarginUtilization]);
 const summary=useMemo(()=>d?buildResearchSummary(d,configuration):undefined,[d,configuration]),underlying=useMemo(()=>d?buildUnderlyingResolutionReport(d):undefined,[d]),volatility=useMemo(()=>d?buildVolatilityReport(d):undefined,[d]),
durationDte=useMemo(()=>d?buildDurationDteReport(d,DURATION_DISPLAY_SCENARIO,durationConfiguration):undefined,[d,durationConfiguration]),
 shortStrike=useMemo(()=>d?buildShortStrikeReport(d):undefined,[d]),
 analytics=useMemo(()=>d?buildResearchAnalyticsModel(d):undefined,[d]),spreadWidth=useMemo(()=>d?buildSpreadWidthReport(d):undefined,[d]),exitPolicy=useMemo(()=>d?buildExitPolicyReport(d,exitConfiguration):undefined,[d,exitConfiguration]),economics=useMemo(()=>d?buildEconomicReport(d,economicConfiguration):undefined,[d,economicConfiguration]),
 futures=useMemo(()=>d?buildFuturesComparisonReport(d):undefined,[d]);
 return <section className="research-import" aria-labelledby="research-analytics-title"><p className="shell-eyebrow">Options Lab · Canonical research bundle</p><h1 id="research-analytics-title">Research Analytics</h1><p className="import-intro">One immutable analysis result powers the workspace. Validation is local; no exchange requests are made.</p>
 <div className="drop-zone" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();choose(e.dataTransfer.files[0])}}><input ref={input} hidden type="file" accept=".zip,application/zip" onChange={e=>choose(e.target.files?.[0])}/><strong>Drop research-bundle ZIP here</strong><button onClick={()=>input.current?.click()}>Choose bundle</button></div><div className="import-controls"><label>Optional canonical trade dataset<input type="file" accept=".json,application/json" onChange={e=>{const f=e.target.files?.[0];setCompanion(f);if(bundle)void load(bundle,f)}}/></label>{bundle&&<><span>{bundle.name}</span><button disabled={importing} onClick={()=>void load()}>Reload</button><button onClick={()=>{requestId.current++;workerRef.current?.terminate();setBundle(undefined);setCompanion(undefined);setResult(undefined);setImporting(false);setStage(undefined)}}>Remove</button></>}</div>
 {importing&&<div className="preflight degraded" aria-live="polite"><h2>Importing research bundle…</h2><p>{stage?.replaceAll("-"," ")??"Preparing import"}</p></div>}
 {result&&<div className={`preflight ${result.status}`}><h2>{result.status==="ready"?"Ready for analysis":result.status==="degraded"?"Degraded":"Invalid"}</h2>{result.status==="invalid"?<ul>{result.errors.slice(0,8).map(x=><li key={x}>{x}</li>)}</ul>:<><dl><dt>Dataset / bundle</dt><dd>{String(d!.run.dataset_id)} / {String(d!.run.bundle_id??d!.run.run_id)}</dd><dt>Venues</dt><dd>{d!.venues.join(", ")||"none"}</dd><dt>Source runs</dt><dd>{d!.sourceRuns.join(", ")||"none"}</dd><dt>Selected / denominator</dt><dd>{d!.counts.selectedCandidates} / {d!.counts.denominator}</dd><dt>Event universe</dt><dd>{d!.eventUniverseComplete?"Complete":"Incomplete"}</dd></dl>{result.warnings.map(x=><p className="preflight-warning" key={x}>{x}</p>)}<div className="count-grid">{Object.entries(d!.counts).map(([k,v])=><span key={k}><b>{v}</b>{k.replaceAll(/([A-Z])/g," $1")}</span>)}</div><div className="capability-table">{d!.capabilities.map(c=><div key={c.id}><strong>{c.label}</strong><em className={c.status}>{c.status}</em><small>{c.missingInputs.length?`Missing: ${c.missingInputs.join(", ")}`:`${c.affectedEventCount} events · ${c.affectedCandidateCount} candidates`}</small></div>)}</div></>}</div>}
 {summary&&<><section id="report-summary" className="workspace-section"><div className="section-heading"><div><p className="eyebrow">Deterministic analysis {summary.identity.analysisRunId}</p><h2>Executive Summary &amp; Data Sufficiency</h2></div><em className={`report-state ${summary.sufficiency.state}`}>{summary.sufficiency.state}</em></div><p className="resolution-banner">{summary.sufficiency.detail}. Unavailable candidates, unresolved events and no-trade opportunities remain visible and in the opportunity denominator.</p><dl><dt>Dataset</dt><dd>{summary.identity.datasetId}</dd><dt>Bundle</dt><dd>{summary.identity.bundleId}</dd><dt>Source runs</dt><dd>{summary.identity.sourceRunIds.join(", ")||"none"}</dd><dt>Event universe</dt><dd>{d!.eventUniverseComplete?"Complete":"Incomplete"}</dd></dl>{analytics&&<div className="count-grid" data-testid="data-sufficiency-counts"><span><b>{new Set(analytics.observations.map(o=>o.eventId)).size}</b>MR events</span><span><b>{analytics.denominators.generatedOpportunities}</b>Generated opportunities</span><span><b>{analytics.denominators.contractResolved}</b>Structurally resolved/listed</span><span><b>{analytics.denominators.referenceValued}</b>Reference valued</span><span><b>{analytics.denominators.immediateMakerSupported}</b>Immediate Maker supported</span><span><b>{analytics.denominators.immediateTakerSupported}</b>Immediate Taker supported</span><span><b>{Object.values(analytics.denominators.delayedSupported).reduce((a,b)=>a+b,0)}</b>Delayed supported</span><span><b>{analytics.denominators.modeledValued}</b>Modeled supported</span><span><b>{analytics.denominators.fullyUnavailable}</b>Fully unavailable</span></div>}</section>
 <section className="global-controls"><h2>Global controls</h2><p><b>Source run:</b> {summary.identity.sourceRunIds.join(", ")||"not configured"} · <b>Venue:</b> {d!.venues.join(", ")||"not configured"}. Source runs are displayed as isolated bundle provenance and are never silently pooled.</p></section><AnalyticalTrackLegend/><AnalysisConfigurationForm value={configuration} onChange={setConfiguration}/>{underlying&&<UnderlyingResolutionReportView report={underlying}/>} {volatility&&<VolatilityReportView report={volatility}/>} {durationDte&&<DurationDteReportView report={durationDte} volatility={volatility}/>}{shortStrike&&<ShortStrikeReportView report={shortStrike} volatility={volatility}/>}{spreadWidth&&<SpreadWidthReportView report={spreadWidth} volatility={volatility}/>} {exitPolicy&&<ExitPolicyReportView report={exitPolicy} volatility={volatility}/>} {economics&&<EconomicAnalysisReportView report={economics} volatility={volatility}/>} {futures&&<FuturesComparisonReportView report={futures}/>}<ResearchAnalyticsWorkbench dataset={d!} analytics={analytics}/></>}
 </section>
}
