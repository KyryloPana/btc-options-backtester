import type { BacktestEvent, Direction } from "./lib/backtester";

interface MrTrade {
  id: string;
  direction: Direction;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  stopLoss: number;
  takeProfit?: number;
  notes?: string;
}

export interface DurationMove {
  id: string;
  startDate: string;
  startTime: string;
  startPrice: number;
  endDate: string;
  endTime: string;
  endPrice: number;
  rangeLow?: number;
  rangeHigh?: number;
  entryDate?: string;
  entryTime?: string;
  entryPrice?: number;
  notes?: string;
}

export const MR_TRADES: MrTrade[] = [
  { id: "43e5f62c", direction: "long", entryDate: "2024-01-27", entryPrice: 41800, exitDate: "2024-03-05", exitPrice: 59200, stopLoss: 38500, notes: "Trail upward into new range" },
  { id: "d099f278", direction: "long", entryDate: "2024-05-04", entryPrice: 63700, exitDate: "2024-06-18", exitPrice: 65000, stopLoss: 56350, takeProfit: 73970 },
  { id: "467ced0c", direction: "long", entryDate: "2024-07-14", entryPrice: 60110, exitDate: "2024-08-02", exitPrice: 62100, stopLoss: 53000, takeProfit: 73970 },
  { id: "1c454ed4", direction: "long", entryDate: "2024-08-07", entryPrice: 57000, exitDate: "2024-12-20", exitPrice: 94000, stopLoss: 48650, notes: "vPOC changed 22 Sep 2024; old high-volume node retained." },
  { id: "5bebaf8f", direction: "long", entryDate: "2025-01-14", entryPrice: 94490, exitDate: "2025-01-20", exitPrice: 101980, stopLoss: 88800 },
  { id: "653f11df", direction: "short", entryDate: "2025-01-22", entryPrice: 103700, exitDate: "2025-03-31", exitPrice: 82150, stopLoss: 110450, notes: "No vPOC trade; waited for BO because vPOC was too close." },
  { id: "6b6e9aed", direction: "long", entryDate: "2025-04-10", entryPrice: 81610, exitDate: "2025-05-24", exitPrice: 106820, stopLoss: 73700, takeProfit: 106820 },
  { id: "2a93d290", direction: "short", entryDate: "2025-05-24", entryPrice: 108800, exitDate: "2025-06-06", exitPrice: 104230, stopLoss: 112400 },
  { id: "920cb392", direction: "long", entryDate: "2025-06-07", entryPrice: 105700, exitDate: "2025-06-21", exitPrice: 102000, stopLoss: 100100, notes: "Early close before a failed breakout." },
  { id: "f7a352c4", direction: "long", entryDate: "2025-06-24", entryPrice: 105000, exitDate: "2025-07-25", exitPrice: 115560, stopLoss: 98000 },
  { id: "17339625", direction: "short", entryDate: "2025-10-08", entryPrice: 122490, exitDate: "2025-10-20", exitPrice: 111010, stopLoss: 126500 },
  { id: "1656764f", direction: "long", entryDate: "2025-10-20", entryPrice: 111010, exitDate: "2025-11-04", exitPrice: 101500, stopLoss: 101500 },
  { id: "fe7bba5f", direction: "short", entryDate: "2026-01-18", entryPrice: 95110, exitDate: "2026-02-05", exitPrice: 62970, stopLoss: 98400 },
  { id: "3e29cf29", direction: "short", entryDate: "2026-04-19", entryPrice: 75490, exitDate: "2026-04-22", exitPrice: 78500, stopLoss: 78500 },
  { id: "1f046e00", direction: "long", entryDate: "2026-06-08", entryPrice: 63800, exitDate: "2026-06-18", exitPrice: 64450, stopLoss: 58900 },
];

