import type { Candle } from "./backtester.ts";

/** Validate the serialized OHLC boundary once; all internal timestamps are milliseconds. */
export function parseOhlcCandles(payload: unknown, start: number, end: number): Candle[] {
  const rows = (payload as { candles?: unknown[] } | null)?.candles;
  if (!Array.isArray(rows)) throw new Error(`BTC candle response for ${start}…${end} has no candles array.`);
  const candles = rows.flatMap(row => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    const candle = { openTime:Number(value.openTime),closeTime:Number(value.closeTime),open:Number(value.open),high:Number(value.high),low:Number(value.low),close:Number(value.close),volume:Number(value.volume) };
    return Number.isFinite(candle.openTime)&&Number.isFinite(candle.closeTime)&&candle.openTime>1e12&&candle.closeTime>candle.openTime&&Number.isFinite(candle.close)&&candle.close>0?[candle]:[];
  }).sort((a,b)=>a.openTime-b.openTime);
  if (!candles.length) throw new Error(`BTC candle response for ${start}…${end} contained zero valid millisecond candles.`);
  const interval=Math.max(1,candles[0].closeTime-candles[0].openTime);
  if(candles[0].openTime>start+interval||candles.at(-1)!.closeTime<end-interval)throw new Error(`BTC candle range incomplete: requested ${start}…${end}; received ${candles[0].openTime}…${candles.at(-1)!.closeTime} (${candles.length} candles).`);
  return candles;
}
