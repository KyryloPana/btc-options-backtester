import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHART_GEOMETRY, CHART_SERIES, valuationChartTitle } from "../app/lib/valuation-chart.ts";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/options-backtester.tsx", import.meta.url), "utf8");

test("selected-analysis title follows the active chart tab", () => {
  assert.equal(valuationChartTitle("pnl"), "Estimated 4H valuation path · PnL · USD");
  assert.equal(valuationChartTitle("values"), "Estimated 4H valuation path · Contract values · BTC/contract");
  assert.match(page, /valuationChartTitle\(chartMetric\)/);
  assert.match(page, /onMetricChange=\{setChartMetric\}/);
});

test("selected-analysis grid and chart are shrinkable and contained", () => {
  assert.match(css, /\.analysis-detail\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(240px,\s*292px\)/s);
  assert.match(css, /\.analysis-detail\s*>\s*\*\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.mini-chart\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow:\s*hidden[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /\.mini-chart svg\s*\{[^}]*display:\s*block[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.chart-legend\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /@media \(max-width: 900px\)[^{]*\{[\s\S]*?\.analysis-detail\s*\{\s*grid-template-columns:\s*1fr/s);
});

test("viewBox plot bounds reserve internal room for axis labels", () => {
  assert.equal(CHART_GEOMETRY.width, 960);
  assert.ok(CHART_GEOMETRY.plotLeft >= 70);
  assert.ok(CHART_GEOMETRY.width - CHART_GEOMETRY.plotRight >= 40);
  assert.ok(CHART_GEOMETRY.plotTop > 0 && CHART_GEOMETRY.plotBottom < CHART_GEOMETRY.height);
  assert.match(page, /viewBox=\{`0 0 \$\{width\} \$\{height\}`\}/);
});

test("tab switching is presentation-only and chart controls retain their meanings", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CHART_SERIES).map(([key, value]) => [key, value.metric])),
    {
      diagnosticRawUnrealizedPnlUsd: "pnl",
      diagnosticIvUnrealizedPnlUsd: "pnl",
      rawSoldLegPrice: "values",
      rawBoughtLegPrice: "values",
      rawSpreadValue: "values",
      ivSoldLegPrice: "values",
      ivBoughtLegPrice: "values",
      ivSpreadValue: "values",
    },
  );
  assert.match(page, /\['pnl','PnL · USD'\],\['values','Contract values · BTC'\]/);
  assert.match(page, /Show exit markers/);
  assert.match(page, /const changeMetric = \(next: ChartMetric\) => \{ onMetricChange\(next\); setVisible/);
  assert.doesNotMatch(page, /changeMetric[\s\S]{0,250}(calculateContractSizeScenario|setScenario|outcomes)/);
});

import { adaptConservativePath, adaptResearchPath, rawResearchObservations, researchNetClosingCostBtc, researchOutcomeGroups, researchPnlUsd, RESEARCH_CHART_SERIES, timeX } from "../app/lib/valuation-chart.ts";
import type { EstimatedPathPoint } from "../app/lib/research-valuation.ts";

const researchPoint = (overrides:Partial<EstimatedPathPoint>={}):EstimatedPathPoint => ({timestamp:Date.UTC(2025,9,8),status:"priced",targetIndex:120_000,estimatedNetPnlBtc:.01,shortModelPriceBtc:.08,longModelPriceBtc:.03,closingSpreadValueBtcPerContract:-.05,estimateQuality:"red",soldIvSource:"constant-entry-IV",longIvSource:"local-observed-IV",...overrides});

test("Research and Conservative use explicit, semantically separate presentation adapters", () => {
  const research=adaptResearchPath([researchPoint()]);
  assert.equal(research[0].values.researchPnlUsd,1200);
  assert.equal(research[0].values.netClosingCostBtc,.05);
  assert.equal("diagnosticIvUnrealizedPnlUsd" in research[0].values,false);
  const conservative=adaptConservativePath([{timestamp:1,diagnosticIvUnrealizedPnlUsd:9} as never]);
  assert.equal(conservative[0].values.diagnosticIvUnrealizedPnlUsd,9);
  assert.equal("researchPnlUsd" in conservative[0].values,false);
});

test("Research USD conversion uses only each priced point target index", () => {
  const point=researchPoint({targetIndex:125_000,estimatedNetPnlBtc:.012,modelEstimate:{sold:{supportingTrades:[{indexPrice:99_000}]}} as never});
  assert.equal(researchPnlUsd(point),1500);
  assert.throws(()=>researchPnlUsd(researchPoint({targetIndex:undefined})),/targetIndex/);
});

test("Research metrics expose truthful defaults, units, and economic closing-cost sign", () => {
  assert.deepEqual([...new Set(RESEARCH_CHART_SERIES.map(series=>series.metric))],["pnl-usd","pnl-btc","contract-values","btc-index"]);
  assert.deepEqual(RESEARCH_CHART_SERIES.filter(s=>s.metric==="contract-values").map(s=>s.label),["Net spread closing cost / contract","Short theoretical option price","Long theoretical option price"]);
  assert.equal(researchNetClosingCostBtc(researchPoint()),.05);
  assert.match(page,/setVisible\(\[next==="pnl-usd"\?"researchPnlUsd"[\s\S]*?"netClosingCostBtc"/);
});

test("raw Research evidence is discrete and outcomes are available, grouped, and bounded", () => {
  const direct=researchPoint({rawEstimate:{priceSource:"direct-vwap"} as never});
  assert.deepEqual(rawResearchObservations([researchPoint(),direct]),[direct]);
  const expiry=30,groups=researchOutcomeGroups([{label:"VPOC",status:"estimated",valuationTimestamp:20},{label:"50% credit",status:"estimated",valuationTimestamp:20},{label:"7D",status:"unavailable",valuationTimestamp:40}] as never,expiry,10);
  assert.deepEqual(groups,[{timestamp:10,labels:["Entry"]},{timestamp:20,labels:["VPOC","50% credit"]}]);
  assert.doesNotMatch(page,/Raw historical estimate/);
  assert.match(page,/raw-observation-marker/);
});

test("Research interaction, gaps, timestamps, expiry labels, and responsive containment remain explicit", () => {
  assert.equal(timeX(20,10,40,0,300),100); // one third of the elapsed time range, independent of array position
  assert.match(page,/ResearchValuationChart path=\{path\}/);
  assert.match(page,/\["ArrowLeft","ArrowRight","Home","End"\]/);
  assert.match(page,/splitPresentationSeries/);
  assert.match(page,/point\.timestamp===expiry\?" · expiry \/ settlement"/);
  assert.match(page,/Show outcome markers/);
  assert.match(page,/shortIvDecimal[\s\S]*soldIvSource[\s\S]*longIvDecimal[\s\S]*longIvSource/);
});

test("Research inspector is external, keyboard-clearable, responsive, and opening currency is presentation-only",()=>{
 const page=readFileSync(new URL("../app/options-backtester.tsx",import.meta.url),"utf8");
 const css=readFileSync(new URL("../app/globals.css",import.meta.url),"utf8");
 assert.match(page,/<\/svg>}<\/div>\s*\{point\?<section className="selected-point-inspector"/);
 assert.match(page,/event\.key==="Escape".*setCursor\(undefined\)/);
 assert.match(page,/className="selected-time-label"/);
 assert.match(page,/active\.map\(series=>typeof selectedPresentation/);
 assert.match(page,/Hover over the chart or use the arrow keys to inspect a point/);
 assert.match(page,/useState<"btc"\|"usd-entry">\("btc"\)/);
 assert.match(page,/USD @ entry/);
 assert.match(page,/openingUsdEquivalent\(value,entry\.entryTargetIndex\)/);
 assert.match(page,/Theoretical maximum loss · USD equivalent at entry index/);
 assert.match(css,/\.selected-point-inspector \{ position: static/);
 assert.doesNotMatch(css,/\.selected-point-inspector[^}]*position:\s*absolute/);
 assert.match(css,/@media \(max-width: 560px\) \{ \.inspector-grid \{ grid-template-columns: minmax\(0,1fr\)/);
});
