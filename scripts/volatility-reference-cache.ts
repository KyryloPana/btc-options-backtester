import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {deribitApiRequest, type FetchLike} from "./deribit-api-client.ts";
import {
  DERIBIT_OPTION_INDEX_UNDERLYING, DVOL_HOST, DVOL_SERIES_ID, OPTION_HISTORY_HOST, REFERENCE_SERIES_ID,
  buildDvolRows, buildReferenceSeriesManifest, dvolSeriesIdentity, isCurrentReferenceRow, shardIdFor,
  type DvolPoint, type DvolSeriesRow, type ReferenceSeriesManifest, type ReferenceSeriesRow,
} from "../app/lib/volatility/reference-series.ts";
import {CANONICAL_RV_UNDERLYING, type HourlyClose} from "../app/lib/volatility/realized-volatility.ts";

/**
 * Retrieval and the versioned shard cache for the volatility reference series.
 *
 * This is the only place in the volatility foundation that performs IO; the
 * methodology lives in pure modules so it can be tested without a network.
 *
 * HOST ROUTING preserves the asymmetry established by the capability audit and
 * already used for perpetual funding:
 *
 *   - expired option instruments and their trade tape -> history.deribit.com
 *     (`www` returns only the most recent expiry batch and no expired trades)
 *   - the volatility index (DVOL)                     -> www.deribit.com
 *     (the history mirror answers HTTP 400 for this method)
 *
 * Shards are monthly JSONL so expanding the MR event sample reuses everything
 * already retrieved instead of redownloading it.
 */

export const VOLATILITY_CACHE_ROOT = ".local-cache/volatility-reference" as const;
export const VOLATILITY_RETRIEVAL_VERSION = "volatility-reference-retrieval-v2" as const;
export const VOLATILITY_TRADE_PAGE_SIZE = 1000 as const;

export interface DeribitOptionInstrument {
  readonly instrumentName: string;
  readonly strike: number;
  readonly optionType: "C" | "P";
  readonly expiryTimestampMs: number;
  readonly createdAtMs: number | null;
  readonly settlementPeriod: string | null;
}

export interface DeribitIvTradeRow {
  readonly instrumentName: string;
  readonly tradeId: string | null;
  readonly tradeSeq: number | null;
  readonly timestampMs: number;
  readonly ivApiPercent: number | null;
  readonly price: number | null;
  readonly markPrice: number | null;
  readonly indexPrice: number | null;
  readonly direction: string | null;
  readonly amount: number | null;
}

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;

/* ============================== retrieval ============================== */

export class VolatilityReferenceRetrieval {
  private readonly fetcher: FetchLike;
  private readonly optionHost: string;
  private readonly dvolHost: string;
  private manifestCache?: DeribitOptionInstrument[];
  /** Trade pages already fetched, keyed by instrument+window, to avoid refetching. */
  private readonly tradeCache = new Map<string, DeribitIvTradeRow[]>();
  public requestCount = 0;

  constructor(options: {fetcher?: FetchLike; optionHost?: string; dvolHost?: string} = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.optionHost = options.optionHost ?? OPTION_HISTORY_HOST;
    this.dvolHost = options.dvolHost ?? DVOL_HOST;
  }

  private api(host: string, method: string, params: Record<string, string | number | boolean>) {
    return deribitApiRequest(this.fetcher, host, method, params, () => { this.requestCount += 1; });
  }

