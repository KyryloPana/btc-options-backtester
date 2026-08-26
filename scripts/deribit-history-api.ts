import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { buildInventory, parseDeribitTrade, type ContractTrade } from "../app/lib/backtester.ts";
import { deribitApiRequest, type FetchLike } from "./deribit-api-client.ts";

const API_PREFIX = "/__deribit/history";
const DAY_MS = 86_400_000;
const MAX_COUNT = 1_000;
const CACHE_VERSION = 2;

export interface DeribitInstrumentManifest {
  instrumentName: string;
  expiryTimestamp: number;
  expiryLabel: string;
  creationTimestamp?: number;
  strike: number;
  optionType: "C" | "P";
  status: "active" | "expired";
  priceIndex: string;
  minimumTradeAmount?: number;
  amountStep?: number;
  amountPrecision?: number;
  contractSize?: number;
  metadataSource: "deribit-get-instruments";
  metadataRetrievedAtUtc: string;
  authoritative: true;
}
export interface DesiredRequest { requestId: string; targetDte: number; minDte: number; maxDte: number; soldStrike: number; boughtStrike: number; optionType: "C" | "P" }
export interface DeribitDvolPoint { timestamp: number; open: number; high: number; low: number; close: number; source: "deribit-volatility-index" }
export interface DeribitCandidateManifest extends Omit<DesiredRequest, "soldStrike" | "boughtStrike"> {
  desiredSoldStrike: number; desiredBoughtStrike: number; expiryTimestamp: number; expiryLabel: string; actualDte: number;
  soldInstrumentName?: string; boughtInstrumentName?: string; soldStrike?: number; boughtStrike?: number;
  soldCreationTimestamp?: number; boughtCreationTimestamp?: number; strikeResolutionSensible: boolean; strikeResolutionNote: string;
  dataStatus?: "available" | "data-unavailable";
  contractStatus?: "exact_resolved"|"nearest_listed_resolved"|"confirmed_not_listed"|"retrieval_failure"|"metadata_unavailable";
  failedInstruments?: string[];
  retrievalErrors?: Array<{ instrumentName: string; cause: string; retryable: boolean }>;
  priceIndex?: string;
  deliveryPrice?: number;
  deliveryPriceDate?: string;
  deliveryPriceSource?: "deribit-get_delivery_prices";
}
interface ApiTrade { timestamp: number; price: number; mark_price?: number; iv?: number; instrument_name: string; index_price: number; direction: "buy" | "sell"; amount: number; trade_id?: string; trade_seq: number }

function expiryLabel(timestamp: number) { return new Date(timestamp).toISOString().slice(0, 10); }

/* ==================== same-expiry cross-section retrieval ==================== */

export const CROSS_SECTION_RETRIEVAL_VERSION = "same-expiry-ladder-v1";

/**
 * How many LISTED strikes either side of the structure's own strikes to retrieve.
 *
 * The validated interpolation tier needs the target strike genuinely bracketed
 * and at least five unique qualifying strikes on the expiry. Fetching only the
 * two chosen legs -- which is what production did before this -- makes that rule
 * unsatisfiable by construction, so the ladder is anchored on the STRUCTURE's
 * strikes rather than on spot: bracketing is a property of the leg, and as the
 * underlying drifts the leg is exactly what stops being near the traded region.
 *
 * Six per side comfortably clears the five-strike rule while bounding retrieval
 * to roughly thirty instruments per expiry. Chosen from coverage and retrieval
 * cost, never from pricing error or strategy results.
 */
export const LADDER_NEIGHBOUR_DEPTH = 6;

/**
 * Hard cap on how far the ladder may reach, in log-moneyness relative to the
 * nearest structure strike. On a sparse ladder six listed strikes can span an
 * absurd distance; a strike that far away carries no information about the
 * target and would only cost a retrieval.
 */
export const LADDER_MAX_LOG_MONEYNESS = 0.35;

export interface SameExpiryLadder {
  expiryTimestamp: number;
  expiryLabel: string;
  /** The structure strikes this ladder was built around. */
  targetStrikes: number[];
  strikes: number[];
  instrumentNames: string[];
  neighbourDepth: number;
  maxLogMoneyness: number;
  version: string;
}

