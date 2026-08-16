import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tooltipOpenAfter } from "../app/components/info-tooltip-state.ts";
import { INFO_TOOLTIP_DEFINITIONS } from "../app/info-tooltip-definitions.ts";

const component = readFileSync(new URL("../app/components/info-tooltip.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/options-backtester.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("keyboard focus opens the tooltip and Escape or blur dismisses it", () => {
  assert.equal(tooltipOpenAfter(false, "show"), true);
  assert.equal(tooltipOpenAfter(true, "escape"), false);
  assert.equal(tooltipOpenAfter(true, "dismiss"), false);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /onFocus=\{show\}/);
  assert.match(component, /onBlur=\{\(\) => setOpen\(false\)\}/);
});

test("trigger exposes an accessible name and described-by relationship", () => {
  assert.match(component, /aria-label=\{accessibleLabel\}/);
  assert.match(component, /aria-describedby=\{id\}/);
  assert.match(component, /id=\{id\} role="tooltip"/);
});

test("tooltip rendering escapes scrollable tables without layout shift", () => {
  assert.match(page, /<th>DTE fit<InfoTooltip/);
  assert.match(component, /createPortal\(tooltip, document\.body\)/);
  assert.match(css, /\.info-tooltip-popover \{ position: fixed;/);
  assert.match(css, /visibility: hidden/);
});

test("application terminology is centralized and complete", () => {
  assert.ok(Object.keys(INFO_TOOLTIP_DEFINITIONS).length >= 20);
  for (const explanation of Object.values(INFO_TOOLTIP_DEFINITIONS)) assert.ok(explanation.length > 40);
});