  /**
   * Retrieve a provably complete interval. Deribit's trade methods expose
   * `has_more`, but no opaque continuation token; recursively bisecting a
   * saturated interval avoids timestamp-cursor gaps. An unsplittable saturated
   * millisecond fails loudly instead of becoming false market unavailability.
   */
  private async completeTrades(method:string,base:Record<string,string|number|boolean>,startMs:number,endMs:number):Promise<Record<string,unknown>[]> {
    const visit=async(start:number,end:number):Promise<Array<Record<string,unknown>>>=>{
      const result=await this.api(this.optionHost,method,{...base,start_timestamp:start,end_timestamp:end,count:VOLATILITY_TRADE_PAGE_SIZE,sorting:"asc"}) as {trades?:Record<string,unknown>[];has_more?:boolean}|undefined;
      const page=result?.trades??[],saturated=result?.has_more===true||(result?.has_more===undefined&&page.length>=VOLATILITY_TRADE_PAGE_SIZE);
      if(!saturated)return page;
      if(start>=end)throw new Error(`${method} returned an incomplete saturated trade millisecond at ${start}.`);
      const midpoint=Math.floor((start+end)/2);return [...await visit(start,midpoint),...await visit(midpoint+1,end)];
    };
    const rows=await visit(startMs,endMs),deduped=new Map<string,Record<string,unknown>>();
    for(const row of rows){const instrument=str(row.instrument_name)??String(base.instrument_name??"BTC-options"),timestamp=num(row.timestamp),id=str(row.trade_id),seq=num(row.trade_seq),identity=id!==null?`id:${id}`:seq!==null?`seq:${seq}`:`fallback:${timestamp}:${num(row.price)}:${num(row.amount)}:${str(row.direction)}`;deduped.set(`${instrument}:${identity}`,row)}
    return [...deduped.values()].sort((a,b)=>(num(a.timestamp)??0)-(num(b.timestamp)??0)||String(a.instrument_name??base.instrument_name??"").localeCompare(String(b.instrument_name??base.instrument_name??""))||(num(a.trade_seq)??0)-(num(b.trade_seq)??0)||String(a.trade_id??"").localeCompare(String(b.trade_id??"")));
  }

  /**
   * The expired+active option manifest, from the HISTORY mirror. `www` returns
   * only the latest expiry batch, which silently makes historical research
   * impossible, so the host is not configurable away by accident.
   */
  async instrumentManifest(force = false): Promise<DeribitOptionInstrument[]> {
    if (this.manifestCache && !force) return this.manifestCache;
    const rows: DeribitOptionInstrument[] = [];
    for (const expired of [true, false]) {
      const result = await this.api(this.optionHost, "get_instruments",
        {currency: "BTC", kind: "option", expired}) as Record<string, unknown>[] | undefined;
      for (const row of result ?? []) {
        const name = str(row.instrument_name), expiry = num(row.expiration_timestamp), strike = num(row.strike);
        const type = row.option_type === "call" ? "C" : row.option_type === "put" ? "P" : null;
        if (!name || expiry === null || strike === null || !type) continue;
        rows.push({
          instrumentName: name, strike, optionType: type, expiryTimestampMs: expiry,
          createdAtMs: num(row.creation_timestamp),
          settlementPeriod: str(row.settlement_period),
        });
      }
    }
    this.manifestCache = rows;
    return rows;
  }

  /** IV-bearing prints for one instrument inside a causal window. */
  async ivTrades(instrumentName: string, startMs: number, endMs: number): Promise<DeribitIvTradeRow[]> {
    const key = `${instrumentName}:${startMs}:${endMs}`;
    const cached = this.tradeCache.get(key);
    if (cached) return cached;
    const result = await this.completeTrades("get_last_trades_by_instrument_and_time",{instrument_name:instrumentName},startMs,endMs);
    const rows = result.flatMap<DeribitIvTradeRow>(t => {
      const timestamp = num(t.timestamp);
      if (timestamp === null) return [];
      return [{
        instrumentName, tradeId: str(t.trade_id), tradeSeq: num(t.trade_seq),
        timestampMs: timestamp, ivApiPercent: num(t.iv), price: num(t.price),
        markPrice: num(t.mark_price), indexPrice: num(t.index_price),
        direction: str(t.direction), amount: num(t.amount),
      }];
    });
    this.tradeCache.set(key, rows);
    return rows;
  }

  /** One hourly cross-market window, used by the canonical percentile series. */
  async ivTradesByCurrency(startMs: number, endMs: number): Promise<DeribitIvTradeRow[]> {
    const key = `BTC-options:${startMs}:${endMs}`;
    const cached = this.tradeCache.get(key);
    if (cached) return cached;
    const result=await this.completeTrades("get_last_trades_by_currency_and_time",{currency:"BTC",kind:"option"},startMs,endMs);
    const rows=result.flatMap<DeribitIvTradeRow>(t=>{const instrumentName=str(t.instrument_name),timestampMs=num(t.timestamp);return !instrumentName||timestampMs===null?[]:[{instrumentName,tradeId:str(t.trade_id),tradeSeq:num(t.trade_seq),timestampMs,ivApiPercent:num(t.iv),price:num(t.price),markPrice:num(t.mark_price),indexPrice:num(t.index_price),direction:str(t.direction),amount:num(t.amount)}]});
    this.tradeCache.set(key,rows);return rows;
  }

