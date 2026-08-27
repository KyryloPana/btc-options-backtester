/**
 * Measure REAL market-IV coverage on an actual research bundle.
 *
 * This is a read-only research measurement tool, not an import path: it reads a
 * canonical bundle purely to learn WHICH events and structures to ask Deribit
 * about, and never reconstructs a research-selection store from it. Nothing it
 * produces can be selected, re-ranked or fed back into the app.
 *
 * What it answers, per the methodology audit's coverage question: at each real
 * MR entry, did the historical tape actually support a causal same-expiry
 * reference IV, a per-leg IV for the selected structures, and a trailing
 * realized volatility? Availability is the result, not a precondition.
 *
 *   node --experimental-strip-types scripts/measure-volatility-coverage.ts <bundleDir> [outJson]
 */

import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  MARKET_IV_MAX_AGE_MINUTES, type NominalTenor, type RawIvTradeCandidate,
} from "../app/lib/volatility/market-iv-evidence.ts";
import {
  OPTION_HISTORY_HOST, REFERENCE_SERIES_ID, buildExpiryReferenceRow, buildReferenceSeriesRows,
  referenceSeriesContentHash, type ListedExpiry, type ReferenceSeriesRow,
} from "../app/lib/volatility/reference-series.ts";
import {
  HOUR_MS, realizedVolatilityProfile, type HourlyClose,
} from "../app/lib/volatility/realized-volatility.ts";
import {
  buildEventVolatilityState, buildStructureVolatilityState,
} from "../app/lib/volatility/volatility-state.ts";
import {projectVolatilityAnalytics} from "../app/lib/volatility/volatility-analytics.ts";

const TENORS: readonly NominalTenor[] = ["7d", "14d", "30d"];
/** Enough hourly bars for the longest RV horizon (30D = 720h), plus slack. */
const RV_LOOKBACK_HOURS = 760;

