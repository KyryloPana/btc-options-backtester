import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHART_GEOMETRY, CHART_SERIES, valuationChartTitle } from "../app/lib/valuation-chart.ts";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("selected-analysis title follows the active chart tab", () => {
  assert.equal(valuationChartTitle("pnl"), "4H valuation path · IV-normalized diagnostic PnL · USD");
  assert.equal(valuationChartTitle("values"), "4H valuation path · Contract values · BTC/contract");
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
