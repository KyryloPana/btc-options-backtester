/**
 * Retrieve the PRIOR anchors the current local-IV method would have used.
 *
 * Scoring today's production methodology fairly needs the evidence it would
 * actually have seen. `selectIvAnchor` takes the latest causal print on the
 * SAME contract within 720 minutes; on a holdout the canonical 60-minute prints
 * are withheld, so what remains available to it is the 60-to-720-minute band.
 *
 * That band is not in the cross-section cache, which stores only canonical
 * windows, so it is fetched once per holdout snapshot and cached here. Giving
 * the current method nothing to work with would have made the comparison
 * meaningless in its favour-- it would look like a coverage gap rather than an
 * estimate, and the surface models would beat a straw man.
 *
 *   node --experimental-strip-types scripts/fetch-prior-anchors.ts <readinessJson> <outJson>
 */

import {readFile, writeFile} from "node:fs/promises";
import {CrossSectionRetrieval} from "./cross-section-cache.ts";
import {MARKET_IV_MAX_AGE_MINUTES} from "../app/lib/volatility/market-iv-evidence.ts";
import {PRIOR_ANCHOR_MAX_AGE_MINUTES} from "../app/lib/volatility/surface-models.ts";

interface AnchorRow {
  readonly instrument_name: string;
  readonly iv_decimal: number;
  readonly timestamp_ms: number;
}

async function main() {
  const [readinessPath, outPath] = process.argv.slice(2);
  if (!readinessPath || !outPath) throw new Error("usage: fetch-prior-anchors.ts <readinessJson> <outJson>");

  const report = JSON.parse(await readFile(readinessPath, "utf8")) as {
    holdouts: {target_timestamp_utc: string}[];
    spread_holdouts: {target_timestamp_utc: string}[];
  };
  const targets = [...new Set([
    ...report.holdouts.map(h => h.target_timestamp_utc),
    ...report.spread_holdouts.map(h => h.target_timestamp_utc),
  ])].map(iso => Date.parse(iso)).filter(Number.isFinite).sort((a, b) => a - b);

  process.stderr.write(`prior anchors for ${targets.length} snapshots\n`);
  const retrieval = new CrossSectionRetrieval();
  await retrieval.instrumentManifest();

  const out: Record<string, AnchorRow[]> = {};
  let done = 0;
  for (const target of targets) {
    // Strictly the band the current method can still see once the canonical
    // window is withheld.
    const from = target - PRIOR_ANCHOR_MAX_AGE_MINUTES * 60_000;
    const to = target - MARKET_IV_MAX_AGE_MINUTES * 60_000;
    const prints = await retrieval.optionPrints(from, to);

    // Latest qualifying print per instrument -- exactly what selectIvAnchor picks.
    const latest = new Map<string, AnchorRow>();
    for (const p of prints) {
      const iv = p.ivApiPercent;
      if (iv === null || iv === undefined || !(iv > 0)) continue;
      if (!(p.indexPrice !== null && p.indexPrice !== undefined && p.indexPrice > 0)) continue;
      if (p.timestampMs > to) continue;
      const existing = latest.get(p.instrumentName);
      if (!existing || p.timestampMs > existing.timestamp_ms)
        latest.set(p.instrumentName, {
          instrument_name: p.instrumentName, iv_decimal: iv / 100, timestamp_ms: p.timestampMs,
        });
    }
    out[String(target)] = [...latest.values()].sort((a, b) => a.instrument_name.localeCompare(b.instrument_name));
    retrieval.clearWindowCache();
    done += 1;
    if (done % 10 === 0) process.stderr.write(`  ${done}/${targets.length} (${retrieval.requestCount} requests)\n`);
  }

  await writeFile(outPath, JSON.stringify({
    generated_at_utc: new Date().toISOString(),
    prior_anchor_max_age_minutes: PRIOR_ANCHOR_MAX_AGE_MINUTES,
    canonical_window_minutes: MARKET_IV_MAX_AGE_MINUTES,
    snapshot_count: targets.length,
    api_requests: retrieval.requestCount,
    anchors: out,
  }, null, 1), "utf8");
  process.stderr.write(`done: ${targets.length} snapshots, ${retrieval.requestCount} requests\n`);
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