/**
 * Listed strikes surrounding a structure's own strikes on one expiry.
 *
 * `chain` must already be gated on `creationTimestamp <= target`: a contract
 * that did not exist yet is not evidence, and including it here would smuggle a
 * causality breach into the pricing input.
 *
 * Both option types are returned. Under the project's forward = index, rate = 0
 * convention put-call parity makes a put and a call on one strike observations
 * of the same total-variance curve, and out-of-the-money puts populate the
 * downside where out-of-the-money calls simply do not trade.
 */
export function sameExpiryLadder(
  chain: DeribitInstrumentManifest[],
  targetStrikes: number[],
  neighbourDepth = LADDER_NEIGHBOUR_DEPTH,
  maxLogMoneyness = LADDER_MAX_LOG_MONEYNESS,
): SameExpiryLadder {
  const targets = [...new Set(targetStrikes.filter(s => Number.isFinite(s) && s > 0))].sort((a, b) => a - b);
  const listed = [...new Set(chain.map(x => x.strike))].sort((a, b) => a - b);
  const empty: SameExpiryLadder = {
    expiryTimestamp: chain[0]?.expiryTimestamp ?? 0,
    expiryLabel: chain[0]?.expiryLabel ?? "",
    targetStrikes: targets, strikes: [], instrumentNames: [],
    neighbourDepth, maxLogMoneyness, version: CROSS_SECTION_RETRIEVAL_VERSION,
  };
  if (!targets.length || !listed.length) return empty;

  const low = targets[0]!, high = targets[targets.length - 1]!;
  // Index span covering the structure's own strikes, extended by `neighbourDepth`
  // LISTED strikes each side -- listed rather than absolute, so a coarse ladder
  // still yields neighbours instead of an empty band.
  const belowIndex = listed.findIndex(s => s >= low);
  const aboveIndex = listed.reduce((last, s, i) => s <= high ? i : last, -1);
  const start = Math.max(0, (belowIndex === -1 ? listed.length : belowIndex) - neighbourDepth);
  const end = Math.min(listed.length - 1, (aboveIndex === -1 ? -1 : aboveIndex) + neighbourDepth);
  const strikes = listed.slice(start, end + 1)
    // Distance is measured to the NEAREST structure strike, so a wide structure
    // does not drag the cap outward on the far side.
    .filter(s => Math.min(...targets.map(t => Math.abs(Math.log(s / t)))) <= maxLogMoneyness);

  const keep = new Set(strikes);
  return {
    ...empty, strikes,
    instrumentNames: chain.filter(x => keep.has(x.strike))
      .map(x => x.instrumentName).sort(),
  };
}
/** Resolve both legs together so nearest-strike fallback cannot collapse a spread. */
export function resolveOrderedPair(chain: DeribitInstrumentManifest[], soldStrike: number, boughtStrike: number) {
  const expected = Math.sign(soldStrike - boughtStrike);
  if (expected === 0) return undefined;
  return chain.flatMap(sold => chain.map(bought => ({ sold, bought })))
    .filter(pair => pair.sold.instrumentName !== pair.bought.instrumentName && Math.sign(pair.sold.strike - pair.bought.strike) === expected)
    .sort((a, b) =>
      (Math.abs(a.sold.strike - soldStrike) + Math.abs(a.bought.strike - boughtStrike))
      - (Math.abs(b.sold.strike - soldStrike) + Math.abs(b.bought.strike - boughtStrike))
      || Math.abs(a.sold.strike - soldStrike) - Math.abs(b.sold.strike - soldStrike)
      || a.sold.strike - b.sold.strike
      || a.bought.strike - b.bought.strike)[0];
}

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
  private tradeDiagnostics = { receivedRows: 0, acceptedRows: 0, duplicateRows: 0, malformedRows: 0, identityUnavailableRows: 0, rejections: [] as Array<{ code: string; instrument: string; reason: string }> };
  constructor(baseUrl: string, cachePath: string, fetcher: FetchLike = fetch, concurrency = 4) {
    this.baseUrl = baseUrl;
    this.cachePath = cachePath;
    this.fetcher = fetcher;
    this.concurrency = concurrency;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async api(method: string, params: Record<string, string | number | boolean>) {
    return deribitApiRequest(this.fetcher, this.baseUrl, method, params, () => { this.requestCount += 1; });
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
        const minimumTradeAmount = Number(row.min_trade_amount);
        const amountStep = Number(row.amount_step ?? row.min_trade_amount);
        const amountPrecision = amountStep > 0 ? Math.max(0, (String(amountStep).split(".")[1] ?? "").length) : undefined;
        map.set(name, { instrumentName: name, expiryTimestamp: expiry, expiryLabel: expiryLabel(expiry), creationTimestamp: Number.isFinite(Number(row.creation_timestamp)) ? Number(row.creation_timestamp) : undefined, strike, optionType: type, status, priceIndex: String(row.price_index ?? "btc_usd"), minimumTradeAmount: minimumTradeAmount > 0 ? minimumTradeAmount : undefined, amountStep: amountStep > 0 ? amountStep : undefined, amountPrecision, contractSize:Number.isFinite(Number(row.contract_size))?Number(row.contract_size):undefined,metadataSource:"deribit-get-instruments",metadataRetrievedAtUtc:new Date().toISOString(),authoritative:true });
      }
      this.manifest = [...map.values()].sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike);
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify({ version: CACHE_VERSION, createdAt: new Date().toISOString(), instruments: this.manifest }), "utf8");
      this.phase = "ready";
    } catch (error) { this.phase = "error"; this.error = error instanceof Error ? error.message : "Manifest synchronization failed"; }
  }
  async waitUntilReady() { if (this.synchronizing) await this.synchronizing; if (this.phase !== "ready") throw new Error(this.error ?? "Deribit manifest is not ready"); }

  /** Official DVOL history. Values are percentages and are normalized here, never attached to an option contract. */
  async fetchDvolRange(start: number, end: number, resolution = 3600): Promise<DeribitDvolPoint[]> {
    const result = await this.api("get_volatility_index_data", { currency: "BTC", start_timestamp: start, end_timestamp: end, resolution }) as { data?: number[][] };
    return (result.data ?? []).flatMap(row => row.length >= 5 && row.slice(0, 5).every(Number.isFinite)
      ? [{ timestamp: row[0], open: row[1] / 100, high: row[2] / 100, low: row[3] / 100, close: row[4] / 100, source: "deribit-volatility-index" as const }]
      : []);
  }

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
      for (const trade of result.trades ?? []) if (trade.trade_seq >= first.trade_seq && trade.trade_seq <= last.trade_seq) {
        this.tradeDiagnostics.receivedRows++;
        const previous = bySeq.get(trade.trade_seq);
        if (previous) {
          const conflicts = Object.keys({ ...previous, ...trade }).filter(field => (previous as unknown as Record<string, unknown>)[field] !== (trade as unknown as Record<string, unknown>)[field]);
          if (conflicts.length) throw new Error(`Conflicting duplicate trade ${name} trade_seq:${trade.trade_seq}: ${conflicts.join(", ")}`);
          this.tradeDiagnostics.duplicateRows++; continue;
        }
        bySeq.set(trade.trade_seq, trade);
      }
      cursor = pageEnd + 1;
    }
    const missing: number[] = [];
    for (let seq = first.trade_seq; seq <= last.trade_seq; seq += 1) if (!bySeq.has(seq)) missing.push(seq);
    if (missing.length) throw new Error(`Incomplete trade sequence coverage for ${name}: ${missing.length} missing (${missing[0]}…${missing.at(-1)})`);
    const trades = [...bySeq.values()].filter(t => t.timestamp >= start && t.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp || a.trade_seq - b.trade_seq)
      .map(t => parseDeribitTrade({ ...t, instrument_name: t.instrument_name || name }))
      .filter((trade): trade is ContractTrade => { if (trade) { this.tradeDiagnostics.acceptedRows++; if (!trade.tradeId && !trade.tradeSeq) this.tradeDiagnostics.identityUnavailableRows++; return true; } this.tradeDiagnostics.malformedRows++; if (this.tradeDiagnostics.rejections.length < 10) this.tradeDiagnostics.rejections.push({ code: "invalid-row", instrument: name, reason: "Deribit returned a malformed trade row." }); return false; });
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

  async resolve(entryTimestamp: number, requests: DesiredRequest[], includeCrossSection = true) {
    this.tradeDiagnostics = { receivedRows: 0, acceptedRows: 0, duplicateRows: 0, malformedRows: 0, identityUnavailableRows: 0, rejections: [] };
    await this.loadCache(); await this.waitUntilReady();
    if (!Number.isFinite(entryTimestamp) || !Array.isArray(requests)) throw new Error("A valid entry timestamp and spread requests are required.");
    const requestStart = this.requestCount; const selected = new Map<string, DeribitInstrumentManifest>(); const candidates: DeribitCandidateManifest[] = []; const unavailable: string[] = [];
    for (const request of requests) {
      const expiries = [...new Set(this.manifest!.filter(x => x.optionType === request.optionType).map(x => x.expiryTimestamp))].filter(x => { const d = (x - entryTimestamp) / DAY_MS; return d >= request.minDte && d <= request.maxDte; }).sort((a,b)=>a-b);
      if (!expiries.length) unavailable.push(`${request.optionType} ~${request.targetDte}D: no expiry in ${request.minDte}–${request.maxDte}D band`);
      for (const expiry of expiries) {
        const chain = this.manifest!.filter(x => x.optionType === request.optionType && x.expiryTimestamp === expiry && (x.creationTimestamp === undefined || x.creationTimestamp <= entryTimestamp));
        const pair = resolveOrderedPair(chain, request.soldStrike, request.boughtStrike);
        const sold = pair?.sold, bought = pair?.bought;
        const sensible = Boolean(pair);
        candidates.push({ ...request, desiredSoldStrike: request.soldStrike, desiredBoughtStrike: request.boughtStrike, expiryTimestamp: expiry, expiryLabel: expiryLabel(expiry), actualDte: (expiry-entryTimestamp)/DAY_MS, soldInstrumentName: sold?.instrumentName, boughtInstrumentName: bought?.instrumentName, soldStrike: sold?.strike, boughtStrike: bought?.strike, soldCreationTimestamp: sold?.creationTimestamp, boughtCreationTimestamp: bought?.creationTimestamp, priceIndex: sold?.priceIndex ?? bought?.priceIndex ?? "btc_usd", strikeResolutionSensible: sensible, strikeResolutionNote: sensible ? `Resolved ${request.soldStrike}/${request.boughtStrike} to ${sold!.strike}/${bought!.strike}.` : "No distinct, correctly ordered strike pair known to exist at entry.",contractStatus:!sensible?"confirmed_not_listed":sold!.strike===request.soldStrike&&bought!.strike===request.boughtStrike?"exact_resolved":"nearest_listed_resolved" });
        if (sensible) { selected.set(sold!.instrumentName, sold!); selected.set(bought!.instrumentName, bought!); }
      }
    }
    // Same-expiry ladder, once per expiry and shared by every candidate on it.
    // `selected` is keyed by instrument name and fetchTradeRange is cached by
    // (name, start, end), so a strike shared by the 1k, 2k and 3k widths -- or by
    // the maker and taker scenarios -- is retrieved exactly once.
    const ladders: SameExpiryLadder[] = [];
    if (includeCrossSection) {
      const targetsByExpiry = new Map<number, Set<number>>();
      for (const candidate of candidates) {
        if (candidate.soldStrike === undefined || candidate.boughtStrike === undefined) continue;
        const set = targetsByExpiry.get(candidate.expiryTimestamp) ?? new Set<number>();
        set.add(candidate.soldStrike); set.add(candidate.boughtStrike);
        targetsByExpiry.set(candidate.expiryTimestamp, set);
      }
      for (const [expiry, targets] of [...targetsByExpiry].sort(([a], [b]) => a - b)) {
        // Both option types, and gated on listing time exactly as the leg chain is.
        const chain = this.manifest!.filter(x => x.expiryTimestamp === expiry
          && (x.creationTimestamp === undefined || x.creationTimestamp <= entryTimestamp));
        const ladder = sameExpiryLadder(chain, [...targets]);
        ladders.push(ladder);
        for (const name of ladder.instrumentNames) {
          const instrument = chain.find(x => x.instrumentName === name);
          if (instrument) selected.set(name, instrument);
        }
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
    const inventory = buildInventory(files).map(series => { const manifest = selected.get(series.instrumentName); const hasAmountRules = manifest?.minimumTradeAmount !== undefined && manifest.amountStep !== undefined && manifest.amountPrecision !== undefined; return { ...series, creationTimestamp: manifest?.creationTimestamp, amountMetadata: hasAmountRules ? { minimumTradeAmount: manifest.minimumTradeAmount!, amountStep: manifest.amountStep!, amountPrecision: manifest.amountPrecision!, source: "deribit-instrument-metadata" as const } : undefined }; });
    const legInstruments = new Set(candidates.flatMap(c =>
      [c.soldInstrumentName, c.boughtInstrumentName].filter((x): x is string => Boolean(x))));
    const crossSection = {
      version: CROSS_SECTION_RETRIEVAL_VERSION,
      enabled: includeCrossSection,
      neighbourDepth: LADDER_NEIGHBOUR_DEPTH,
      maxLogMoneyness: LADDER_MAX_LOG_MONEYNESS,
      entryTimestamp,
      ladders,
      // Reuse evidence: distinct instruments actually retrieved against the
      // number of candidate legs that consume them.
      expiriesCovered: ladders.length,
      ladderInstrumentCount: new Set(ladders.flatMap(l => l.instrumentNames)).size,
      legInstrumentCount: legInstruments.size,
      candidateLegSlots: candidates.length * 2,
      instrumentsRetrieved: selected.size,
      tradeCacheHits: cacheHits,
      apiRequests: this.requestCount - requestStart,
    };
    return { complete: failures.length === 0, inventory, candidates, crossSection, failures: failures.map(failure => ({ ...failure, requestIds: candidates.filter(candidate => candidate.failedInstruments?.includes(failure.instrumentName)).map(candidate => candidate.requestId), candidateIds: candidates.filter(candidate => candidate.failedInstruments?.includes(failure.instrumentName)).map(candidate => `${candidate.requestId}:${candidate.expiryTimestamp}`) })), deliveryFailures, diagnostics: { indexedContracts: this.manifest!.length, selectedContracts: selected.size, contractsLoaded: files.length, cacheHits, apiRequestCount: this.requestCount-requestStart, failedContracts: failures.map(failure => failure.instrumentName), unavailableRequests: unavailable, candidateExpiries: candidates.length, validTrades: inventory.reduce((n,x)=>n+x.trades.length,0), tradeRows: { ...this.tradeDiagnostics, acceptedRows: inventory.reduce((n,x)=>n+x.trades.length,0) } } };
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) { response.statusCode=status; response.setHeader("Content-Type","application/json; charset=utf-8"); response.setHeader("Cache-Control","no-store"); response.end(JSON.stringify(payload)); }
async function body(request: IncomingMessage) { const chunks: Buffer[]=[]; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; }
export function deribitHistoryApiPlugin(options: { baseUrl: string; cachePath: string; fetcher?: FetchLike }): Plugin {
  const service = new DeribitHistoryService(options.baseUrl, options.cachePath, options.fetcher);
  return { name: "deribit-history-api", apply: "serve", configureServer(server) { server.middlewares.use(API_PREFIX, async (req,res,next) => { const path=new URL(req.url??"/","http://localhost").pathname.replace(API_PREFIX,"")||"/"; try { if(req.method==="GET"&&path==="/status") return sendJson(res,200,await service.status()); if(req.method==="POST"&&path==="/index") { const data=await body(req); return sendJson(res,202,await service.startIndex(data.force===true)); } if(req.method==="POST"&&path==="/resolve") { const data=await body(req); return sendJson(res,200,await service.resolve(Number(data.entryTimestamp),(data.requests??[]) as DesiredRequest[],data.includeCrossSection!==false)); } next(); } catch(error) { sendJson(res,400,{error:error instanceof Error?error.message:"Deribit history request failed"}); } }); } };
}
