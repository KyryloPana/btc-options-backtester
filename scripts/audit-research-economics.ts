import {readFileSync,statSync,writeFileSync} from "node:fs";
import {basename,join} from "node:path";
import {strToU8,zipSync} from "fflate";
import {importResearchBundle} from "../app/lib/research-analysis.ts";
import {RESEARCH_BUNDLE_FILES} from "../app/lib/research-bundle.ts";
import {buildResearchEconomicsForensicAudit} from "../app/lib/research-economics/forensic-audit.ts";
import {buildResearchEconomicsReport,configurationEvidenceStatus} from "../app/lib/research-economics/report.ts";

const input=process.argv[2];
const outputIndex=process.argv.indexOf("--output");
const output=outputIndex>=0?process.argv[outputIndex+1]:null;
const acceptance=process.argv.includes("--acceptance");
if(!input)throw new Error("Usage: npm run audit:research-economics -- <bundle-directory-or-zip> [--acceptance] [--output audit.json]");

let bytes:Uint8Array;
if(statSync(input).isDirectory()){
 const files:Record<string,Uint8Array>={};
 for(const name of RESEARCH_BUNDLE_FILES)files[name]=strToU8(readFileSync(join(input,name),"utf8"));
 bytes=zipSync(files);
}else bytes=readFileSync(input);

const imported=importResearchBundle(bytes,basename(input));
if(imported.status==="invalid")throw new Error(`Bundle import failed:\n${imported.errors.join("\n")}`);
const audit=buildResearchEconomicsForensicAudit(imported.dataset);
if(acceptance){
 const reports={reference:buildResearchEconomicsReport(imported.dataset,"thesis","reference"),q50:buildResearchEconomicsReport(imported.dataset,"thesis","modeled_expected"),q90:buildResearchEconomicsReport(imported.dataset,"thesis","modeled_conservative")},opportunities=reports.q50.canonicalOpportunities,intended=new Set(opportunities.filter(row=>row.q50GenerationStatus==="trade").map(row=>`${row.eventId}|${row.structuralConfigurationId}`)).size,attempted=new Set(opportunities.map(row=>`${row.eventId}|${row.structuralConfigurationId}`)).size,coverage=(report:typeof reports.q50)=>report.configurations.reduce((n,row)=>n+row.trackCoverage.pricedOpportunityN,0),compact=reports.q50.diagnostics,reconciled=compact.integrityAffectedIdentityN===audit.summary.integrityAffectedIdentityCount&&compact.integrityAffectedConfigurationN===audit.summary.integrityAffectedStructuralConfigurationCount&&JSON.stringify(compact.integrityReasons.map(row=>[row.reason,row.affectedIdentityKeys]))===JSON.stringify(audit.integrityReasonDistribution.map(row=>[row.reason,row.identities]))&&JSON.stringify(compact.q50UnavailableReasons.map(row=>[row.reason,row.affectedIdentityKeys]))===JSON.stringify(audit.q50UnavailableReasonDistribution.map(row=>[row.reasonCode,row.identities])),assessments=reports.q50.configurations.map(configurationEvidenceStatus),margin={complete:assessments.filter(row=>row.marginCapability==="complete").length,partial:assessments.filter(row=>row.marginCapability==="partial").length,unavailable:assessments.filter(row=>row.marginCapability==="unavailable").length},comparisons=Object.fromEntries((["dte","strike","width"] as const).map(dimension=>{const rows=reports.q50.matched[dimension];return[dimension,{eligiblePairN:rows.reduce((n,row)=>n+row.eligiblePairUniverseN,0),pricedBothN:rows.reduce((n,row)=>n+row.pricedBothN,0),pnlEffectivePairedN:rows.reduce((n,row)=>n+row.metrics.pnl.btc.effectivePairedN,0)}]})),tail={independentPricedN:Math.max(0,...reports.q50.configurations.map(row=>row.q50.tailPricedN)),requiredMinimum:Math.max(20,...reports.q50.configurations.map(row=>row.q50.tailMinimum))},summary={status:audit.summary.integrityAffectedIdentityCount===0&&reconciled?"PASS":"FAIL",dataset:{mrEventN:new Set(opportunities.map(row=>row.eventId)).size,canonicalAttemptedOpportunityN:attempted,structuralConfigurationN:new Set(opportunities.map(row=>row.structuralConfigurationId)).size},generation:{q50IntendedTradeN:intended,q50ExplicitNoTradeN:new Set(opportunities.filter(row=>row.q50GenerationStatus==="explicit_no_trade").map(row=>`${row.eventId}|${row.structuralConfigurationId}`)).size,q50UnavailableN:new Set(opportunities.filter(row=>row.q50GenerationStatus==="unavailable").map(row=>`${row.eventId}|${row.structuralConfigurationId}`)).size,unavailableReasons:compact.q50UnavailableReasons},trackCoverage:{reference:{priced:coverage(reports.reference),eligible:attempted},q50:{priced:coverage(reports.q50),intendedTrade:intended,allAttempted:attempted},q90:{priced:coverage(reports.q90),eligible:attempted}},integrity:{affectedIdentityN:audit.summary.integrityAffectedIdentityCount,affectedConfigurationN:audit.summary.integrityAffectedStructuralConfigurationCount,reasons:compact.integrityReasons,currentSchemaInvariants:audit.summary.integrityAffectedIdentityCount===0?"PASS":"FAIL"},policy:Object.fromEntries(reports.q50.exitPolicies.map(row=>[row.policy.id,{priced:row.coverage.pricedOpportunityN,eligible:row.coverage.eligibleOpportunityN}])),margin,controlledComparisons:comparisons,tail,diagnosticsReconciliation:reconciled?"PASS":"FAIL"};process.stdout.write(`Research Comparative Economics acceptance: ${summary.status}\n${JSON.stringify(summary,null,2)}\n`);if(summary.status!=="PASS")process.exitCode=1;
}else{const serialized=`${JSON.stringify(audit,null,2)}\n`;if(output)writeFileSync(output,serialized,"utf8");else process.stdout.write(serialized)}
