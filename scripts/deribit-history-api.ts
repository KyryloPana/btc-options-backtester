import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { buildInventory, type ContractTrade } from "../app/lib/backtester.ts";

const API_PREFIX = "/__deribit/history";
const DAY_MS = 86_400_000;
const MAX_COUNT = 1_000;
const CACHE_VERSION = 1;

export interface DeribitInstrumentManifest {
  instrumentName: string;
  expiryTimestamp: number;
  expiryLabel: string;
  creationTimestamp?: number;
  strike: number;
  optionType: "C" | "P";
  status: "active" | "expired";
  priceIndex: string;
}
export interface DesiredRequest { requestId: string; targetDte: number; minDte: number; maxDte: number; soldStrike: number; boughtStrike: number; optionType: "C" | "P" }
export interface DeribitCandidateManifest extends DesiredRequest {
  desiredSoldStrike: number; desiredBoughtStrike: number; expiryTimestamp: number; expiryLabel: string; actualDte: number;
  soldInstrumentName?: string; boughtInstrumentName?: string; soldStrike?: number; boughtStrike?: number;
  soldCreationTimestamp?: number; boughtCreationTimestamp?: number; strikeResolutionSensible: boolean; strikeResolutionNote: string;
  dataStatus?: "available" | "data-unavailable";
  failedInstruments?: string[];
  retrievalErrors?: Array<{ instrumentName: string; cause: string; retryable: boolean }>;
  priceIndex?: string;
  deliveryPrice?: number;
  deliveryPriceDate?: string;
  deliveryPriceSource?: "deribit-get_delivery_prices";
}
interface ApiTrade { timestamp: number; price: number; mark_price?: number; iv?: number; instrument_name: string; index_price: number; direction: "buy" | "sell"; amount: number; trade_id?: string; trade_seq: number }
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function expiryLabel(timestamp: number) { return new Date(timestamp).toISOString().slice(0, 10); }
function nearest(chain: DeribitInstrumentManifest[], strike: number) { return [...chain].sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike) || a.strike - b.strike)[0]; }

