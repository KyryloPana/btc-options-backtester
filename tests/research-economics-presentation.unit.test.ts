import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const component=await readFile(new URL("../app/components/research-economic-matrix-report.tsx",import.meta.url),"utf8");
const nav=await readFile(new URL("../app/components/research-section-nav.tsx",import.meta.url),"utf8");
const shell=await readFile(new URL("../app/components/shell/research-analytics.tsx",import.meta.url),"utf8");

test("Comparative Economics follows Exit Policy and precedes Diagnostics only in Research navigation",()=>{const research=nav.slice(nav.indexOf("RESEARCH_SECTION_LINKS"),nav.indexOf("ECONOMICS_SECTION_LINKS")),index=research.indexOf(`id:"research-economics"`);assert.ok(research.indexOf(`id:"research-exit"`)<index);assert.ok(index<research.indexOf(`id:"research-workbench"`));assert.doesNotMatch(nav.slice(nav.indexOf("ECONOMICS_SECTION_LINKS")),/id:"research-economics"/)});
test("Research section is mounted between Exit Policy and Diagnostics",()=>{const exit=shell.indexOf('id="research-exit"'),economics=shell.indexOf('id="research-economics"'),audit=shell.indexOf('id="research-workbench"');assert.ok(exit<economics&&economics<audit);assert.match(shell,/ResearchEconomicMatrixReport dataset=\{d!\} researchExitPolicy=\{researchExitPolicy\}/)});
test("Q50 is local initial view and track changes cannot mutate Strategy configuration",()=>{assert.match(component,/useState<ResearchExecutionTrack>\("modeled_expected"\)/);assert.doesNotMatch(component,/setConfiguration|configuration\.exitPolicy|selectedStructuralConfigurationId/)});
test("currency rendering forbids fallback and missing values remain Unavailable",()=>{assert.match(component,/MonetaryValue usd=\{usd\} btc=\{btc\} allowFallback=\{false\}/);assert.match(component,/v===null\?"Unavailable"/);assert.doesNotMatch(component,/\?\?\s*0[^)]*MonetaryValue/)});
test("full matrix is collapsed, unranked, and interaction cells are accessible",()=>{assert.match(component,/<details className="exit-panel research-economics-full-matrix">/);assert.doesNotMatch(component,/best configuration|winner|ranking score/i);assert.match(component,/aria-label=\{`\$\{interaction\.replaceAll/);assert.match(component,/tabIndex=\{0\}/);assert.match(component,/role="img"/)});
test("Comparative Economics styles constrain grids and tables locally",async()=>{const css=await readFile(new URL("../app/globals.css",import.meta.url),"utf8");assert.match(css,/\.research-economics-panel-grid/);assert.match(css,/\.research-economics-heatmap/);assert.match(css,/overflow:hidden/);assert.match(css,/@media\(max-width:800px\)/)});
