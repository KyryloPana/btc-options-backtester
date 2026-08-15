import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("expanded evidence and payoff remain side by side on desktop", () => {
  assert.match(css, /\.ledger-pair\s*\{[^}]*width:\s*100%[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*?\.ledger-pair\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.ledger-detail-row > td,[\s\S]*\.payoff-plot\s*\{\s*min-width:\s*0/);
});

test("the centered workspace uses the desktop viewport", () => {
  assert.match(css, /\.page-shell\s*\{[^}]*width:\s*calc\(100%\s*-\s*32px\)[^}]*max-width:\s*1600px[^}]*margin:\s*0 auto/s);
});

test("payoff controls wrap and all statistics remain present", () => {
  assert.match(css, /\.payoff-currency-controls\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.payoff-inspector\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  for (const label of ["Selected point", "Maximum profit / loss", "Break-even", "Amount", "Gross / net entry credit"])
    assert.ok(app.includes(label), `missing payoff statistic: ${label}`);
  assert.match(app, /className="segmented payoff-currency-controls"/);
});

test("outcome values have simple visible USD labels without changing conversion inputs", () => {
  assert.doesNotMatch(app, /USD at outcome index/);
  assert.match(app, /estimatedNetPnlUsd:outcome\.conversionIndex===undefined\?undefined:estimatedNetPnl\*outcome\.conversionIndex/);
  assert.doesNotMatch(app, /estimatedNetPnl\*result\.eventPrice/);
  assert.match(app, /:money\(outcome\.estimatedNetPnlUsd\)/);
});