export class DeribitHistoryService {
  private baseUrl: string;
  private cachePath: string;
  private fetcher: FetchLike;
  private concurrency: number;
  private manifest?: DeribitInstrumentManifest[];
  private manifestChecked = false;
  private synchronizing?: Promise<void>;
  private phase: "idle" | "synchronizing" | "ready" | "error" = "idle";
  private error?: string;
  private requestCount = 0;
  private tradeCache = new Map<string, ContractTrade[]>();
  private deliveryPriceCache = new Map<string, number>();
  constructor(baseUrl: string, cachePath: string, fetcher: FetchLike = fetch, concurrency = 4) {
    this.baseUrl = baseUrl;
    this.cachePath = cachePath;
    this.fetcher = fetcher;
    this.concurrency = concurrency;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async api(method: string, params: Record<string, string | number | boolean>) {
    const url = new URL(`${this.baseUrl}/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      this.requestCount += 1;
      const response = await this.fetcher(url);
      if (response.ok) {
        const payload = await response.json() as { result?: unknown; error?: { message?: string } };
        if (payload.error) throw new Error(payload.error.message ?? "Deribit API error");
        return payload.result;
      }
      if (![408, 429].includes(response.status) && response.status < 500) throw new Error(`Deribit HTTP ${response.status}`);
      if (attempt === 4) throw new Error(`Deribit HTTP ${response.status} after retries`);
      const retry = response.headers.get("retry-after");
      const delay = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(Date.parse(retry) - Date.now(), 0)) : 250 * 2 ** attempt;
      await sleep(Math.min(delay, 10_000));
    }
  }

  private async loadCache() {
    if (this.manifestChecked) return;
    this.manifestChecked = true;
    try {
      const cached = JSON.parse(await readFile(this.cachePath, "utf8"));
      if (cached.version === CACHE_VERSION && Array.isArray(cached.instruments)) { this.manifest = cached.instruments; this.phase = "ready"; }
    } catch { /* Cache is optional. */ }
  }
  async status() { await this.loadCache(); return { phase: this.phase, contractsFound: this.manifest?.length ?? 0, error: this.error }; }
  async startIndex(force = false) {
    await this.loadCache();
    if (this.synchronizing) return this.status();
    if (this.manifest && !force) return this.status();
    this.phase = "synchronizing"; this.error = undefined;
    this.synchronizing = this.syncManifest().finally(() => { this.synchronizing = undefined; });
    return this.status();
  }
  private async syncManifest() {
    try {
      const [expired, active] = await Promise.all([
        this.api("get_instruments", { currency: "BTC", kind: "option", expired: true }),
        this.api("get_instruments", { currency: "BTC", kind: "option", expired: false }),
      ]) as [Record<string, unknown>[], Record<string, unknown>[]];
      const map = new Map<string, DeribitInstrumentManifest>();
      for (const [rows, status] of [[expired, "expired"], [active, "active"]] as const) for (const row of rows ?? []) {
        const name = String(row.instrument_name ?? ""); const expiry = Number(row.expiration_timestamp); const strike = Number(row.strike);
        const type = row.option_type === "call" ? "C" : row.option_type === "put" ? "P" : undefined;
        if (!name || !Number.isFinite(expiry) || !Number.isFinite(strike) || !type) continue;
        map.set(name, { instrumentName: name, expiryTimestamp: expiry, expiryLabel: expiryLabel(expiry), creationTimestamp: Number.isFinite(Number(row.creation_timestamp)) ? Number(row.creation_timestamp) : undefined, strike, optionType: type, status, priceIndex: String(row.price_index ?? "btc_usd") });
      }
      this.manifest = [...map.values()].sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike);
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify({ version: CACHE_VERSION, createdAt: new Date().toISOString(), instruments: this.manifest }), "utf8");
      this.phase = "ready";
    } catch (error) { this.phase = "error"; this.error = error instanceof Error ? error.message : "Manifest synchronization failed"; }
  }
  async waitUntilReady() { if (this.synchronizing) await this.synchronizing; if (this.phase !== "ready") throw new Error(this.error ?? "Deribit manifest is not ready"); }

  private async boundary(name: string, start: number, end: number, sorting: "asc" | "desc") {
    const result = await this.api("get_last_trades_by_instrument", { instrument_name: name, start_timestamp: start, end_timestamp: end, count: 1, sorting }) as { trades?: ApiTrade[] };
    return result.trades?.[0];
  }
  async fetchTradeRange(name: string, start: number, end: number): Promise<ContractTrade[]> {
    const key = `${name}:${start}:${end}`; const cached = this.tradeCache.get(key); if (cached) return cached;
    const [first, last] = await Promise.all([this.boundary(name, start, end, "asc"), this.boundary(name, start, end, "desc")]);
    if (!first || !last) { this.tradeCache.set(key, []); return []; }
    const bySeq = new Map<number, ApiTrade>();
    for (let cursor = first.trade_seq; cursor <= last.trade_seq;) {
      const pageEnd = Math.min(cursor + MAX_COUNT - 1, last.trade_seq);
      const result = await this.api("get_last_trades_by_instrument", { instrument_name: name, start_seq: cursor, end_seq: pageEnd, count: MAX_COUNT, sorting: "asc" }) as { trades?: ApiTrade[] };
      for (const trade of result.trades ?? []) if (trade.trade_seq >= first.trade_seq && trade.trade_seq <= last.trade_seq) bySeq.set(trade.trade_seq, trade);
      cursor = pageEnd + 1;
    }
    const missing: number[] = [];
    for (let seq = first.trade_seq; seq <= last.trade_seq; seq += 1) if (!bySeq.has(seq)) missing.push(seq);
    if (missing.length) throw new Error(`Incomplete trade sequence coverage for ${name}: ${missing.length} missing (${missing[0]}…${missing.at(-1)})`);
    const trades = [...bySeq.values()].filter(t => t.timestamp >= start && t.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp || a.trade_seq - b.trade_seq).map(t => ({ timestamp: t.timestamp, price: t.price, markPrice: t.mark_price, iv: t.iv, instrumentName: t.instrument_name || name, indexPrice: t.index_price, direction: t.direction, amount: t.amount, tradeId: t.trade_id ?? String(t.trade_seq) }));
    this.tradeCache.set(key, trades); return trades;
  }

  async fetchDeliveryPrices(indexName: string, requiredDates: string[]) {
    const unresolved = new Set(requiredDates.filter(date => !this.deliveryPriceCache.has(`${indexName}:${date}`)));
    for (let offset = 0; unresolved.size; offset += MAX_COUNT) {
      const result = await this.api("get_delivery_prices", { index_name: indexName, count: MAX_COUNT, offset }) as { data?: Array<{ date: string | number; delivery_price: number }>; records_total?: number };
      const rows = result.data ?? [];
      for (const row of rows) {
        const date = typeof row.date === "number" ? new Date(row.date).toISOString().slice(0, 10) : String(row.date).slice(0, 10);
        const price = Number(row.delivery_price);
        if (Number.isFinite(price)) { this.deliveryPriceCache.set(`${indexName}:${date}`, price); unresolved.delete(date); }
      }
      if (rows.length < MAX_COUNT || offset + rows.length >= (result.records_total ?? Infinity)) break;
    }
    return new Map(requiredDates.flatMap(date => {
      const price = this.deliveryPriceCache.get(`${indexName}:${date}`);
      return price === undefined ? [] : [[date, price] as const];
    }));
  }

  async resolve(entryTimestamp: number, requests: DesiredRequest[]) {
    await this.loadCache(); await this.waitUntilReady();
    if (!Number.isFinite(entryTimestamp) || !Array.isArray(requests)) throw new Error("A valid entry timestamp and spread requests are required.");
    const requestStart = this.requestCount; const selected = new Map<string, DeribitInstrumentManifest>(); const candidates: DeribitCandidateManifest[] = []; const unavailable: string[] = [];
    for (const request of requests) {
      const expiries = [...new Set(this.manifest!.filter(x => x.optionType === request.optionType).map(x => x.expiryTimestamp))].filter(x => { const d = (x - entryTimestamp) / DAY_MS; return d >= request.minDte && d <= request.maxDte; }).sort((a,b)=>a-b);
      if (!expiries.length) unavailable.push(`${request.optionType} ~${request.targetDte}D: no expiry in ${request.minDte}–${request.maxDte}D band`);
      for (const expiry of expiries) {
        const chain = this.manifest!.filter(x => x.optionType === request.optionType && x.expiryTimestamp === expiry && (x.creationTimestamp === undefined || x.creationTimestamp <= entryTimestamp));
        const sold = nearest(chain, request.soldStrike), bought = nearest(chain, request.boughtStrike); const expected = Math.sign(request.soldStrike-request.boughtStrike), actual = sold && bought ? Math.sign(sold.strike-bought.strike) : 0;
        const sensible = Boolean(sold && bought && sold.instrumentName !== bought.instrumentName && expected === actual);
        candidates.push({ ...request, desiredSoldStrike: request.soldStrike, desiredBoughtStrike: request.boughtStrike, expiryTimestamp: expiry, expiryLabel: expiryLabel(expiry), actualDte: (expiry-entryTimestamp)/DAY_MS, soldInstrumentName: sold?.instrumentName, boughtInstrumentName: bought?.instrumentName, soldStrike: sold?.strike, boughtStrike: bought?.strike, soldCreationTimestamp: sold?.creationTimestamp, boughtCreationTimestamp: bought?.creationTimestamp, priceIndex: sold?.priceIndex ?? bought?.priceIndex ?? "btc_usd", strikeResolutionSensible: sensible, strikeResolutionNote: sensible ? `Resolved ${request.soldStrike}/${request.boughtStrike} to ${sold!.strike}/${bought!.strike}.` : "No distinct, correctly ordered strike pair known to exist at entry." });
        if (sensible) { selected.set(sold!.instrumentName, sold!); selected.set(bought!.instrumentName, bought!); }
      }
    }
    const files: Array<{name:string;trades:ContractTrade[]}> = [], failures: Array<{ instrumentName: string; cause: string; retryable: boolean }> = []; let cacheHits = 0;
    const jobs = [...selected.values()]; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.concurrency, jobs.length) }, async () => { while (cursor < jobs.length) { const item = jobs[cursor++]; const key = `${item.instrumentName}:${entryTimestamp-7*DAY_MS}:${item.expiryTimestamp}`; if (this.tradeCache.has(key)) cacheHits += 1; try { files.push({ name: item.instrumentName, trades: await this.fetchTradeRange(item.instrumentName, entryTimestamp-7*DAY_MS, item.expiryTimestamp) }); } catch (error) { const cause = error instanceof Error ? error.message : "Unknown retrieval failure"; failures.push({ instrumentName: item.instrumentName, cause, retryable: /network|408|429|HTTP 5\d\d|after retries/i.test(cause) }); } } }));
    const deliveryFailures: Array<{ indexName: string; cause: string; retryable: boolean }> = [];
    for (const indexName of new Set(candidates.map(candidate => candidate.priceIndex ?? "btc_usd"))) {
      const relevant = candidates.filter(candidate => (candidate.priceIndex ?? "btc_usd") === indexName);
      const dates = [...new Set(relevant.map(candidate => new Date(candidate.expiryTimestamp).toISOString().slice(0, 10)))];
      try {
        const prices = await this.fetchDeliveryPrices(indexName, dates);
        for (const candidate of relevant) {
          const date = new Date(candidate.expiryTimestamp).toISOString().slice(0, 10);
          candidate.deliveryPriceDate = date;
          candidate.deliveryPrice = prices.get(date);
          if (candidate.deliveryPrice !== undefined) candidate.deliveryPriceSource = "deribit-get_delivery_prices";
        }
      } catch (error) {
        const cause = error instanceof Error ? error.message : "Unknown delivery-price retrieval failure";
        deliveryFailures.push({ indexName, cause, retryable: /network|408|429|HTTP 5\d\d|after retries/i.test(cause) });
        for (const candidate of relevant) candidate.deliveryPriceDate = new Date(candidate.expiryTimestamp).toISOString().slice(0, 10);
      }
    }
    for (const candidate of candidates) {
      const affected = failures.filter(failure => failure.instrumentName === candidate.soldInstrumentName || failure.instrumentName === candidate.boughtInstrumentName);
      candidate.dataStatus = affected.length ? "data-unavailable" : "available";
      if (affected.length) { candidate.failedInstruments = affected.map(failure => failure.instrumentName); candidate.retrievalErrors = affected; }
    }
    const inventory = buildInventory(files).map(series => { const manifest = selected.get(series.instrumentName); return { ...series, creationTimestamp: manifest?.creationTimestamp }; });
    return { complete: failures.length === 0, inventory, candidates, failures: failures.map(failure => ({ ...failure, requestIds: candidates.filter(candidate => candidate.failedInstruments?.includes(failure.instrumentName)).map(candidate => candidate.requestId), candidateIds: candidates.filter(candidate => candidate.failedInstruments?.includes(failure.instrumentName)).map(candidate => `${candidate.requestId}:${candidate.expiryTimestamp}`) })), deliveryFailures, diagnostics: { indexedContracts: this.manifest!.length, selectedContracts: selected.size, contractsLoaded: files.length, cacheHits, apiRequestCount: this.requestCount-requestStart, failedContracts: failures.map(failure => failure.instrumentName), unavailableRequests: unavailable, candidateExpiries: candidates.length, validTrades: inventory.reduce((n,x)=>n+x.trades.length,0) } };
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) { response.statusCode=status; response.setHeader("Content-Type","application/json; charset=utf-8"); response.setHeader("Cache-Control","no-store"); response.end(JSON.stringify(payload)); }
async function body(request: IncomingMessage) { const chunks: Buffer[]=[]; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
export function deribitHistoryApiPlugin(options: { baseUrl: string; cachePath: string; fetcher?: FetchLike }): Plugin {
  const service = new DeribitHistoryService(options.baseUrl, options.cachePath, options.fetcher);
  return { name: "deribit-history-api", apply: "serve", configureServer(server) { server.middlewares.use(API_PREFIX, async (req,res,next) => { const path=new URL(req.url??"/","http://localhost").pathname.replace(API_PREFIX,"")||"/"; try { if(req.method==="GET"&&path==="/status") return sendJson(res,200,await service.status()); if(req.method==="POST"&&path==="/index") { const data=await body(req); return sendJson(res,202,await service.startIndex(data.force===true)); } if(req.method==="POST"&&path==="/resolve") { const data=await body(req); return sendJson(res,200,await service.resolve(Number(data.entryTimestamp),(data.requests??[]) as DesiredRequest[])); } next(); } catch(error) { sendJson(res,400,{error:error instanceof Error?error.message:"Deribit history request failed"}); } }); } };
}
