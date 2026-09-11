import assert from "node:assert/strict";
import test from "node:test";
import {buildResearchBundle,RESEARCH_BUNDLE_SCHEMA_VERSION} from "../app/lib/research-bundle.ts";
import {importResearchBundle} from "../app/lib/research-analysis.ts";
import {projectResearchEconomicObservations} from "../app/lib/research-economics/project.ts";
import {buildResearchEconomicsReport} from "../app/lib/research-economics/report.ts";
import {createResearchBundleZip} from "../scripts/research-bundle-service.ts";
import {now,store} from "./fixtures/research-selection-store.ts";

test("schema 4.5 exporter → ZIP → importer → Comparative Economics preserves denominator and evidence states",()=>{
 assert.equal(RESEARCH_BUNDLE_SCHEMA_VERSION,"4.5.0");
 const exported=buildResearchBundle(structuredClone(store),now),imported=importResearchBundle(createResearchBundleZip(exported.files),"comparative-economics.zip");
 assert.notEqual(imported.status,"invalid");if(imported.status==="invalid")return;
 assert.equal(imported.dataset.schemaVersion,"4.5.0");
 const opportunityN=imported.dataset.tables.configuration_opportunities.length,noExit=projectResearchEconomicObservations(imported.dataset,null),thesis=projectResearchEconomicObservations(imported.dataset,"thesis"),report=buildResearchEconomicsReport(thesis,{researchExitPolicy:"thesis"});
 assert.ok(opportunityN>0,"fixture must export the canonical event × configuration denominator");
 assert.equal(noExit.length,opportunityN*3,"no-exit projection is one row per opportunity and analytical layer");
 assert.equal(thesis.length,opportunityN*3,"selected exit does not change the authoritative opportunity denominator");
 assert.equal(report.population.eligibleOpportunities,opportunityN,"one displayed layer retains the exact opportunity denominator");
 assert.equal(new Set(thesis.map(row=>`${row.eventId}|${row.structuralConfigurationId}|${row.analyticalTrack}`)).size,thesis.length);
 assert.ok(thesis.every(row=>row.generationOpportunityStatus!==undefined),"projection preserves the generation/Q50 opportunity state independently of layer evidence");
 assert.ok(thesis.some(row=>row.coverageStatus==="unavailable"));
 assert.ok(thesis.filter(row=>row.netOpeningCreditUsd===null).every(row=>row.metricAvailability.netOpeningCreditUsd!==null));
 assert.equal(report.population.generationTradeOpportunities+report.population.generationExplicitNoTradeOpportunities+report.population.generationUnavailableOpportunities,opportunityN);
});
