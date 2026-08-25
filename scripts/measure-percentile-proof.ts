/**
 * Prove the causal IV percentile end to end on ONE real event.
 *
 * The expanding percentile needs at least 720 prior hourly reference
 * observations per tenor. Coverage measurement therefore reports it unavailable
 * until the standalone reference series is actually populated. This script
 * populates it for a single event -- 720 hourly windows of real Deribit tape --
 * and computes the percentile, so the 0% in the main coverage run is shown to be
 * an unpopulated cache rather than a methodology that cannot produce a number.
 *
 *   node --experimental-strip-types scripts/measure-percentile-proof.ts <entryIsoUtc> [outJson]
 */

import {writeFile} from "node:fs/promises";
import {
  MARKET_IV_MAX_AGE_MINUTES, type NominalTenor, type RawIvTradeCandidate,
} from "../app/lib/volatility/market-iv-evidence.ts";
import {
  OPTION_HISTORY_HOST, REFERENCE_SERIES_ID, buildReferenceSeriesRows,
  referenceSeriesContentHash, type ListedExpiry,
} from "../app/lib/volatility/reference-series.ts";
import {causalIvPercentile, type ReferenceObservation} from "../app/lib/volatility/iv-percentile.ts";
import {HOUR_MS} from "../app/lib/volatility/realized-volatility.ts";

const TENORS: readonly NominalTenor[] = ["7d", "14d", "30d"];
const PRIOR_HOURS = 760;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;

async function get(method: string, params: Record<string, string | number>): Promise<unknown> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${OPTION_HISTORY_HOST}/${method}?${query}`);
    if (response.ok) return (await response.json() as {result?: unknown}).result;
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`${method} failed after retries`);
}

interface Meta {
  instrumentName: string; strike: number; optionType: "C" | "P";
  expiryTimestampMs: number; createdAtMs: number; settlementPeriod: string;
}

async function manifest(): Promise<Meta[]> {
  const batches = await Promise.all([true, false].map(expired =>
    get("get_instruments", {currency: "BTC", kind: "option", expired: String(expired)})));
  const out: Meta[] = [];
  for (const batch of batches) for (const raw of Array.isArray(batch) ? batch : []) {
    const r = raw as Row;
    const name = str(r.instrument_name), strike = num(r.strike);
    const expiry = num(r.expiration_timestamp), created = num(r.creation_timestamp);
    if (!name || strike === null || expiry === null || created === null) continue;
    out.push({instrumentName: name, strike, optionType: r.option_type === "put" ? "P" : "C",
      expiryTimestampMs: expiry, createdAtMs: created,
      settlementPeriod: str(r.settlement_period) ?? "unknown"});
  }
  return out;
}

async function main() {
  const [entryIso, outPath] = process.argv.slice(2);
  const entryMs = Date.parse(entryIso ?? "");
  if (!Number.isFinite(entryMs)) throw new Error("usage: measure-percentile-proof.ts <entryIsoUtc> [outJson]");

  const instruments = await manifest();
  const byName = new Map(instruments.map(m => [m.instrumentName, m]));
  process.stderr.write(`manifest ${instruments.length}; building ${PRIOR_HOURS} prior hours\n`);

  const history: Record<NominalTenor, ReferenceObservation[]> = {"7d": [], "14d": [], "30d": []};
  const allRows = [];
  let attempted = 0;

  // Every target from PRIOR_HOURS before entry up to and including entry.
  for (let i = PRIOR_HOURS; i >= 0; i -= 1) {
    const target = entryMs - i * HOUR_MS;
    const result = await get("get_last_trades_by_currency_and_time", {
      currency: "BTC", kind: "option",
      start_timestamp: target - MARKET_IV_MAX_AGE_MINUTES * 60_000, end_timestamp: target,
      count: 1000, sorting: "desc",
    }) as {trades?: Row[]} | undefined;
    const trades = result?.trades ?? [];
    attempted += 1;
    if (attempted % 100 === 0) process.stderr.write(`  ${attempted}/${PRIOR_HOURS + 1}\n`);

    let underlying: number | null = null, freshest = -1;
    const candidates: RawIvTradeCandidate[] = [];
    const expiries = new Map<number, ListedExpiry & {strikes: number[]}>();
    for (const t of trades) {
      const name = str(t.instrument_name), meta = name ? byName.get(name) : undefined;
      if (!meta) continue;
      const ts = num(t.timestamp), index = num(t.index_price);
      if (ts !== null && index !== null && ts > freshest) { freshest = ts; underlying = index; }
      candidates.push({
        instrumentName: meta.instrumentName, tradeId: str(t.trade_id), tradeSeq: num(t.trade_seq),
        strike: meta.strike, optionType: meta.optionType, expiryTimestampMs: meta.expiryTimestampMs,
        settlementPeriod: meta.settlementPeriod, contractCreatedAtMs: meta.createdAtMs,
        timestampMs: ts ?? 0, ivApiPercent: num(t.iv), indexPrice: index,
      } as RawIvTradeCandidate);
    }
    if (underlying === null) continue;
    for (const m of instruments) {
      if (m.createdAtMs > target || m.expiryTimestampMs <= target) continue;
      const e = expiries.get(m.expiryTimestampMs);
      if (e) e.strikes.push(m.strike);
      else expiries.set(m.expiryTimestampMs, {expiryTimestampMs: m.expiryTimestampMs,
        createdAtMs: m.createdAtMs, settlementPeriod: m.settlementPeriod, strikes: [m.strike]});
    }
    const {rows} = buildReferenceSeriesRows({
      timestampMs: target, underlyingInstrument: "deribit_btc_usd_index",
      underlyingPrice: underlying, listedExpiries: [...expiries.values()],
      candidates, tenors: TENORS,
    });
    allRows.push(...rows);
    for (const row of rows) {
      if (row.reference_iv_decimal === null || !row.passes_market_state_rule || !row.tenor_tolerance_passed) continue;
      // Strictly prior observations only; the entry target itself is the subject.
      if (row.timestamp_ms < entryMs)
        history[row.nominal_tenor].push({
          timestampMs: row.timestamp_ms, ivDecimal: row.reference_iv_decimal,
          tenor: row.nominal_tenor, referenceSeriesId: REFERENCE_SERIES_ID,
        });
    }
  }

  const hash = referenceSeriesContentHash(allRows);
  const subject = Object.fromEntries(TENORS.map(t => {
    const atEntry = allRows.find(r => r.timestamp_ms === entryMs && r.nominal_tenor === t);
    return [t, atEntry?.reference_iv_decimal ?? null];
  })) as Record<NominalTenor, number | null>;

  const percentiles = Object.fromEntries(TENORS.map(t => [t, causalIvPercentile({
    subjectIvDecimal: subject[t], targetTimestampMs: entryMs, history: history[t], tenor: t,
    referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: hash,
  })]));

  const report = {
    entry_timestamp_utc: new Date(entryMs).toISOString(),
    hours_attempted: attempted, reference_rows_built: allRows.length,
    reference_series_content_hash: hash,
    prior_observations: Object.fromEntries(TENORS.map(t => [t, history[t].length])),
    subject_iv_decimal: subject, percentiles,
  };
  if (outPath) await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stdout.write(JSON.stringify(report, null, 1) + "\n");
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
