import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { deribitApiRequest, type FetchLike } from "./deribit-api-client.ts";

const API_PREFIX = "/__deribit/perpetual";
const HOUR_MS = 3_600_000;
/** get_funding_rate_history caps a single response at 744 hourly rows and truncates from the start. */
const FUNDING_CHUNK_MS = 28 * 86_400_000;
const TRADE_PAGE = 100;
const TRADE_MAX_PAGES = 20;

export const PERPETUAL_RETRIEVAL_VERSION = "deribit-perpetual-retrieval-v1" as const;
export const PERPETUAL_REFERENCE_SOURCE = "deribit-get_tradingview_chart_data" as const;
export const PERPETUAL_FUNDING_SOURCE = "deribit-get_funding_rate_history" as const;
export const PERPETUAL_TRADE_SOURCE = "deribit-get_last_trades_by_instrument_and_time" as const;
export const PERPETUAL_INSTRUMENT_SOURCE = "deribit-get_instrument" as const;
/** Deribit's history mirror does not serve funding; funding is read from the main public host. */
export const PERPETUAL_FUNDING_HOST = "https://www.deribit.com/api/v2/public" as const;

export interface PerpetualChartResult { ticks?: number[]; open?: number[]; high?: number[]; low?: number[]; close?: number[]; volume?: number[]; status?: string }
export interface PerpetualFundingApiRow { timestamp: number; index_price?: number; prev_index_price?: number; interest_1h?: number; interest_8h?: number }
export interface PerpetualTradeApiRow { trade_id?: string; trade_seq?: number; timestamp: number; price: number; mark_price?: number; index_price?: number; direction?: string; amount?: number }

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const floorTo = (value: number, step: number) => Math.floor(value / step) * step;

export class DeribitPerpetualHistoryService {
  private historyBaseUrl: string;
  private fundingBaseUrl: string;
  private fetcher: FetchLike;
  private requestCount = 0;

  constructor(historyBaseUrl: string, fundingBaseUrl: string = PERPETUAL_FUNDING_HOST, fetcher: FetchLike = fetch) {
    this.historyBaseUrl = historyBaseUrl.replace(/\/$/, "");
    this.fundingBaseUrl = fundingBaseUrl.replace(/\/$/, "");
    this.fetcher = fetcher;
  }

  private api(baseUrl: string, method: string, params: Record<string, string | number | boolean>) {
    return deribitApiRequest(this.fetcher, baseUrl, method, params, () => { this.requestCount += 1; });
  }

