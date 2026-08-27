/**
 * Retrieval and versioned local cache for `historical_option_iv_observations`.
 *
 * All IO lives here; the methodology in `app/lib/volatility/cross-section.ts`
 * stays pure and testable without a network.
 *
 * Two retrieval facts drive the design, both established by probe rather than
 * assumption:
 *   - expired option history is served only by `history.deribit.com`;
 *   - `get_last_trades_by_currency_and_time` returns EVERY option print in a
 *     window across all strikes and expiries in one call, so a causal snapshot
 *     costs one request no matter how many structures or expiries consume it.
 *
 * The cache is sharded by month, like the reference series, so expanding the
 * event sample reuses history instead of redownloading it. Snapshots are stored
 * separately from the raw observations: the observations are the evidence, the
 * snapshot row is the identity and geometry that used them.
 */

import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {
  HISTORICAL_OPTION_IV_DATASET_ID, CROSS_SECTION_METHOD_VERSION,
  type CrossSectionObservation, type RawOptionPrint, type SurfaceSnapshot,
} from "../app/lib/volatility/cross-section.ts";
import {OPTION_HISTORY_HOST, contentHash} from "../app/lib/volatility/reference-series.ts";

export const CROSS_SECTION_CACHE_ROOT = ".local-cache/historical-option-iv";
/** Deribit's per-request trade cap on this endpoint. */
export const TRADE_PAGE_LIMIT = 1000;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" && v ? v : null;

export interface InstrumentMeta {
  readonly instrumentName: string;
  readonly strike: number;
  readonly optionType: "C" | "P";
  readonly expiryTimestampMs: number;
  readonly createdAtMs: number;
  readonly settlementPeriod: string;
  readonly contractSize: number | null;
  readonly minimumTradeAmount: number | null;
}

export interface RetrievalOptions {
  readonly fetcher?: typeof fetch;
  readonly host?: string;
  readonly maxRetries?: number;
}

export class CrossSectionRetrieval {
  readonly #fetch: typeof fetch;
  readonly #host: string;
  readonly #maxRetries: number;
  /** Window-keyed, so a snapshot shared by many structures is fetched once. */
  readonly #windows = new Map<string, RawOptionPrint[]>();
  #manifest: InstrumentMeta[] | null = null;
  #requests = 0;
  #incompleteLeafWindows: Array<{fromMs:number;toMs:number;count:number}> = [];