export const DURATION_MOVES: DurationMove[] = [
  { id: "df4f2d1c", startDate: "2024-01-23", startTime: "08:00", startPrice: 38550, endDate: "2024-01-30", endTime: "00:00", endPrice: 43710 },
  { id: "ef4ea323", startDate: "2024-05-01", startTime: "08:00", startPrice: 56540, endDate: "2024-05-17", endTime: "12:00", endPrice: 67000, rangeLow: 56540, rangeHigh: 73880, entryDate: "2024-05-04", entryTime: "00:00", entryPrice: 62800 },
  { id: "a9eb100b", startDate: "2024-07-05", startTime: "04:00", startPrice: 53350, endDate: "2024-07-19", endTime: "16:00", endPrice: 67000, rangeLow: 53350, rangeHigh: 73880, entryDate: "2024-07-14", entryTime: "04:00", entryPrice: 60800 },
  { id: "77c278ba", startDate: "2024-08-05", startTime: "04:00", startPrice: 48850, endDate: "2024-10-15", endTime: "12:00", endPrice: 67000, rangeLow: 48850, rangeHigh: 73880, entryDate: "2024-08-09", entryTime: "00:00", entryPrice: 60800 },
  { id: "ac1be9f3", startDate: "2025-01-13", startTime: "12:00", startPrice: 89000, endDate: "2025-01-15", endTime: "00:00", endPrice: 98000, rangeLow: 89000, rangeHigh: 108370, entryDate: "2025-01-15", entryTime: "00:00", entryPrice: 96520 },
  { id: "146ee836", startDate: "2025-01-20", startTime: "04:00", startPrice: 110010, endDate: "2025-02-02", endTime: "16:00", endPrice: 96490, rangeLow: 89000, rangeHigh: 110010, entryDate: "2025-01-27", entryTime: "00:00", entryPrice: 102570 },
  { id: "510cacab", startDate: "2025-04-07", startTime: "04:00", startPrice: 74450, endDate: "2025-04-11", endTime: "12:00", endPrice: 83980, rangeLow: 74450, rangeHigh: 95040, entryDate: "2025-04-10", entryTime: "00:00", entryPrice: 82590 },
  { id: "c2ba0aa7", startDate: "2025-06-05", startTime: "20:00", startPrice: 100290, endDate: "2025-06-06", endTime: "04:00", endPrice: 104000, rangeLow: 100300, rangeHigh: 112020 },
  { id: "eeb91c40", startDate: "2025-06-22", startTime: "12:00", startPrice: 98120, endDate: "2025-06-23", endTime: "20:00", endPrice: 104500, rangeLow: 98120, rangeHigh: 112020 },
  { id: "b9ca5a53", startDate: "2025-10-06", startTime: "12:00", startPrice: 126270, endDate: "2025-10-10", endTime: "12:00", endPrice: 118040, rangeLow: 107200, rangeHigh: 126270, entryDate: "2025-10-08", entryTime: "00:00", entryPrice: 121300 },
  { id: "3a44bdaf", startDate: "2026-01-05", startTime: "12:00", startPrice: 94810, endDate: "2026-01-08", endTime: "00:00", endPrice: 90000, rangeLow: 80680, rangeHigh: 94810, entryDate: "2026-01-08", entryTime: "00:00", entryPrice: 91360 },
  { id: "c50beadd", startDate: "2026-01-14", startTime: "12:00", startPrice: 97930, endDate: "2026-01-20", endTime: "04:00", endPrice: 90000, rangeLow: 80680, rangeHigh: 94810, entryDate: "2026-01-19", entryTime: "00:00", entryPrice: 93620 },
  { id: "7761cdec", startDate: "2026-06-05", startTime: "16:00", startPrice: 59160, endDate: "2026-06-15", endTime: "08:00", endPrice: 67000, rangeLow: 59160, rangeHigh: 82980, entryDate: "2026-06-08", entryTime: "00:00", entryPrice: 63350 },
  { id: "9466da09", startDate: "2026-07-01", startTime: "00:00", startPrice: 57770, endDate: "2026-07-21", endTime: "08:00", endPrice: 66930, rangeLow: 57770, rangeHigh: 82980, entryDate: "2026-07-03", entryTime: "00:00", entryPrice: 61560, notes: "Missed vPOC by $70; retained because it would not change the options test." },
];

function within(date: string, start: string, end: string) {
  const value = Date.parse(`${date}T00:00:00Z`);
  return value >= Date.parse(`${start}T00:00:00Z`) && value <= Date.parse(`${end}T23:59:59Z`);
}

export const BUNDLED_EVENTS: BacktestEvent[] = MR_TRADES.map((trade, index) => {
  const move = DURATION_MOVES.find(candidate => {
    const moveDirection: Direction = candidate.endPrice >= candidate.startPrice ? "long" : "short";
    return moveDirection === trade.direction && within(trade.entryDate, candidate.startDate, candidate.endDate);
  });
  return {
    id: trade.id,
    label: `MR-${String(index + 1).padStart(2, "0")} · ${trade.entryDate}`,
    direction: trade.direction,
    entryDate: trade.entryDate,
    entryPrice: trade.entryPrice,
    exitDate: trade.exitDate,
    exitPrice: trade.exitPrice,
    extremePrice: move?.startPrice,
    vpocPrice: move?.endPrice,
    vpocDate: move?.endDate,
    vpocTimestamp: move ? Date.parse(`${move.endDate}T${move.endTime}:00Z`) : undefined,
    invalidationPrice: trade.stopLoss,
    rangeLow: move?.rangeLow,
    rangeHigh: move?.rangeHigh,
    notes: [trade.notes, move?.notes].filter(Boolean).join(" ") || undefined,
  };
});

export const SAMPLE_CONTRACT_JSONL = `{"trade_seq":2,"trade_id":"70764851","timestamp":1585710843731,"tick_direction":2,"price":0.0565,"mark_price":0.05720568,"iv":0.0,"instrument_name":"BTC-1APR20-6000-C","index_price":6361.95,"direction":"buy","amount":0.1}
{"trade_seq":1,"trade_id":"70667494","timestamp":1585642884585,"tick_direction":1,"price":0.074,"mark_price":0.0753062,"iv":99.25,"instrument_name":"BTC-1APR20-6000-C","index_price":6468.91,"direction":"buy","amount":2.0}`;

export function durationSummary() {
  const hours = DURATION_MOVES.map(move => (Date.parse(`${move.endDate}T${move.endTime}:00Z`) - Date.parse(`${move.startDate}T${move.startTime}:00Z`)) / 3_600_000).sort((a, b) => a - b);
  const entryToTarget = DURATION_MOVES.filter(move => move.entryDate).map(move => (Date.parse(`${move.endDate}T${move.endTime}:00Z`) - Date.parse(`${move.entryDate}T${move.entryTime ?? "00:00"}:00Z`)) / 3_600_000).filter(value => value >= 0).sort((a, b) => a - b);
  const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * p)))] ?? 0;
  return {
    count: hours.length,
    medianMoveHours: percentile(hours, 0.5),
    p25EntryToTargetHours: percentile(entryToTarget, 0.25),
    medianEntryToTargetHours: percentile(entryToTarget, 0.5),
    p75EntryToTargetHours: percentile(entryToTarget, 0.75),
  };
}

