import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {fileURLToPath} from "node:url";

/**
 * The unit-test gate is only as good as the manifest that invokes it.
 *
 * `package.json` had accumulated FOUR `"test:unit"` properties through
 * successive squash-merge round trips, holding 54, 48, 50 and 46 suites. JSON
 * parsers take the last one, so `npm run test:unit` silently ran 46 and the
 * complete 54-suite manifest was shadowed. Eight suites -- the whole Research
 * Analytics regression net -- stopped running while the gate still reported
 * green, and the files were all still sitting on disk.
 *
 * Duplicate keys are legal JSON and no tool complained, so this is checked
 * against the RAW TEXT rather than the parsed object: a parsed object cannot
 * show a duplicate that has already been collapsed.
 */

const root = new URL("../", import.meta.url);
const raw = readFileSync(new URL("package.json", root), "utf8");
const manifest = JSON.parse(raw) as {scripts: Record<string, string>};

/** Script keys are indented exactly four spaces by the repository's formatting. */
const scriptKeys = [...raw.matchAll(/^ {4}"([^"]+)":/gm)].map(m => m[1]!);

test("MANIFEST: package.json declares each script key exactly once", () => {
  const seen = new Map<string, number>();
  for (const key of scriptKeys) seen.set(key, (seen.get(key) ?? 0) + 1);
  const duplicated = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(duplicated, [],
    `duplicate script keys silently shadow earlier values: ${duplicated.map(([k, n]) => `${k} x${n}`).join(", ")}`);
});

test("MANIFEST: exactly one test:unit property governs the gate", () => {
  // Counted on the raw text: a duplicate is invisible once JSON.parse collapses it.
  const declarations = raw.split('"test:unit":').length - 1;
  assert.equal(declarations, 1,
    `found ${declarations} test:unit declarations; only the last would govern npm run test:unit`);
});

const suites = manifest.scripts["test:unit"]!.split(/\s+/).filter(x => x.endsWith(".ts"));

test("MANIFEST: every suite the gate names actually exists", () => {
  const missing = suites.filter(s => !existsSync(new URL(s, root)));
  assert.deepEqual(missing, [], `test:unit names files that do not exist: ${missing.join(", ")}`);
  assert.equal(new Set(suites).size, suites.length, "a suite is listed more than once");
});

/**
 * The suites that have each, at least once, been dropped by a merge and had to
 * be restored. They are named explicitly so a future merge that loses one fails
 * here rather than reporting green over a smaller gate.
 */
const CRITICAL_SUITES = [
  "tests/structural-loss.unit.test.ts",
  "tests/research-outcome-fidelity.unit.test.ts",
  "tests/delayed-economic-track.unit.test.ts",
  "tests/frozen-architecture-integration.unit.test.ts",
  "tests/analytics-canonical-risk-outcomes.unit.test.ts",
  "tests/analytics-track-routing.unit.test.ts",
  "tests/economics-futures-wiring.unit.test.ts",
  "tests/analytics-integration-audit.unit.test.ts",
] as const;

test("MANIFEST: the critical Analytics suites remain in the gate", () => {
  const absent = CRITICAL_SUITES.filter(s => !suites.includes(s));
  assert.deepEqual(absent, [], `the gate no longer runs: ${absent.join(", ")}`);
});

/**
 * Files on disk are classified rather than swept in wholesale, because their
 * runtime contracts genuinely differ.
 *
 *  B. Browser / rendered tests run from their own scripts, after a build.
 *  C. `end-to-end-research-audit.test.ts` is a standalone AUDIT COUNTEREXAMPLE
 *     suite. Its own cases assert known architectural gaps -- two of them fail
 *     by design against current main -- so it documents findings rather than
 *     gating merges, and it is deliberately excluded. It runs under the same
 *     Node command; it is simply not a pass/fail gate.
 */
const SEPARATE_BY_CONTRACT: Readonly<Record<string, string>> = {
  "pnl-overflow.browser.test.mjs": "browser suite, run by test:browser:pnl",
  "rendered-html.test.mjs": "rendered-output suite, run by npm test after the build",
  "end-to-end-research-audit.test.ts": "standalone audit counterexample suite, not a gate",
};

test("MANIFEST: no unit suite is accidentally omitted from the gate", () => {
  const onDisk = readdirSync(fileURLToPath(new URL("tests/", root)))
    .filter(f => f.endsWith(".test.ts") || f.endsWith(".test.mjs"));
  const unaccounted = onDisk.filter(f =>
    !suites.includes(`tests/${f}`) && !(f in SEPARATE_BY_CONTRACT));
  assert.deepEqual(unaccounted, [],
    `these test files are neither in test:unit nor documented as separate: ${unaccounted.join(", ")}`);
  // Every documented exclusion must still exist, so the list cannot rot.
  for (const name of Object.keys(SEPARATE_BY_CONTRACT))
    assert.ok(onDisk.includes(name), `${name} is documented as excluded but no longer exists`);
});