  /** Authoritative contract conventions: contract size, tick size and the venue's own commission schedule. */
  async instrument(instrumentName: string, retrievedAtUtc = new Date().toISOString()) {
    const row = await this.api(this.historyBaseUrl, "get_instrument", { instrument_name: instrumentName }) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Deribit returned no instrument metadata for ${instrumentName}.`);
    return {
      instrumentName: String(row.instrument_name ?? instrumentName),
      kind: String(row.kind ?? ""),
      settlementPeriod: String(row.settlement_period ?? ""),
      futureType: typeof row.future_type === "string" ? row.future_type : null,
      isActive: row.is_active === true,
      contractSizeUsd: finite(row.contract_size),
      tickSize: finite(row.tick_size),
      minTradeAmountUsd: finite(row.min_trade_amount),
      makerCommission: finite(row.maker_commission),
      takerCommission: finite(row.taker_commission),
      priceIndex: typeof row.price_index === "string" ? row.price_index : null,
      settlementCurrency: typeof row.settlement_currency === "string" ? row.settlement_currency : null,
      source: PERPETUAL_INSTRUMENT_SOURCE,
      retrievedAtUtc,
      authoritative: true as const,
    };
  }

  /**
   * Causal OHLC bars for the perpetual itself. Gaps are reported, never filled:
   * a bar Deribit did not return stays absent from the series.
   */
  async referenceSeries(instrumentName: string, start: number, end: number, resolutionMinutes = 60) {
    const resolutionMs = resolutionMinutes * 60_000;
    const requestedStart = floorTo(start, resolutionMs);
    const requestedEnd = floorTo(end, resolutionMs);
    const result = await this.api(this.historyBaseUrl, "get_tradingview_chart_data", {
      instrument_name: instrumentName, start_timestamp: requestedStart, end_timestamp: requestedEnd, resolution: resolutionMinutes,
    }) as PerpetualChartResult | undefined;
    const ticks = result?.ticks ?? [];
    const points = ticks.flatMap((tick, index) => {
      const timestamp = finite(tick), open = finite(result?.open?.[index]), high = finite(result?.high?.[index]);
      const low = finite(result?.low?.[index]), close = finite(result?.close?.[index]);
      if (timestamp === null || open === null || high === null || low === null || close === null) return [];
      if (open <= 0 || close <= 0) return [];
      return [{ timestamp, price: close, open, high, low, close, volume: finite(result?.volume?.[index]) ?? undefined }];
    }).sort((a, b) => a.timestamp - b.timestamp);
    const present = new Set(points.map(point => point.timestamp));
    const expected: number[] = [];
    for (let cursor = requestedStart; cursor <= requestedEnd; cursor += resolutionMs) expected.push(cursor);
    const missingTimestamps = expected.filter(timestamp => !present.has(timestamp));
    return {
      points,
      coverage: {
        source: PERPETUAL_REFERENCE_SOURCE, apiStatus: String(result?.status ?? "unavailable"), resolutionMs,
        requestedStart, requestedEnd, expectedPoints: expected.length, receivedPoints: points.length,
        missingPoints: missingTimestamps.length,
        missingTimestamps: missingTimestamps.slice(0, 200),
        missingTimestampsTruncated: missingTimestamps.length > 200,
        status: points.length === 0 ? "unavailable" as const : missingTimestamps.length ? "partial" as const : "complete" as const,
        forwardFilled: false as const,
      },
    };
  }

  /**
   * Official hourly funding. A single response is capped, so the window is
   * walked in chunks; hours the venue did not return stay missing.
   */
  async fundingHistory(instrumentName: string, start: number, end: number) {
    const requestedStart = floorTo(start, HOUR_MS), requestedEnd = floorTo(end, HOUR_MS);
    const byTimestamp = new Map<number, { timestamp: number; rate: number; rate8h: number | null; indexPrice: number | null }>();
    for (let cursor = requestedStart; cursor <= requestedEnd; cursor += FUNDING_CHUNK_MS) {
      const chunkEnd = Math.min(cursor + FUNDING_CHUNK_MS, requestedEnd);
      const rows = await this.api(this.fundingBaseUrl, "get_funding_rate_history", {
        instrument_name: instrumentName, start_timestamp: cursor, end_timestamp: chunkEnd,
      }) as PerpetualFundingApiRow[] | undefined;
      for (const row of rows ?? []) {
        const timestamp = finite(row.timestamp), rate = finite(row.interest_1h);
        if (timestamp === null || rate === null) continue;
        byTimestamp.set(timestamp, { timestamp, rate, rate8h: finite(row.interest_8h), indexPrice: finite(row.index_price) });
      }
      if (chunkEnd >= requestedEnd) break;
    }
    const points = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
    const expected: number[] = [];
    for (let cursor = requestedStart + HOUR_MS; cursor <= requestedEnd; cursor += HOUR_MS) expected.push(cursor);
    const missing = expected.filter(timestamp => !byTimestamp.has(timestamp));
    return {
      points,
      coverage: {
        source: PERPETUAL_FUNDING_SOURCE, host: this.fundingBaseUrl, intervalMs: HOUR_MS, rateField: "interest_1h",
        requestedStart, requestedEnd, expectedPoints: expected.length, receivedPoints: points.length,
        missingPoints: missing.length, missingTimestamps: missing.slice(0, 200), missingTimestampsTruncated: missing.length > 200,
        status: points.length === 0 ? "unavailable" as const : missing.length ? "partial" as const : "complete" as const,
        assumedZeroWhenMissing: false as const,
      },
    };
  }

  /** The first real perpetual prints at or after a decision timestamp. Never paged unbounded. */
  async tradesAtOrAfter(instrumentName: string, start: number, end: number, wanted = TRADE_PAGE) {
    const collected: PerpetualTradeApiRow[] = [];
    let cursor = start;
    for (let page = 0; page < TRADE_MAX_PAGES && collected.length < wanted && cursor <= end; page += 1) {
      const result = await this.api(this.historyBaseUrl, "get_last_trades_by_instrument_and_time", {
        instrument_name: instrumentName, start_timestamp: cursor, end_timestamp: end, count: TRADE_PAGE, sorting: "asc",
      }) as { trades?: PerpetualTradeApiRow[]; has_more?: boolean } | undefined;
      const rows = (result?.trades ?? []).filter(row => finite(row.timestamp) !== null && finite(row.price) !== null);
      collected.push(...rows);
      if (!rows.length || result?.has_more !== true) break;
      const last = rows[rows.length - 1].timestamp;
      cursor = last + 1;
    }
    return collected.slice(0, wanted).map(row => ({
      tradeId: String(row.trade_id ?? row.trade_seq ?? ""),
      timestamp: row.timestamp,
      price: row.price,
      markPrice: finite(row.mark_price),
      indexPrice: finite(row.index_price),
      amountUsd: finite(row.amount) ?? 0,
      direction: row.direction === "buy" ? "buy" as const : row.direction === "sell" ? "sell" as const : null,
      source: PERPETUAL_TRADE_SOURCE,
    })).filter(trade => trade.tradeId !== "" && trade.direction !== null);
  }

  /**
   * One retrieval pass producing the persisted event-level perpetual snapshot.
   * Every sub-retrieval fails independently: a funding outage still yields a
   * valid price series, and is recorded as unavailable rather than as zero.
   */
  async baseline(input: { instrument: string; start: number; end: number; resolutionMinutes?: number; orderTimestamp?: number; direction?: string }) {
    const retrievedAtUtc = new Date().toISOString();
    const requestStart = this.requestCount;
    const instrumentName = input.instrument;
    if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.end <= input.start) throw new Error("A valid perpetual retrieval window is required.");
    const errors: Array<{ stage: string; cause: string; retryable: boolean }> = [];
    const attempt = async <T>(stage: string, run: () => Promise<T>): Promise<T | undefined> => {
      try { return await run(); } catch (error) {
        const cause = error instanceof Error ? error.message : `${stage} failed`;
        errors.push({ stage, cause, retryable: /network|fetch|408|429|HTTP 5\d\d|after retries/i.test(cause) });
        return undefined;
      }
    };
    const metadata = await attempt("instrument", () => this.instrument(instrumentName, retrievedAtUtc));
    const series = await attempt("reference", () => this.referenceSeries(instrumentName, input.start, input.end, input.resolutionMinutes ?? 60));
    const funding = await attempt("funding", () => this.fundingHistory(instrumentName, input.start, input.end));
    const wantedDirection = input.direction === "long" ? "buy" : input.direction === "short" ? "sell" : null;
    const trades = input.orderTimestamp !== undefined && Number.isFinite(input.orderTimestamp)
      ? await attempt("trades", () => this.tradesAtOrAfter(instrumentName, input.orderTimestamp!, Math.min(input.orderTimestamp! + HOUR_MS, input.end)))
      : undefined;
    const firstMatching = wantedDirection && trades ? trades.find(trade => trade.direction === wantedDirection) : undefined;
    return {
      snapshot: {
        instrument: instrumentName,
        instrumentKind: metadata?.settlementPeriod === "perpetual" ? "perpetual" as const : "dated_future" as const,
        source: "deribit" as const,
        priceBasis: "traded_ohlc" as const,
        retrievedAtUtc,
        retrievalVersion: PERPETUAL_RETRIEVAL_VERSION,
        instrumentMetadata: metadata ?? null,
        reference: series?.points ?? [],
        referenceCoverage: series?.coverage ?? null,
        funding: funding && funding.points.length ? funding.points : undefined,
        fundingCoverage: funding?.coverage ?? null,
        trades: firstMatching ? [firstMatching] : trades?.length ? [trades[0]] : undefined,
        feeRate: metadata?.takerCommission ?? undefined,
        retrievalErrors: errors,
      },
      diagnostics: { apiRequestCount: this.requestCount - requestStart, errors },
    };
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

export function deribitPerpetualApiPlugin(options: { historyBaseUrl: string; fundingBaseUrl?: string; fetcher?: FetchLike }): Plugin {
  const service = new DeribitPerpetualHistoryService(options.historyBaseUrl, options.fundingBaseUrl ?? PERPETUAL_FUNDING_HOST, options.fetcher);
  return {
    name: "deribit-perpetual-api", apply: "serve",
    configureServer(server) {
      server.middlewares.use(API_PREFIX, async (req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname.replace(API_PREFIX, "") || "/";
        try {
          if (req.method === "POST" && path === "/baseline") {
            const data = await body(req);
            return sendJson(res, 200, await service.baseline({
              instrument: String(data.instrument ?? "BTC-PERPETUAL"),
              start: Number(data.start), end: Number(data.end),
              resolutionMinutes: data.resolutionMinutes === undefined ? undefined : Number(data.resolutionMinutes),
              orderTimestamp: data.orderTimestamp === undefined ? undefined : Number(data.orderTimestamp),
              direction: data.direction === undefined ? undefined : String(data.direction),
            }));
          }
          next();
        } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Perpetual history request failed" }); }
      });
    },
  };
}