type Row = Record<string, unknown>;
const jsonl = async (dir: string, name: string): Promise<Row[]> =>
  (await readFile(join(dir, name), "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as Row);

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;

async function get(host: string, method: string, params: Record<string, string | number>): Promise<unknown> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const response = await fetch(`${host}/${method}?${query}`);
  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}`);
  return (await response.json() as {result?: unknown}).result;
}

interface InstrumentMeta {
  instrumentName: string; strike: number; optionType: "C" | "P";
  expiryTimestampMs: number; createdAtMs: number; settlementPeriod: string;
}

/** Every BTC option Deribit has ever listed, expired and active. One fetch. */
async function instrumentManifest(): Promise<InstrumentMeta[]> {
  const batches = await Promise.all([true, false].map(expired =>
    get(OPTION_HISTORY_HOST, "get_instruments",
      {currency: "BTC", kind: "option", expired: String(expired)})));
  const out: InstrumentMeta[] = [];
  for (const batch of batches) for (const raw of Array.isArray(batch) ? batch : []) {
    const r = raw as Row;
    const name = str(r.instrument_name), strike = num(r.strike);
    const expiry = num(r.expiration_timestamp), created = num(r.creation_timestamp);
    if (!name || strike === null || expiry === null || created === null) continue;
    out.push({
      instrumentName: name, strike, optionType: r.option_type === "put" ? "P" : "C",
      expiryTimestampMs: expiry, createdAtMs: created,
      settlementPeriod: str(r.settlement_period) ?? "unknown",
    });
  }
  return out;
}

/** Every option print in [from, to). One call covers all strikes and expiries. */
async function optionTrades(fromMs: number, toMs: number): Promise<Row[]> {
  const result = await get(OPTION_HISTORY_HOST, "get_last_trades_by_currency_and_time", {
    currency: "BTC", kind: "option", start_timestamp: fromMs, end_timestamp: toMs,
    count: 1000, sorting: "desc",
  }) as {trades?: Row[]} | undefined;
  return result?.trades ?? [];
}

async function perpetualHourly(fromMs: number, toMs: number): Promise<HourlyClose[]> {
  for (const host of [OPTION_HISTORY_HOST, "https://www.deribit.com/api/v2/public"]) {
    try {
      const result = await get(host, "get_tradingview_chart_data", {
        instrument_name: "BTC-PERPETUAL", resolution: "60",
        start_timestamp: fromMs, end_timestamp: toMs,
      }) as {ticks?: number[]; close?: number[]} | undefined;
      const ticks = result?.ticks ?? [], closes = result?.close ?? [];
      if (ticks.length) return ticks.map((t, i) => ({timestampMs: t, close: closes[i]!}))
        .filter(b => Number.isFinite(b.close));
    } catch { /* try the next host */ }
  }
  return [];
}

/** Deribit's own index price on the freshest print is the causal underlying. */
const causalUnderlying = (trades: readonly Row[]): number | null => {
  let best: {ts: number; index: number} | null = null;
  for (const t of trades) {
    const ts = num(t.timestamp), index = num(t.index_price);
    if (ts === null || index === null) continue;
    if (!best || ts > best.ts) best = {ts, index};
  }
  return best?.index ?? null;
};

const toCandidates = (trades: readonly Row[], byName: Map<string, InstrumentMeta>): RawIvTradeCandidate[] => {
  const out: RawIvTradeCandidate[] = [];
  for (const t of trades) {
    const name = str(t.instrument_name);
    const meta = name ? byName.get(name) : undefined;
    if (!meta) continue;
    out.push({
      instrumentName: meta.instrumentName, tradeId: str(t.trade_id), tradeSeq: num(t.trade_seq),
      strike: meta.strike, optionType: meta.optionType,
      expiryTimestampMs: meta.expiryTimestampMs, settlementPeriod: meta.settlementPeriod,
      contractCreatedAtMs: meta.createdAtMs,
      timestampMs: num(t.timestamp) ?? 0, ivApiPercent: num(t.iv),
      indexPrice: num(t.index_price), price: num(t.price), markPrice: num(t.mark_price),
      direction: str(t.direction), amount: num(t.amount),
    } as RawIvTradeCandidate);
  }
  return out;
};

async function main() {
  const [bundleDir, outPath] = process.argv.slice(2);
  if (!bundleDir) throw new Error("usage: measure-volatility-coverage.ts <bundleDir> [outJson]");

  const events = await jsonl(bundleDir, "events.jsonl");
  const candidates = await jsonl(bundleDir, "candidates.jsonl");
  process.stderr.write(`manifest: fetching...\n`);
  const manifest = await instrumentManifest();
  const byName = new Map(manifest.map(m => [m.instrumentName, m]));
  process.stderr.write(`manifest: ${manifest.length} instruments\n`);

  // One structural row per candidate_id; maker/taker rows share structural identity.
  const structures = new Map<string, Row>();
  for (const c of candidates) {
    const id = str(c.candidate_id);
    if (id && !structures.has(id)) structures.set(id, c);
  }

  const eventRows = [], structureRows = [], diagnostics: Row[] = [];

  for (const event of events) {
    const eventId = str(event.event_id)!;
    const entryMs = Date.parse(String(event.entry_timestamp_utc ?? event.signal_timestamp_utc));
    if (!Number.isFinite(entryMs)) continue;
    process.stderr.write(`event ${eventId} @ ${new Date(entryMs).toISOString()}\n`);

    const windowStart = entryMs - MARKET_IV_MAX_AGE_MINUTES * 60_000;
    const trades = await optionTrades(windowStart, entryMs);
    const underlying = causalUnderlying(trades) ?? num(event.entry_price);

    // Contracts already listed at entry, expiring after it. The creation gate is
    // what keeps a short-lived daily contract from being treated as evidence for
    // a tenor at a time when it was not yet listed.
    const byExpiry = new Map<number, ListedExpiry & {strikes: number[]}>();
    for (const m of manifest) {
      if (m.createdAtMs > entryMs || m.expiryTimestampMs <= entryMs) continue;
      const existing = byExpiry.get(m.expiryTimestampMs);
      if (existing) existing.strikes.push(m.strike);
      else byExpiry.set(m.expiryTimestampMs, {
        expiryTimestampMs: m.expiryTimestampMs, createdAtMs: m.createdAtMs,
        settlementPeriod: m.settlementPeriod, strikes: [m.strike],
      });
    }
    const listedExpiries = [...byExpiry.values()];
    const rawCandidates = toCandidates(trades, byName);

    const built = underlying === null ? {rows: [] as ReferenceSeriesRow[], admitted: 0, rejected: {}}
      : buildReferenceSeriesRows({
        timestampMs: entryMs, underlyingInstrument: "deribit_btc_usd_index",
        underlyingPrice: underlying, listedExpiries, candidates: rawCandidates, tenors: TENORS,
      });

    const bars = await perpetualHourly(entryMs - RV_LOOKBACK_HOURS * HOUR_MS, entryMs);
    const rvProfile = realizedVolatilityProfile({bars, targetTimestampMs: entryMs});
    const contentHash = referenceSeriesContentHash(built.rows);

    eventRows.push(buildEventVolatilityState({
      eventId, entryTimestampMs: entryMs, underlyingInstrument: "deribit_btc_usd_index",
      entryUnderlyingPrice: underlying,
      referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: contentHash,
      referenceRows: built.rows, realizedVolatility: rvProfile,
      // The expanding percentile needs 720 prior HOURLY reference observations.
      // Populating that series is the cache job, not this measurement, so it is
      // reported unavailable rather than computed from a short history.
      percentiles: {},
    }));

    diagnostics.push({
      event_id: eventId, entry_timestamp_utc: new Date(entryMs).toISOString(),
      window_trades: trades.length, admitted: built.admitted,
      rejected: built.rejected as unknown as Row,
      causal_underlying: underlying, listed_expiries: listedExpiries.length,
      perpetual_bars: bars.length,
    });

    for (const [candidateId, candidate] of structures) {
      if (str(candidate.event_id) !== eventId) continue;
      const instruments = (candidate.instruments ?? {}) as Row;
      const shortName = str(instruments.short), longName = str(instruments.long);
      const strikes = (candidate.actual_strikes ?? {}) as Row;
      const expiryMs = Date.parse(String(candidate.expiry_timestamp_utc));

      // Per-leg IV measured from the live tape, independently of whatever the
      // pricing model recorded: this is what the market actually supported.
      const legFrom = (instrument: string | null) => {
        if (!instrument) return null;
        const prints = rawCandidates
          .filter(c => c.instrumentName === instrument && c.timestampMs <= entryMs)
          .sort((a, b) => b.timestampMs - a.timestampMs);
        const best = prints[0];
        const percent = best ? num(best.ivApiPercent) : null;
        if (!best || percent === null || percent <= 0) return null;
        return {
          ivDecimal: percent / 100, ivApiPercent: percent, ivSource: "deribit_trade_iv",
          ivSourceTimestampMs: best.timestampMs, observation: "observed",
        };
      };

      // The structure's expiry is EXACT, not an approximation of a nominal
      // tenor, so it bypasses tenor resolution entirely. Its own legs are
      // excluded so the reference is not measured against itself.
      const own = [shortName, longName].filter((x): x is string => Boolean(x));
      const listed = listedExpiries.find(e => e.expiryTimestampMs === expiryMs);
      const structureReference = underlying === null || !listed ? null
        : buildExpiryReferenceRow({
          timestampMs: entryMs, underlyingInstrument: "deribit_btc_usd_index",
          underlyingPrice: underlying, expiry: listed,
          candidates: rawCandidates, excludedInstruments: own,
        });

      structureRows.push(buildStructureVolatilityState({
        eventId, candidateId, entryTimestampMs: entryMs,
        actualExpiryTimestampMs: Number.isFinite(expiryMs) ? expiryMs : null,
        actualDteDays: Number.isFinite(expiryMs) ? (expiryMs - entryMs) / 86_400_000 : null,
        shortStrike: num(strikes.short), longStrike: num(strikes.long),
        optionType: str(candidate.option_type),
        shortInstrument: shortName, longInstrument: longName,
        referenceSeriesId: REFERENCE_SERIES_ID, referenceSeriesContentHash: contentHash,
        shortLeg: legFrom(shortName), longLeg: legFrom(longName),
        // A reference row built for a DIFFERENT expiry is not this structure's
        // reference; only an exact expiry match is admitted.
        reference: structureReference,
      }));
    }
  }

  const projection = projectVolatilityAnalytics({
    event_volatility_state: eventRows as unknown as Row[],
    structure_volatility_state: structureRows as unknown as Row[],
  });
  const report = {
    measured_at_utc: new Date().toISOString(), bundle_dir: bundleDir,
    market_iv_max_age_minutes: MARKET_IV_MAX_AGE_MINUTES,
    diagnostics, coverage: projection.coverage,
    events: eventRows, structures: structureRows,
  };
  if (outPath) await writeFile(outPath, JSON.stringify(report, null, 1), "utf8");
  process.stdout.write(JSON.stringify({diagnostics, coverage: projection.coverage}, null, 1) + "\n");
}

main().catch(e => { process.stderr.write(`FAILED: ${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
