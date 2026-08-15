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