  /**
   * DVOL, from the MAIN host. The history mirror does not serve the volatility
   * index, the same way it does not serve perpetual funding.
   */
  async dvolRange(startMs: number, endMs: number, resolutionSeconds = 3600): Promise<DvolPoint[]> {
    const result = await this.api(this.dvolHost, "get_volatility_index_data",
      {currency: "BTC", start_timestamp: startMs, end_timestamp: endMs, resolution: resolutionSeconds}) as {data?: number[][]} | undefined;
    return (result?.data ?? []).flatMap<DvolPoint>(row => {
      const [timestampMs, open, high, low, close] = row;
      if (![timestampMs, open, high, low, close].every(v => typeof v === "number" && Number.isFinite(v))) return [];
      return [{timestampMs: timestampMs!, open: open!, high: high!, low: low!, close: close!}];
    });
  }
}

/**
 * Hourly closes for realized volatility, from the canonical BTC-PERPETUAL
 * series. Reuses the existing perpetual reference-series shape rather than
 * introducing a second underlying pipeline, and never falls back to a
 * different venue.
 */
export function hourlyClosesFromPerpetualSeries(
  points: readonly {timestamp: number; close?: number | null; price?: number | null}[],
): HourlyClose[] {
  return points.flatMap<HourlyClose>(p => {
    const close = num(p.close) ?? num(p.price);
    return close === null || !Number.isFinite(p.timestamp) ? [] : [{timestampMs: p.timestamp, close}];
  }).sort((a, b) => a.timestampMs - b.timestampMs);
}
export const RV_UNDERLYING_INSTRUMENT = CANONICAL_RV_UNDERLYING;

/* ============================== shard cache ============================== */

export interface ShardWriteResult {
  readonly seriesId: string;
  readonly shardsWritten: readonly string[];
  readonly shardsReused: readonly string[];
  readonly manifest: ReferenceSeriesManifest;
}

const shardPath = (root: string, seriesId: string, shardId: string) => join(root, seriesId, `${shardId}.jsonl`);
const manifestPath = (root: string, seriesId: string) => join(root, seriesId, "manifest.json");

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as T);
  } catch { return []; }
}

/** Rows already cached for a shard, so a rebuild need not refetch it. */
export async function readReferenceShard(shardId: string, root: string = VOLATILITY_CACHE_ROOT): Promise<ReferenceSeriesRow[]> {
  return readJsonl<ReferenceSeriesRow>(shardPath(root, REFERENCE_SERIES_ID, shardId));
}
export async function readDvolShard(shardId: string, root: string = VOLATILITY_CACHE_ROOT): Promise<DvolSeriesRow[]> {
  return readJsonl<DvolSeriesRow>(shardPath(root, DVOL_SERIES_ID, shardId));
}

export async function listCachedShards(seriesId: string = REFERENCE_SERIES_ID, root: string = VOLATILITY_CACHE_ROOT): Promise<string[]> {
  try {
    return (await readdir(join(root, seriesId)))
      .filter(f => f.endsWith(".jsonl")).map(f => f.replace(/\.jsonl$/, "")).sort();
  } catch { return []; }
}

/**
 * Merge rows into monthly shards and rewrite the manifest.
 *
 * A shard whose content is unchanged is reported as reused rather than
 * rewritten, which is what makes expanding the event sample cheap. Row identity
 * inside a shard is (timestamp, tenor), so regenerating the same target
 * replaces rather than duplicates.
 */