  constructor(options: RetrievalOptions = {}) {
    this.#fetch = options.fetcher ?? fetch;
    this.#host = options.host ?? OPTION_HISTORY_HOST;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  get requestCount(): number { return this.#requests; }
  /**
   * Drop cached windows. The manifest is kept -- it is one fetch and is reused
   * across every target -- but the per-window prints are large and are only
   * reused within a single event's pass.
   */
  clearWindowCache(): void { this.#windows.clear(); }
  get host(): string { return this.#host; }
  get incompleteLeafWindows(): readonly {fromMs:number;toMs:number;count:number}[] { return this.#incompleteLeafWindows; }

  async #get(method: string, params: Record<string, string | number>): Promise<unknown> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.#maxRetries; attempt += 1) {
      this.#requests += 1;
      try {
        const response = await this.#fetch(`${this.#host}/${method}?${query}`);
        if (response.ok) return (await response.json() as {result?: unknown}).result;
        lastError = new Error(`${method} -> HTTP ${response.status}`);
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(`${method} failed`);
  }

  /**
   * Every BTC option Deribit has listed, expired and active.
   *
   * Fetched once and reused. `creation_timestamp` travels with each row because
   * a contract present in today's manifest was not necessarily listed at a
   * historical target, and using it there would be a causality breach.
   */
  async instrumentManifest(): Promise<readonly InstrumentMeta[]> {
    if (this.#manifest) return this.#manifest;
    const batches = await Promise.all([true, false].map(expired =>
      this.#get("get_instruments", {currency: "BTC", kind: "option", expired: String(expired)})));
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
        contractSize: num(r.contract_size), minimumTradeAmount: num(r.min_trade_amount),
      });
    }
    this.#manifest = out;
    return out;
  }

  /**
   * All option prints in `[fromMs, toMs]`, as raw candidates.
   *
   * Deribit caps a response at 1000 trades. When the cap is hit the window is
   * split in half and both halves fetched, so a busy hour is never silently
   * truncated to its most recent 1000 prints -- which would bias every count
   * toward the freshest end of the window.
   */
  async optionPrints(fromMs: number, toMs: number): Promise<readonly RawOptionPrint[]> {
    const key = `${fromMs}~${toMs}`;
    const cached = this.#windows.get(key);
    if (cached) return cached;

    const manifest = await this.instrumentManifest();
    const byName = new Map(manifest.map(m => [m.instrumentName, m]));
    const collected = await this.#pagedTrades(fromMs, toMs, byName, 0);
    this.#windows.set(key, collected);
    return collected;
  }

  async #pagedTrades(
    fromMs: number, toMs: number, byName: Map<string, InstrumentMeta>, depth: number,
  ): Promise<RawOptionPrint[]> {
    const result = await this.#get("get_last_trades_by_currency_and_time", {
      currency: "BTC", kind: "option", start_timestamp: fromMs, end_timestamp: toMs,
      count: TRADE_PAGE_LIMIT, sorting: "desc",
    }) as {trades?: Row[]} | undefined;
    const trades = result?.trades ?? [];

    // Split down to an individual millisecond. A fixed recursion-depth cap can
    // silently truncate a busy month/day; only a saturated 1ms leaf is truly
    // indivisible and is explicitly reported as incomplete below.
    if (trades.length >= TRADE_PAGE_LIMIT && depth < 64 && toMs > fromMs) {
      const middle = Math.floor((fromMs + toMs) / 2);
      const [older, newer] = await Promise.all([
        this.#pagedTrades(fromMs, middle, byName, depth + 1),
        this.#pagedTrades(middle + 1, toMs, byName, depth + 1),
      ]);
      return [...older, ...newer];
    }
    if (trades.length >= TRADE_PAGE_LIMIT)
      this.#incompleteLeafWindows.push({fromMs,toMs,count:trades.length});
    return trades.flatMap(t => {
      const name = str(t.instrument_name);
      const meta = name ? byName.get(name) : undefined;
      if (!meta) return [];
      return [{
        instrumentName: meta.instrumentName, tradeId: str(t.trade_id), tradeSeq: num(t.trade_seq),
        strike: meta.strike, optionType: meta.optionType,
        expiryTimestampMs: meta.expiryTimestampMs, settlementPeriod: meta.settlementPeriod,
        contractCreatedAtMs: meta.createdAtMs,
        timestampMs: num(t.timestamp) ?? 0,
        ivApiPercent: num(t.iv), indexPrice: num(t.index_price),
        price: num(t.price), markPrice: num(t.mark_price),
        amount: num(t.amount) ?? num(t.contracts),
        direction: str(t.direction), tickDirection: num(t.tick_direction),
      } satisfies RawOptionPrint];
    });
  }
}

/**
 * The causal underlying at a target: Deribit's own index price carried on the
 * freshest qualifying print. Using the exchange's index rather than a separate
 * spot feed keeps the moneyness coordinate consistent with the IV that was
 * quoted against it.
 */
export function causalUnderlyingPrice(prints: readonly RawOptionPrint[], targetMs: number): number | null {
  let best: {ts: number; index: number} | null = null;
  for (const p of prints) {
    const index = num(p.indexPrice);
    if (index === null || p.timestampMs > targetMs) continue;
    if (!best || p.timestampMs > best.ts) best = {ts: p.timestampMs, index};
  }
  return best?.index ?? null;
}

/**
 * Listed expiries at a target, with their strike ladders.
 *
 * Gated on `creation_timestamp` so an expiry only appears once it genuinely
 * existed, and on `expiry > target` so a settled contract cannot be evidence.
 */
export function listedExpiriesAt(manifest: readonly InstrumentMeta[], targetMs: number): {
  expiryTimestampMs: number; createdAtMs: number; settlementPeriod: string; strikes: number[];
}[] {
  const byExpiry = new Map<number, {expiryTimestampMs: number; createdAtMs: number; settlementPeriod: string; strikes: number[]}>();
  for (const m of manifest) {
    if (m.createdAtMs > targetMs || m.expiryTimestampMs <= targetMs) continue;
    const existing = byExpiry.get(m.expiryTimestampMs);
    if (existing) { existing.strikes.push(m.strike); existing.createdAtMs = Math.min(existing.createdAtMs, m.createdAtMs); }
    else byExpiry.set(m.expiryTimestampMs, {
      expiryTimestampMs: m.expiryTimestampMs, createdAtMs: m.createdAtMs,
      settlementPeriod: m.settlementPeriod, strikes: [m.strike],
    });
  }
  return [...byExpiry.values()].sort((a, b) => a.expiryTimestampMs - b.expiryTimestampMs);
}

/* ============================ shard cache ============================ */

export const shardIdFor = (timestampMs: number): string => {
  const d = new Date(timestampMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export interface CrossSectionManifest {
  readonly dataset_id: string;
  readonly method_version: string;
  readonly source_host: string;
  readonly generated_at_utc: string;
  readonly snapshot_count: number;
  readonly observation_count: number;
  readonly coverage_start_utc: string | null;
  readonly coverage_end_utc: string | null;
  readonly shards: readonly string[];
  readonly content_hash: string;
}

const datasetRoot = (root: string) => join(root, HISTORICAL_OPTION_IV_DATASET_ID);
const readJsonl = async (path: string): Promise<Row[]> => {
  try { return (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l) as Row); }
  catch { return []; }
};
const writeJsonl = async (path: string, rows: readonly unknown[]) => {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
};

/**
 * Persist snapshots and their observations into monthly shards.
 *
 * Snapshot identity is `(target_timestamp, content_hash)`, so regenerating an
 * unchanged target replaces its row rather than duplicating it, and a genuinely
 * changed evidence set produces a visibly different hash.
 */
export async function writeCrossSectionShards(input: {
  readonly snapshots: readonly SurfaceSnapshot[];
  readonly root?: string;
  readonly generatedAtUtc?: string;
}): Promise<{manifest: CrossSectionManifest; shardsWritten: string[]; shardsReused: string[]}> {
  const root = input.root ?? CROSS_SECTION_CACHE_ROOT;
  const base = datasetRoot(root);
  const byShard = new Map<string, SurfaceSnapshot[]>();
  for (const snapshot of input.snapshots) {
    const shard = shardIdFor(snapshot.target_timestamp_ms);
    const list = byShard.get(shard);
    if (list) list.push(snapshot); else byShard.set(shard, [snapshot]);
  }

  const shardsWritten: string[] = [], shardsReused: string[] = [];
  for (const [shard, snapshots] of [...byShard].sort(([a], [b]) => a.localeCompare(b))) {
    const snapshotPath = join(base, `${shard}.snapshots.jsonl`);
    const observationPath = join(base, `${shard}.observations.jsonl`);
    const existingSnapshots = await readJsonl(snapshotPath);
    const existingObservations = await readJsonl(observationPath);

    const merged = new Map(existingSnapshots.map(r => [String(r.target_timestamp_ms), r]));
    const observations = new Map(existingObservations.map(r =>
      [`${String(r.target_timestamp_ms)}~${String(r.instrument_name)}~${String(r.trade_id)}~${String(r.timestamp_ms)}`, r]));
    for (const snapshot of snapshots) {
      // The snapshot row carries identity and geometry; observations live beside
      // it, so a diagnostics change never rewrites the evidence file.
      const {observations: rows, ...header} = snapshot;
      merged.set(String(snapshot.target_timestamp_ms), header as unknown as Row);
      for (const o of rows)
        observations.set(`${o.target_timestamp_ms}~${o.instrument_name}~${o.trade_id}~${o.timestamp_ms}`, o as unknown as Row);
    }
    const nextSnapshots = [...merged.values()].sort((a, b) => Number(a.target_timestamp_ms) - Number(b.target_timestamp_ms));
    const nextObservations = [...observations.values()].sort((a, b) =>
      Number(a.target_timestamp_ms) - Number(b.target_timestamp_ms)
      || String(a.instrument_name).localeCompare(String(b.instrument_name))
      || Number(a.timestamp_ms) - Number(b.timestamp_ms));

    const unchanged = JSON.stringify(nextSnapshots) === JSON.stringify(existingSnapshots)
      && JSON.stringify(nextObservations) === JSON.stringify(existingObservations);
    if (unchanged) { shardsReused.push(shard); continue; }
    await writeJsonl(snapshotPath, nextSnapshots);
    await writeJsonl(observationPath, nextObservations);
    shardsWritten.push(shard);
  }

  const shards = (await listCrossSectionShards(root)).sort();
  let snapshotCount = 0, observationCount = 0;
  const targets: number[] = [], hashes: string[] = [];
  for (const shard of shards) {
    const rows = await readJsonl(join(base, `${shard}.snapshots.jsonl`));
    snapshotCount += rows.length;
    for (const r of rows) { targets.push(Number(r.target_timestamp_ms)); hashes.push(String(r.content_hash)); }
    observationCount += (await readJsonl(join(base, `${shard}.observations.jsonl`))).length;
  }
  const manifest: CrossSectionManifest = {
    dataset_id: HISTORICAL_OPTION_IV_DATASET_ID,
    method_version: CROSS_SECTION_METHOD_VERSION,
    source_host: OPTION_HISTORY_HOST,
    generated_at_utc: input.generatedAtUtc ?? new Date().toISOString(),
    snapshot_count: snapshotCount, observation_count: observationCount,
    coverage_start_utc: targets.length ? new Date(Math.min(...targets)).toISOString() : null,
    coverage_end_utc: targets.length ? new Date(Math.max(...targets)).toISOString() : null,
    shards,
    // Generation time is deliberately excluded: rebuilding identical evidence
    // must produce an identical hash.
    content_hash: contentHash([...hashes].sort()),
  };
  await mkdir(base, {recursive: true});
  await writeFile(join(base, "manifest.json"), JSON.stringify(manifest, null, 1), "utf8");
  return {manifest, shardsWritten, shardsReused};
}

export async function listCrossSectionShards(root = CROSS_SECTION_CACHE_ROOT): Promise<string[]> {
  try {
    return (await readdir(datasetRoot(root)))
      .filter(f => f.endsWith(".snapshots.jsonl"))
      .map(f => f.replace(".snapshots.jsonl", ""))
      .sort();
  } catch { return []; }
}

export async function readCrossSectionSnapshots(shard: string, root = CROSS_SECTION_CACHE_ROOT): Promise<Row[]> {
  return readJsonl(join(datasetRoot(root), `${shard}.snapshots.jsonl`));
}

export async function readCrossSectionObservations(
  shard: string, root = CROSS_SECTION_CACHE_ROOT,
): Promise<CrossSectionObservation[]> {
  return (await readJsonl(join(datasetRoot(root), `${shard}.observations.jsonl`))) as unknown as CrossSectionObservation[];
}

export async function readCrossSectionManifest(root = CROSS_SECTION_CACHE_ROOT): Promise<CrossSectionManifest | null> {
  try { return JSON.parse(await readFile(join(datasetRoot(root), "manifest.json"), "utf8")) as CrossSectionManifest; }
  catch { return null; }
}
