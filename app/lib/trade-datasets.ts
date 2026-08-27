import type { BacktestEvent } from "./backtester";

export const TRADE_DATASET_SCHEMA_VERSION = 1 as const;
export interface TradeDataset { schemaVersion: 1; datasetId: string; name: string; updatedAt: string; trades: BacktestEvent[] }
export interface TradeDatasetSummary { datasetId: string; name: string; filename: string; tradeCount: number; updatedAt: string }
export interface DatasetValidationError { tradeId?: string; path: string; message: string }
export interface ImportSummary { added: number; unchanged: number; replaced: number; conflicts: number; rejected: number }
export type ImportMode = "separate" | "combine-current";
export type ConflictResolution = "keep-existing" | "replace-imported";

const ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value: unknown) { return typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)); }
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value); }
export function validateTradeDataset(value: unknown): { ok: true; dataset: TradeDataset } | { ok: false; errors: DatasetValidationError[] } {
  const errors: DatasetValidationError[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: [{ path: "$", message: "Dataset must be a JSON object." }] };
  const dataset = value as Partial<TradeDataset>;
  if (dataset.schemaVersion !== 1) errors.push({ path: "schemaVersion", message: "Expected schema version 1." });
  if (typeof dataset.datasetId !== "string" || !ID.test(dataset.datasetId)) errors.push({ path: "datasetId", message: "Use a safe lowercase ID containing letters, numbers, and hyphens." });
  if (typeof dataset.name !== "string" || !dataset.name.trim()) errors.push({ path: "name", message: "Name is required." });
  if (typeof dataset.updatedAt !== "string" || !Number.isFinite(Date.parse(dataset.updatedAt))) errors.push({ path: "updatedAt", message: "A valid ISO-8601 timestamp is required." });
  if (!Array.isArray(dataset.trades)) errors.push({ path: "trades", message: "Trades must be an array." });
  const seen = new Set<string>();
  for (const [index, tradeValue] of (Array.isArray(dataset.trades) ? dataset.trades : []).entries()) {
    const trade = tradeValue as BacktestEvent; const tradeId = typeof trade?.id === "string" ? trade.id : `#${index}`;
    const add = (path: string, message: string) => errors.push({ tradeId, path: `trades[${index}].${path}`, message });
    if (!trade || typeof trade !== "object") { add("$", "Trade must be an object."); continue; }
    if (!trade.id || typeof trade.id !== "string") add("id", "Stable trade ID is required."); else if (seen.has(trade.id)) add("id", "Trade ID must be unique."); else seen.add(trade.id);
    if (typeof trade.label !== "string" || !trade.label.trim()) add("label", "Label is required.");
    if (trade.direction !== "long" && trade.direction !== "short") add("direction", "Direction must be long or short.");
    if (!validDate(trade.entryDate)) add("entryDate", "A valid YYYY-MM-DD date is required.");
    for (const field of ["exitDate", "extremeDate", "vpocDate"] as const) if (trade[field] !== undefined && !validDate(trade[field])) add(field, "A valid YYYY-MM-DD date is required when present.");
    if (!finite(trade.entryPrice)) add("entryPrice", "A finite number is required.");
    if (trade.exitPrice !== undefined && !finite(trade.exitPrice)) add("exitPrice", "A finite number is required when present.");
    for (const field of ["extremePrice", "extremeTimestamp", "vpocPrice", "vpocTimestamp", "invalidationPrice", "rangeLow", "rangeHigh", "entryTimestamp", "exitTimestamp"] as const) if (trade[field] !== undefined && !finite(trade[field])) add(field, "Must be a finite number when present.");
    // A date and a timestamp describing the SAME semantic point must agree on the
    // UTC day. Timestamps are never inferred from dates, nor dates from
    // timestamps -- disagreement is reported, not repaired.
    for (const [dateField, timeField, label] of [
      ["entryDate", "entryTimestamp", "First-touch timestamp must fall on the entry date."],
      ["exitDate", "exitTimestamp", "Exit timestamp must fall on the exit date."],
      ["extremeDate", "extremeTimestamp", "Extreme timestamp must fall on the extreme date."],
      ["vpocDate", "vpocTimestamp", "VPOC timestamp must fall on the VPOC date."],
    ] as const) {
      const day = trade[dateField], instant = trade[timeField];
      if (instant === undefined || !finite(instant) || !validDate(day)) continue;
      const start = Date.parse(`${day}T00:00:00Z`);
      if (instant < start || instant >= start + 86_400_000) add(timeField, label);
    }
    if (validDate(trade.entryDate) && validDate(trade.exitDate) && Date.parse(`${trade.exitDate}T00:00:00Z`) < Date.parse(`${trade.entryDate}T00:00:00Z`)) add("exitDate", "Exit cannot precede entry.");
    if (trade.entryTimestamp !== undefined && trade.exitTimestamp !== undefined && trade.exitTimestamp < trade.entryTimestamp) add("exitTimestamp", "Exit timestamp cannot precede first touch.");
    if (trade.entryTimeSource !== undefined && !["manual", "resolved", "provisional"].includes(trade.entryTimeSource)) add("entryTimeSource", "Unknown entry time source.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, dataset: dataset as TradeDataset };
}
export function mergeTradeDatasets(current: TradeDataset, imported: TradeDataset, resolution: ConflictResolution) {
  const trades = [...current.trades], byId = new Map(trades.map((trade,index)=>[trade.id,index]));
  const summary: ImportSummary = { added:0, unchanged:0, replaced:0, conflicts:0, rejected:0 };
  for (const trade of imported.trades) { const index=byId.get(trade.id); if (index === undefined) { byId.set(trade.id,trades.length); trades.push(trade); summary.added++; continue; } if (JSON.stringify(trades[index])===JSON.stringify(trade)) { summary.unchanged++; continue; } summary.conflicts++; if (resolution === "replace-imported") { trades[index]=trade; summary.replaced++; } }
  return { dataset:{...current,trades}, summary };
}
export function canLeaveDirty(dirty: boolean, confirmDiscard: () => boolean) { return !dirty || confirmDiscard(); }