export async function writeReferenceShards(input: {
  readonly rows: readonly ReferenceSeriesRow[];
  readonly underlyingInstrument?: string;
  readonly generatedAtUtc?: string;
  readonly root?: string;
}): Promise<ShardWriteResult> {
  const root = input.root ?? VOLATILITY_CACHE_ROOT;
  const byShard = new Map<string, ReferenceSeriesRow[]>();
  for (const row of input.rows) {
    const shard = shardIdFor(row.timestamp_ms);
    const list = byShard.get(shard);
    if (list) list.push(row); else byShard.set(shard, [row]);
  }
  const written: string[] = [], reused: string[] = [];
  for (const [shard, incoming] of [...byShard.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = shardPath(root, REFERENCE_SERIES_ID, shard);
    const existing = await readJsonl<ReferenceSeriesRow>(path);
    const merged = new Map<string, ReferenceSeriesRow>();
    for (const row of [...existing.filter(isCurrentReferenceRow), ...incoming.filter(isCurrentReferenceRow)]) merged.set(`${row.timestamp_ms}~${row.nominal_tenor}`, row);
    const ordered = [...merged.values()].sort((a, b) =>
      a.timestamp_ms - b.timestamp_ms || a.nominal_tenor.localeCompare(b.nominal_tenor));
    const serialized = ordered.map(r => JSON.stringify(r)).join("\n") + "\n";
    const before = existing.map(r => JSON.stringify(r)).join("\n") + "\n";
    if (existing.length && before === serialized) { reused.push(shard); continue; }
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, serialized, "utf8");
    written.push(shard);
  }

  // The manifest describes the WHOLE series, not just this write.
  const all: ReferenceSeriesRow[] = [];
  for (const shard of await listCachedShards(REFERENCE_SERIES_ID, root)) all.push(...(await readReferenceShard(shard, root)).filter(isCurrentReferenceRow));
  const manifest = buildReferenceSeriesManifest({
    rows: all.length ? all : [...input.rows],
    underlyingInstrument: input.underlyingInstrument ?? DERIBIT_OPTION_INDEX_UNDERLYING,
    generatedAtUtc: input.generatedAtUtc ?? new Date().toISOString(),
  });
  const mPath = manifestPath(root, REFERENCE_SERIES_ID);
  await mkdir(dirname(mPath), {recursive: true});
  await writeFile(mPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {seriesId: REFERENCE_SERIES_ID, shardsWritten: written, shardsReused: reused, manifest};
}

export async function readReferenceManifest(root: string = VOLATILITY_CACHE_ROOT): Promise<ReferenceSeriesManifest | null> {
  try { return JSON.parse(await readFile(manifestPath(root, REFERENCE_SERIES_ID), "utf8")) as ReferenceSeriesManifest; }
  catch { return null; }
}

/** DVOL shards live under their own series id so the two can never be confused. */
export async function writeDvolShards(input: {
  readonly points: readonly DvolPoint[];
  readonly root?: string;
  readonly resolutionSeconds?: number;
}): Promise<{seriesId: string; shardsWritten: string[]; identity: ReturnType<typeof dvolSeriesIdentity>}> {
  const root = input.root ?? VOLATILITY_CACHE_ROOT;
  const rows = buildDvolRows(input.points, input.resolutionSeconds ?? 3600);
  const byShard = new Map<string, DvolSeriesRow[]>();
  for (const row of rows) {
    const shard = shardIdFor(row.timestamp_ms);
    const list = byShard.get(shard);
    if (list) list.push(row); else byShard.set(shard, [row]);
  }
  const written: string[] = [];
  for (const [shard, incoming] of [...byShard.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = shardPath(root, DVOL_SERIES_ID, shard);
    const existing = await readJsonl<DvolSeriesRow>(path);
    const merged = new Map<number, DvolSeriesRow>();
    for (const row of [...existing, ...incoming]) merged.set(row.timestamp_ms, row);
    const ordered = [...merged.values()].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, ordered.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    written.push(shard);
  }
  const identity = dvolSeriesIdentity(rows);
  const mPath = manifestPath(root, DVOL_SERIES_ID);
  await mkdir(dirname(mPath), {recursive: true});
  await writeFile(mPath, JSON.stringify({...identity, retrieval_version: VOLATILITY_RETRIEVAL_VERSION}, null, 2) + "\n", "utf8");
  return {seriesId: DVOL_SERIES_ID, shardsWritten: written, identity};
}
