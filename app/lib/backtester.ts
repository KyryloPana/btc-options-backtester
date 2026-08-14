import { aggregateRoutedFees, calculateOptionFee, STANDARD_INVERSE_BTC_OPTION_FEE, type ExecutionRoute, type FeeCalculation } from "./accounting.ts";

export type Direction = "long" | "short";
export type OptionType = "C" | "P";
export type TradeSide = "buy" | "sell";
export type ExecutionMode = "maker" | "taker";
export type SpreadKind = "credit" | "debit";
export type QualityFlag = "green" | "yellow" | "red";
export type ValuationStatus = QualityFlag | "settlement" | "underlying-unavailable";
export type ValuationSource = "trade-window" | "model-fallback" | "unavailable" | "settlement" | "settlement-data-unavailable";
export type BtcIndexSource = "event-entry-price" | "completed-candle" | "deribit-delivery-price" | "unavailable";
export type ExpirySelectionMode = "liquidity-aware" | "closest-dte" | "all-eligible";
export type ValuationPurpose = "entry" | "close" | "settlement";
export type CandidateDataStatus = "available" | "data-unavailable";
export type SignalPrecision = "trade" | "millisecond" | "second" | "minute" | "candle" | "manual";
export type FillStatus = "filled" | "no-fill" | "insufficient-amount" | "stale-evidence" | "data-unavailable" | "missing-contract" | "opportunity-only";
export type EventOutcome = "executed" | "no-trade:no-executable-structure" | "no-trade:no-entry-fill" | "data-unavailable" | "entered-exit-unfilled" | "settled";

export interface ExecutionClock {
  signalTimestamp: number;
  signalSourceTimestamp: number;
  signalSourceCandle?: { openTimestamp: number; closeTimestamp: number };
  signalTimePrecision: SignalPrecision;
  decisionAvailableTimestamp: number;
  configuredLatencyMs: number;
  orderSubmittedAt: number;
  fillSearchStart: number;
  fillSearchEnd: number;
}

export interface TapeFill {
  status: FillStatus;
  reason: string;
  action: TradeSide;
  compatibleDirection: TradeSide;
  requestedAmount: number;
  filledAmount: number;
  tapeVwapBtc?: number;
  fillPriceBtc?: number;
  fillTimestamp?: number;
  supportingTrades: ContractTrade[];
  supportingTradeTimestamps: number[];
}

export interface SpreadExecution {
  scenario: "taker-tape-proxy" | "maker-opportunity-optimistic";
  clock: ExecutionClock;
  sold: TapeFill;
  bought: TapeFill;
  status: "filled" | "no-trade" | "opportunity-only";
  reason: string;
}

export interface ExitExecution extends SpreadExecution {
  triggerTimestamp: number;
  sourceCandleCloseTimestamp?: number;
  exitOrderTimestamp: number;
  exitFillTimestamp?: number;
  triggerEvidenceTimestamp: number;
  exitStatus: "filled" | "triggered-unfilled";
}

export interface EventExecutionRecord {
  eventId: string;
  outcome: EventOutcome;
  pnl?: number;
  dataComplete: boolean;
  execution?: SpreadExecution;
  reason: string;
}

export interface DteTolerance {
  min: number;
  max: number;
}

export interface BacktestEvent {
  id: string;
  label: string;
  direction: Direction;
  entryDate: string;
  entryPrice: number;
  entryTimestamp?: number;
  entryTimeSource?: "resolved" | "manual" | "provisional";
  exitDate?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  extremePrice?: number;
  vpocPrice?: number;
  vpocDate?: string;
  vpocTimestamp?: number;
  invalidationPrice?: number;
  rangeLow?: number;
  rangeHigh?: number;
  notes?: string;
}

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ContractTrade {
  timestamp: number;
  price: number;
  markPrice?: number;
  iv?: number;
  instrumentName: string;
  indexPrice: number;
  direction: TradeSide;
  amount: number;
  tradeId?: string;
}

export interface ContractSeries {
  instrumentName: string;
  expiryTimestamp: number;
  expiryLabel: string;
  strike: number;
  optionType: OptionType;
  trades: ContractTrade[];
  firstTradeTimestamp: number;
  lastTradeTimestamp: number;
  sourceFiles: string[];
  creationTimestamp?: number;
}

export interface DesiredSpread {
  id: string;
  targetDte: number;
  targetWidth: number;
  anchorStrike: number;
  soldStrike: number;
  boughtStrike: number;
  optionType: OptionType;
  spreadKind: SpreadKind;
  structure: string;
  buffered: boolean;
}

export interface ContractCandidateManifest {
  requestId: string;
  targetDte: number;
  minDte: number;
  maxDte: number;
  desiredSoldStrike: number;
  desiredBoughtStrike: number;
  expiryTimestamp: number;
  expiryLabel: string;
  actualDte: number;
  soldInstrumentName?: string;
  boughtInstrumentName?: string;
  soldStrike?: number;
  boughtStrike?: number;
  soldCreationTimestamp?: number;
  boughtCreationTimestamp?: number;
  strikeResolutionSensible: boolean;
  strikeResolutionNote: string;
  dataStatus?: CandidateDataStatus;
  failedInstruments?: string[];
  retrievalErrors?: Array<{ instrumentName: string; cause: string; retryable: boolean }>;
  priceIndex?: string;
  deliveryPrice?: number;
  deliveryPriceDate?: string;
  deliveryPriceSource?: "deribit-get_delivery_prices";
}

export interface HistoricalLiquidityWindow {
  tradeCount: number;
  compatibleTradeCount: number;
  totalAmount: number;
  compatibleAmount: number;
}

export interface EntryLiquidityMetrics {
  quality: QualityFlag | "data-unavailable";
  viable: boolean;
  shortTrades2h: number;
  longTrades2h: number;
  shortCompatible2h: number;
  longCompatible2h: number;
  shortAmount2h: number;
  longAmount2h: number;
  shortNearestGapMin?: number;
  longNearestGapMin?: number;
  legTimeDiffMin?: number;
  indexDiffPct?: number;
  previous24hShort: HistoricalLiquidityWindow;
  previous24hLong: HistoricalLiquidityWindow;
  previous7dShort: HistoricalLiquidityWindow;
  previous7dLong: HistoricalLiquidityWindow;
  reason: string;
}

export interface RetrievedSpread extends DesiredSpread {
  expiryTimestamp?: number;
  expiryLabel?: string;
  actualDte?: number;
  actualWidth?: number;
  soldContract?: ContractSeries;
  boughtContract?: ContractSeries;
  soldExistedAtEntry: boolean;
  boughtExistedAtEntry: boolean;
  retrievalStatus: "ready" | "partial" | "missing";
  retrievalNote: string;
  candidateStatus?: "recommended" | "alternative" | "candidate" | "rejected";
  expiryRank?: number;
  expirySelectionReason?: string;
  entryLiquidityQuality?: QualityFlag;
  entryLiquidity?: EntryLiquidityMetrics;
  selectedForTest?: boolean;
  dteMin?: number;
  dteMax?: number;
  dteDistance?: number;
  strikeResolutionSensible?: boolean;
  strikeResolutionNote?: string;
  dataStatus?: CandidateDataStatus;
  failedInstruments?: string[];
  priceIndex?: string;
  deliveryPrice?: number;
  deliveryPriceDate?: string;
  deliveryPriceSource?: "deribit-get_delivery_prices";
}

export interface WindowMetrics {
  windowMinutes: number;
  tradeCount: number;
  compatibleTradeCount: number;
  totalAmount: number;
  nearestTimeGapMin?: number;
  nearestTrade?: ContractTrade;
  vwapPriceBtc?: number;
  medianPriceBtc?: number;
  minPriceBtc?: number;
  maxPriceBtc?: number;
  vwapIv?: number;
  medianIv?: number;
  indexVwap?: number;
  indexMin?: number;
  indexMax?: number;
  ivNormalizedPriceBtc?: number;
  usedDirectionFallback: boolean;
  usedModelFallback: boolean;
  schemaDirection: TradeSide;
  requiredAction: TradeSide;
  executionMode: ExecutionMode;
  windowStart: number;
  windowEnd: number;
  earliestEvidenceTimestamp?: number;
  latestEvidenceTimestamp?: number;
  usedEvidenceAfterTarget: boolean;
}

export interface SpreadNormalization {
  timestamp: number;
  targetIndex: number;
  sold: WindowMetrics;
  bought: WindowMetrics;
  soldLegTimestamp?: number;
  boughtLegTimestamp?: number;
  legTimeDiffMin?: number;
  soldLegIndexPrice?: number;
  boughtLegIndexPrice?: number;
  indexDiffPct?: number;
  soldLegIv?: number;
  boughtLegIv?: number;
  ivDiff?: number;
  qualityFlag: QualityFlag;
  qualityReason: string;
  valuationPurpose: Exclude<ValuationPurpose, "settlement">;
  retrospective: boolean;
  windowStart: number;
  windowEnd: number;
  earliestEvidenceTimestamp?: number;
  latestEvidenceTimestamp?: number;
  usedEvidenceAfterTarget: boolean;
}

export interface ValuationPoint {
  timestamp: number;
  btcIndex?: number;
  btcIndexSource: BtcIndexSource;
  btcIndexTimestamp?: number;
  btcIndexSourceCandleOpenTime?: number;
  btcIndexSourceCandleCloseTime?: number;
  btcIndexAgeMs?: number;
  btcIndexAvailabilityReason: string;
  rawSpreadValue?: number;
  ivSpreadValue?: number;
  rawSoldLegPrice?: number;
  rawBoughtLegPrice?: number;
  ivSoldLegPrice?: number;
  ivBoughtLegPrice?: number;
  rawPnlBtc?: number;
  ivPnlBtc?: number;
  rawPnlUsd?: number;
  ivPnlUsd?: number;
  rawCreditCapturedPct?: number;
  ivCreditCapturedPct?: number;
  qualityFlag: ValuationStatus;
  valuationSource: ValuationSource;
  qualityReason: string;
  soldLegGapMin?: number;
  boughtLegGapMin?: number;
  synchronizationGapMin?: number;
  indexMismatch?: number;
  usedDirectionFallback: boolean;
  usedModelFallback: boolean;
  maxAdversePnlSoFar?: number;
  maxFavorablePnlSoFar?: number;
  valuationPurpose: ValuationPurpose;
  soldRequiredAction: TradeSide;
  boughtRequiredAction: TradeSide;
  soldCompatibleDirection: TradeSide;
  boughtCompatibleDirection: TradeSide;
  executionMode: ExecutionMode;
  evidenceWindowStart: number;
  evidenceWindowEnd: number;
  newestSupportingPrintTimestamp?: number;
  rawExitFeesBtc?: number;
  ivExitFeesBtc?: number;
}

export interface ExitResult {
  rule: string;
  triggerTimestamp?: number;
  sourceCandleOpenTimestamp?: number;
  sourceCandleCloseTimestamp?: number;
  decisionAvailableTimestamp?: number;
  valuationTimestamp?: number;
  timestamp?: number;
  rawPnlBtc?: number;
  ivPnlBtc?: number;
  rawPnlUsd?: number;
  ivPnlUsd?: number;
  qualityFlag?: ValuationStatus;
  valuationSource?: ValuationSource;
  rawExitFeesBtc?: number;
  ivExitFeesBtc?: number;
  reasonCode: "triggered" | "not-hit" | "not-configured" | "after-expiry" | "causal-valuation-unavailable" | "settlement";
  qualityReason: string;
  status: "hit" | "not-hit" | "unavailable";
  triggeredPricingMethod?: EntryPricingMethod;
}

export type EntryPricingMethod = "raw-vwap" | "iv-normalized";

/** A complete, unit-explicit opening cash-flow ledger produced by the engine. */
export interface EntryLedger {
  pricingMethod: EntryPricingMethod;
  spreadKind: SpreadKind;
  soldInstrumentName: string;
  boughtInstrumentName: string;
  expiryTimestamp: number;
  expiryLabel: string;
  optionType: OptionType;
  soldStrikeUsd: number;
  boughtStrikeUsd: number;
  contractAmount: number;
  soldPriceBtcPerContract: number;
  soldProceedsBtc: number;
  boughtPriceBtcPerContract: number;
  boughtCostBtc: number;
  soldLegFeeBtc: number;
  boughtLegFeeBtc?: number;
  comboFeeBtc?: number;
  executionRoute: ExecutionRoute;
  soldLegFeeCalculation: FeeCalculation;
  boughtLegFeeCalculation: FeeCalculation;
  totalOpeningFeesBtc: number;
  grossEntryBtcPerContract: number;
  grossEntryTotalBtc: number;
  netOpeningCashFlowBtc: number;
  entryIndexUsdPerBtc: number;
  soldProceedsUsd: number;
  boughtCostUsd: number;
  totalOpeningFeesUsd: number;
  grossEntryTotalUsd: number;
  netOpeningCashFlowUsd: number;
  soldPricingTimestamp: number;
  boughtPricingTimestamp: number;
  normalizationWindowMinutes: number;
  executionMode: ExecutionMode;
  qualityFlag: QualityFlag;
  qualityReason: string;
  valuationPurpose: "entry";
  soldRequiredAction: "sell";
  boughtRequiredAction: "buy";
  soldCompatibleDirection: TradeSide;
  boughtCompatibleDirection: TradeSide;
  evidenceWindowStart: number;
  evidenceWindowEnd: number;
  earliestEvidenceTimestamp?: number;
  latestEvidenceTimestamp?: number;
  usedEvidenceAfterEntry: boolean;
  retrospectiveNormalization: true;
}

export interface EntryLedgers { raw: EntryLedger; iv: EntryLedger }
export interface ValuationRun { path: ValuationPoint[]; entryLedgers?: EntryLedgers }

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

const WINDOWS = [15, 30, 60, 120, 720] as const;
const DAY_MS = 86_400_000;

/** Resolve when a signal was actually actionable; candle-only evidence is actionable at close. */
export function executionClock(input: {
  signalTimestamp: number; signalSourceTimestamp?: number; signalSourceCandle?: Candle;
  signalTimePrecision: SignalPrecision; configuredLatencyMs: number; maxFillWaitMs: number;
}): ExecutionClock {
  const candle = input.signalSourceCandle;
  const decisionAvailableTimestamp = input.signalTimePrecision === "candle" && candle
    ? candle.closeTime
    : Math.max(input.signalTimestamp, input.signalSourceTimestamp ?? input.signalTimestamp);
  const orderSubmittedAt = decisionAvailableTimestamp + Math.max(0, input.configuredLatencyMs);
  return {
    signalTimestamp: input.signalTimestamp,
    signalSourceTimestamp: input.signalSourceTimestamp ?? candle?.openTime ?? input.signalTimestamp,
    signalSourceCandle: candle ? { openTimestamp: candle.openTime, closeTimestamp: candle.closeTime } : undefined,
    signalTimePrecision: input.signalTimePrecision,
    decisionAvailableTimestamp,
    configuredLatencyMs: Math.max(0, input.configuredLatencyMs),
    orderSubmittedAt,
    fillSearchStart: orderSubmittedAt,
    fillSearchEnd: orderSubmittedAt + Math.max(0, input.maxFillWaitMs),
  };
}

function tapeFill(series: ContractSeries | undefined, action: TradeSide, clock: ExecutionClock, amount: number, slippageBps: number): TapeFill {
  const base = { action, compatibleDirection: action, requestedAmount: amount, filledAmount: 0, supportingTrades: [], supportingTradeTimestamps: [] };
  if (!series) return { ...base, status: "missing-contract", reason: "Contract is missing; no executable price was constructed." };
  const compatible = series.trades
    .filter(trade => trade.timestamp > clock.orderSubmittedAt && trade.timestamp <= clock.fillSearchEnd && trade.direction === action)
    .sort((a, b) => a.timestamp - b.timestamp);
  const supportingTrades: ContractTrade[] = [];
  let remaining = amount;
  let notional = 0;
  for (const trade of compatible) {
    if (remaining <= 0) break;
    const used = Math.min(remaining, trade.amount);
    supportingTrades.push({ ...trade, amount: used });
    notional += trade.price * used;
    remaining -= used;
  }
  const filledAmount = amount - remaining;
  if (remaining > 1e-12) return { ...base, status: compatible.length ? "insufficient-amount" : "no-fill", reason: compatible.length ? "Post-order compatible tape amount is insufficient." : "No compatible post-order trade in the forward fill window.", filledAmount, supportingTrades, supportingTradeTimestamps: supportingTrades.map(t => t.timestamp) };
  const tapeVwapBtc = notional / amount;
  const adverseMultiplier = action === "buy" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  return { ...base, status: "filled", reason: "Requested amount covered chronologically by compatible post-order prints.", filledAmount, tapeVwapBtc, fillPriceBtc: tapeVwapBtc * adverseMultiplier, fillTimestamp: supportingTrades.at(-1)!.timestamp, supportingTrades, supportingTradeTimestamps: supportingTrades.map(t => t.timestamp) };
}

/** Conservative baseline proxy, not a claim about an exact historical market-order fill. */
export function simulateTakerSpread(spread: Pick<RetrievedSpread, "soldContract" | "boughtContract">, clock: ExecutionClock, amount: number, slippageBps = 0, maxLegSyncMs = 60_000): SpreadExecution {
  const sold = tapeFill(spread.soldContract, "sell", clock, amount, slippageBps);
  const bought = tapeFill(spread.boughtContract, "buy", clock, amount, slippageBps);
  const complete = sold.status === "filled" && bought.status === "filled";
  const synchronized = complete && Math.abs(sold.fillTimestamp! - bought.fillTimestamp!) <= maxLegSyncMs;
  return { scenario: "taker-tape-proxy", clock, sold, bought, status: complete && synchronized ? "filled" : "no-trade", reason: !complete ? "Both legs did not obtain complete post-order evidence; partial spreads are forbidden." : synchronized ? "Both legs filled within delay and synchronization constraints." : "Leg fills exceeded the synchronization constraint; partial spread discarded." };
}

/** Close-side execution starts only after independently established trigger evidence. */
export function simulateTakerExit(spread: Pick<RetrievedSpread, "soldContract" | "boughtContract">, clock: ExecutionClock, triggerEvidenceTimestamp: number, amount: number, slippageBps = 0, maxLegSyncMs = 60_000): ExitExecution {
  if (triggerEvidenceTimestamp > clock.decisionAvailableTimestamp) throw new Error("Exit decision cannot precede its trigger evidence.");
  const sold = tapeFill(spread.soldContract, "buy", clock, amount, slippageBps);
  const bought = tapeFill(spread.boughtContract, "sell", clock, amount, slippageBps);
  const complete = sold.status === "filled" && bought.status === "filled";
  const synchronized = complete && Math.abs(sold.fillTimestamp! - bought.fillTimestamp!) <= maxLegSyncMs;
  const filled = complete && synchronized;
  return { scenario: "taker-tape-proxy", clock, sold, bought, status: filled ? "filled" : "no-trade", reason: filled ? "Causal trigger was followed by synchronized closing-side tape evidence." : "Trigger established, but a complete synchronized close fill was not found; position remains open for fallback or settlement.", triggerTimestamp: clock.signalTimestamp, sourceCandleCloseTimestamp: clock.signalSourceCandle?.closeTimestamp, exitOrderTimestamp: clock.orderSubmittedAt, exitFillTimestamp: filled ? Math.max(sold.fillTimestamp!, bought.fillTimestamp!) : undefined, triggerEvidenceTimestamp, exitStatus: filled ? "filled" : "triggered-unfilled" };
}

/** Maker prints establish only an optimistic opportunity and never a confirmed fill. */
export function assessMakerOpportunity(series: ContractSeries | undefined, action: TradeSide, clock: ExecutionClock, amount: number, limitPrice: number, assumedQueueAhead: number): TapeFill {
  const opposingDirection = action === "buy" ? "sell" : "buy";
  const rows = (series?.trades ?? []).filter(t => t.timestamp > clock.orderSubmittedAt && t.timestamp <= clock.fillSearchEnd && t.direction === opposingDirection && (action === "buy" ? t.price <= limitPrice : t.price >= limitPrice));
  const opposingVolume = rows.reduce((sum, row) => sum + row.amount, 0);
  const progressed = Math.min(amount, Math.max(0, opposingVolume - Math.max(0, assumedQueueAhead)));
  return { status: "opportunity-only", reason: `Maker opportunity — optimistic. Assumed queue ahead: ${Math.max(0, assumedQueueAhead)} contracts; this is an assumption, not observed fact.`, action, compatibleDirection: opposingDirection, requestedAmount: amount, filledAmount: progressed, supportingTrades: rows, supportingTradeTimestamps: rows.map(row => row.timestamp) };
}

export function summarizeEventExecutions(events: EventExecutionRecord[]) {
  const complete = events.filter(event => event.dataComplete);
  const executed = events.filter(event => event.outcome === "executed" || event.outcome === "settled");
  const noTrades = events.filter(event => event.outcome.startsWith("no-trade:"));
  const unavailable = events.filter(event => event.outcome === "data-unavailable");
  const completePnl = complete.reduce((sum, event) => sum + (event.pnl ?? 0), 0);
  const executedPnl = executed.reduce((sum, event) => sum + (event.pnl ?? 0), 0);
  return { totalSignals: events.length, completeEvents: complete.length, executedTrades: executed.length, noTrades: noTrades.length, unavailableEvents: unavailable.length, executionRate: complete.length ? executed.length / complete.length : 0, coverageRate: events.length ? complete.length / events.length : 0, averagePnlPerCompleteSignal: complete.length ? completePnl / complete.length : undefined, averagePnlPerExecutedTrade: executed.length ? executedPnl / executed.length : undefined };
}

export function parseUtcDate(date: string, time = "00:00") {
  return Date.parse(`${date}T${time}:00Z`);
}

export function formatUtc(timestamp?: number) {
  if (!timestamp) return "Unresolved";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp) + " UTC";
}

export function parseInstrumentName(instrumentName: string) {
  const match = instrumentName.toUpperCase().match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-(C|P)$/);
  if (!match || MONTHS[match[2]] === undefined) return null;
  const year = 2000 + Number(match[3]);
  const expiryTimestamp = Date.UTC(year, MONTHS[match[2]], Number(match[1]), 8, 0, 0);
  return {
    expiryTimestamp,
    expiryLabel: `${match[1]}${match[2]}${match[3]}`,
    strike: Number(match[4]),
    optionType: match[5] as OptionType,
  };
}

function asNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractTradeObjects(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  if (Array.isArray(root.trades)) return root.trades;
  if (root.result && typeof root.result === "object") {
    const result = root.result as Record<string, unknown>;
    if (Array.isArray(result.trades)) return result.trades;
  }
  return [parsed];
}

function normalizeTrade(raw: unknown): ContractTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const timestamp = asNumber(row.timestamp);
  const price = asNumber(row.price);
  const amount = asNumber(row.amount);
  const indexPrice = asNumber(row.index_price ?? row.indexPrice);
  const instrumentName = String(row.instrument_name ?? row.instrumentName ?? "").toUpperCase();
  const direction = String(row.direction ?? "").toLowerCase();
  if (!timestamp || price === undefined || amount === undefined || indexPrice === undefined || !parseInstrumentName(instrumentName)) return null;
  if (direction !== "buy" && direction !== "sell") return null;
  return {
    timestamp,
    price,
    amount,
    indexPrice,
    instrumentName,
    direction,
    markPrice: asNumber(row.mark_price ?? row.markPrice),
    iv: asNumber(row.iv),
    tradeId: row.trade_id ? String(row.trade_id) : undefined,
  };
}

export function parseContractText(text: string): ContractTrade[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rows: unknown[] = [];
  if (trimmed.startsWith("[")) {
    rows.push(...extractTradeObjects(JSON.parse(trimmed)));
  } else {
    try {
      const parsed = JSON.parse(trimmed);
      rows.push(...extractTradeObjects(parsed));
    } catch {
      for (const line of trimmed.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(...extractTradeObjects(JSON.parse(line))); } catch { /* skip malformed rows */ }
      }
    }
  }
  return rows.map(normalizeTrade).filter((trade): trade is ContractTrade => Boolean(trade));
}

export function buildInventory(files: Array<{ name: string; trades: ContractTrade[] }>): ContractSeries[] {
  const map = new Map<string, ContractSeries>();
  for (const file of files) {
    for (const trade of file.trades) {
      const parsed = parseInstrumentName(trade.instrumentName);
      if (!parsed) continue;
      const existing = map.get(trade.instrumentName);
      if (existing) {
        existing.trades.push(trade);
        if (!existing.sourceFiles.includes(file.name)) existing.sourceFiles.push(file.name);
      } else {
        map.set(trade.instrumentName, {
          instrumentName: trade.instrumentName,
          ...parsed,
          trades: [trade],
          firstTradeTimestamp: trade.timestamp,
          lastTradeTimestamp: trade.timestamp,
          sourceFiles: [file.name],
        });
      }
    }
  }
  for (const series of map.values()) {
    series.trades.sort((a, b) => a.timestamp - b.timestamp);
    series.firstTradeTimestamp = series.trades[0].timestamp;
    series.lastTradeTimestamp = series.trades[series.trades.length - 1].timestamp;
  }
  return [...map.values()].sort((a, b) => a.expiryTimestamp - b.expiryTimestamp || a.strike - b.strike);
}

export function generateDesiredSpreads(event: BacktestEvent, dtes: number[], widths: number[], kind: SpreadKind): DesiredSpread[] {
  if (!event.extremePrice) return [];
  const bullish = event.direction === "long";
  const rounded = bullish
    ? Math.floor(event.extremePrice / 1000) * 1000
    : Math.ceil(event.extremePrice / 1000) * 1000;
  const anchors = [{ strike: rounded, buffered: false }];
  if (Math.abs(event.extremePrice - rounded) < 100) {
    anchors.push({ strike: rounded + (bullish ? -1000 : 1000), buffered: true });
  }
  const optionType: OptionType = kind === "credit"
    ? (bullish ? "P" : "C")
    : (bullish ? "C" : "P");
  const structure = kind === "credit"
    ? (bullish ? "Bull put credit" : "Bear call credit")
    : (bullish ? "Bull call debit" : "Bear put debit");
  return anchors.flatMap(anchor => dtes.flatMap(targetDte => widths.map(targetWidth => {
    let soldStrike: number;
    let boughtStrike: number;
    if (kind === "credit") {
      soldStrike = anchor.strike;
      boughtStrike = anchor.strike + (bullish ? -targetWidth : targetWidth);
    } else {
      boughtStrike = anchor.strike;
      soldStrike = anchor.strike + (bullish ? targetWidth : -targetWidth);
    }
    return {
      id: `${kind}-${targetDte}-${targetWidth}-${anchor.strike}`,
      targetDte,
      targetWidth,
      anchorStrike: anchor.strike,
      soldStrike,
      boughtStrike,
      optionType,
      spreadKind: kind,
      structure,
      buffered: anchor.buffered,
    };
  })));
}

function nearestStrike(series: ContractSeries[], desired: number) {
  return [...series].sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired) || a.strike - b.strike)[0];
}

export function retrieveSpread(combo: DesiredSpread, entryTimestamp: number, inventory: ContractSeries[]): RetrievedSpread {
  const expiries = [...new Set(inventory
    .filter(item => item.optionType === combo.optionType && item.expiryTimestamp > entryTimestamp)
    .map(item => item.expiryTimestamp))]
    .filter(expiry => (expiry - entryTimestamp) / 86_400_000 >= combo.targetDte)
    .sort((a, b) => a - b);
  const expiryTimestamp = expiries[0];
  if (!expiryTimestamp) {
    return { ...combo, soldExistedAtEntry: false, boughtExistedAtEntry: false, retrievalStatus: "missing", retrievalNote: `No listed expiry at or beyond ${combo.targetDte}D in loaded contracts.` };
  }
  const chain = inventory.filter(item => item.optionType === combo.optionType && item.expiryTimestamp === expiryTimestamp);
  const soldContract = nearestStrike(chain, combo.soldStrike);
  const boughtContract = nearestStrike(chain, combo.boughtStrike);
  const soldExistedAtEntry = Boolean(soldContract && soldContract.firstTradeTimestamp <= entryTimestamp);
  const boughtExistedAtEntry = Boolean(boughtContract && boughtContract.firstTradeTimestamp <= entryTimestamp);
  const ready = Boolean(soldContract && boughtContract);
  const strictlyObserved = soldExistedAtEntry && boughtExistedAtEntry;
  return {
    ...combo,
    expiryTimestamp,
    expiryLabel: soldContract?.expiryLabel ?? boughtContract?.expiryLabel,
    actualDte: (expiryTimestamp - entryTimestamp) / 86_400_000,
    actualWidth: soldContract && boughtContract ? Math.abs(soldContract.strike - boughtContract.strike) : undefined,
    soldContract,
    boughtContract,
    soldExistedAtEntry,
    boughtExistedAtEntry,
    retrievalStatus: ready ? (strictlyObserved ? "ready" : "partial") : "missing",
    retrievalNote: !ready
      ? "One or both resolved contracts are missing."
      : strictlyObserved
        ? "Both contracts have an observed trade at or before entry."
        : "Contracts were found, but listing existence is not proven by the available metadata.",
  };
}

function lowerBound(trades: ContractTrade[], timestamp: number) {
  let low = 0;
  let high = trades.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trades[mid].timestamp < timestamp) low = mid + 1;
    else high = mid;
  }
  return low;
}

function tradesInWindow(series: ContractSeries, start: number, end: number) {
  const from = lowerBound(series.trades, start);
  const selected: ContractTrade[] = [];
  for (let i = from; i < series.trades.length && series.trades[i].timestamp <= end; i += 1) selected.push(series.trades[i]);
  return selected;
}

function nearestTradeAnywhere(series: ContractSeries, timestamp: number) {
  const index = lowerBound(series.trades, timestamp);
  const choices = [series.trades[index - 1], series.trades[index]].filter(Boolean);
  return choices.sort((a, b) => Math.abs(a.timestamp - timestamp) - Math.abs(b.timestamp - timestamp))[0];
}

function weightedAverage(rows: ContractTrade[], getter: (row: ContractTrade) => number | undefined) {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    const value = getter(row);
    if (value === undefined || !Number.isFinite(value)) continue;
    numerator += value * row.amount;
    denominator += row.amount;
  }
  return denominator ? numerator / denominator : undefined;
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let probability = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x < 0) probability = 1 - probability;
  return probability;
}

export function inverseOptionPriceBtc(spot: number, strike: number, expiryTimestamp: number, targetTimestamp: number, ivInput: number, optionType: OptionType) {
  if (spot <= 0 || strike <= 0) return undefined;
  const timeYears = Math.max((expiryTimestamp - targetTimestamp) / (365 * 86_400_000), 0);
  if (timeYears <= 0) {
    return optionType === "C" ? Math.max(spot - strike, 0) / spot : Math.max(strike - spot, 0) / spot;
  }
  const sigma = ivInput > 3 ? ivInput / 100 : ivInput;
  if (!Number.isFinite(sigma) || sigma <= 0) return undefined;
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return optionType === "C"
    ? normalCdf(d1) - (strike / spot) * normalCdf(d2)
    : (strike / spot) * normalCdf(-d2) - normalCdf(-d1);
}

function compatibleSchemaDirection(action: TradeSide, executionMode: ExecutionMode): TradeSide {
  if (executionMode === "taker") return action;
  return action === "buy" ? "sell" : "buy";
}

export function normalizeLeg(series: ContractSeries, timestamp: number, targetIndex: number, action: TradeSide, executionMode: ExecutionMode, windowMinutes: number, purpose: Exclude<ValuationPurpose, "settlement"> = "entry"): WindowMetrics {
  const windowStart = timestamp - windowMinutes * 60_000;
  const windowEnd = purpose === "close" ? timestamp : timestamp + windowMinutes * 60_000;
  const all = tradesInWindow(series, windowStart, windowEnd);
  const schemaDirection = compatibleSchemaDirection(action, executionMode);
  const compatible = all.filter(trade => trade.direction === schemaDirection);
  const usedDirectionFallback = compatible.length === 0 && all.length > 0;
  let selected = compatible.length ? compatible : purpose === "entry" ? all : [];
  let usedModelFallback = false;
  if (!selected.length && windowMinutes === 720 && purpose === "entry") {
    const nearest = nearestTradeAnywhere(series, timestamp);
    if (nearest) {
      selected = [nearest];
      usedModelFallback = true;
    }
  }
  const nearestTrade = [...selected].sort((a, b) => Math.abs(a.timestamp - timestamp) - Math.abs(b.timestamp - timestamp))[0];
  const prices = selected.map(row => row.price);
  const ivs = selected.map(row => row.iv).filter((value): value is number => Boolean(value && value > 0));
  const indexes = selected.map(row => row.indexPrice);
  const vwapIv = weightedAverage(selected.filter(row => Boolean(row.iv && row.iv > 0)), row => row.iv);
  return {
    windowMinutes,
    tradeCount: all.length,
    compatibleTradeCount: compatible.length,
    totalAmount: selected.reduce((sum, row) => sum + row.amount, 0),
    nearestTimeGapMin: nearestTrade ? Math.abs(nearestTrade.timestamp - timestamp) / 60_000 : undefined,
    nearestTrade,
    vwapPriceBtc: weightedAverage(selected, row => row.price),
    medianPriceBtc: median(prices),
    minPriceBtc: prices.length ? Math.min(...prices) : undefined,
    maxPriceBtc: prices.length ? Math.max(...prices) : undefined,
    vwapIv,
    medianIv: median(ivs),
    indexVwap: weightedAverage(selected, row => row.indexPrice),
    indexMin: indexes.length ? Math.min(...indexes) : undefined,
    indexMax: indexes.length ? Math.max(...indexes) : undefined,
    ivNormalizedPriceBtc: vwapIv ? inverseOptionPriceBtc(targetIndex, series.strike, series.expiryTimestamp, timestamp, vwapIv, series.optionType) : undefined,
    usedDirectionFallback,
    usedModelFallback,
    schemaDirection,
    requiredAction: action,
    executionMode,
    windowStart,
    windowEnd,
    earliestEvidenceTimestamp: selected.length ? Math.min(...selected.map(row => row.timestamp)) : undefined,
    latestEvidenceTimestamp: selected.length ? Math.max(...selected.map(row => row.timestamp)) : undefined,
    usedEvidenceAfterTarget: selected.some(row => row.timestamp > timestamp),
  };
}

export function normalizeSpread(spread: RetrievedSpread, timestamp: number, targetIndex: number, executionMode: ExecutionMode, windowMinutes?: number, purpose: Exclude<ValuationPurpose, "settlement"> = "entry"): SpreadNormalization | null {
  if (!spread.soldContract || !spread.boughtContract) return null;
  const windows = windowMinutes ? [windowMinutes] : [...WINDOWS];
  let sold: WindowMetrics | undefined;
  let bought: WindowMetrics | undefined;
  for (const window of windows) {
    sold = normalizeLeg(spread.soldContract, timestamp, targetIndex, purpose === "entry" ? "sell" : "buy", executionMode, window, purpose);
    bought = normalizeLeg(spread.boughtContract, timestamp, targetIndex, purpose === "entry" ? "buy" : "sell", executionMode, window, purpose);
    if (sold.nearestTrade && bought.nearestTrade) break;
  }
  if (!sold || !bought) return null;
  const soldTrade = sold.nearestTrade;
  const boughtTrade = bought.nearestTrade;
  const legTimeDiffMin = soldTrade && boughtTrade ? Math.abs(soldTrade.timestamp - boughtTrade.timestamp) / 60_000 : undefined;
  const indexDiffPct = soldTrade && boughtTrade
    ? Math.abs(soldTrade.indexPrice - boughtTrade.indexPrice) / ((soldTrade.indexPrice + boughtTrade.indexPrice) / 2) * 100
    : undefined;
  const soldIv = soldTrade?.iv;
  const boughtIv = boughtTrade?.iv;
  let qualityFlag: QualityFlag = "red";
  let qualityReason = "Missing or stale leg; model fallback required.";
  if (sold.nearestTimeGapMin !== undefined && bought.nearestTimeGapMin !== undefined && legTimeDiffMin !== undefined && indexDiffPct !== undefined) {
    if (sold.nearestTimeGapMin <= 30 && bought.nearestTimeGapMin <= 30 && legTimeDiffMin <= 30 && indexDiffPct <= 0.5 && !sold.usedDirectionFallback && !bought.usedDirectionFallback) {
      qualityFlag = "green";
      qualityReason = "Both legs within ±30m, synchronized within 30m, index mismatch ≤0.5%.";
    } else if (sold.nearestTimeGapMin <= 120 && bought.nearestTimeGapMin <= 120 && indexDiffPct <= 1.5) {
      qualityFlag = "yellow";
      qualityReason = "Both legs within ±2h and index mismatch ≤1.5%.";
    } else {
      qualityReason = indexDiffPct > 1.5 ? "Underlying mismatch exceeds 1.5%." : "At least one leg is beyond ±2h or requires fallback.";
    }
  }
  if (!spread.soldExistedAtEntry || !spread.boughtExistedAtEntry) {
    qualityFlag = "red";
    qualityReason = "Listing metadata does not prove that both legs existed at entry.";
  }
  return {
    timestamp,
    targetIndex,
    sold,
    bought,
    soldLegTimestamp: soldTrade?.timestamp,
    boughtLegTimestamp: boughtTrade?.timestamp,
    legTimeDiffMin,
    soldLegIndexPrice: soldTrade?.indexPrice,
    boughtLegIndexPrice: boughtTrade?.indexPrice,
    indexDiffPct,
    soldLegIv: soldIv,
    boughtLegIv: boughtIv,
    ivDiff: soldIv !== undefined && boughtIv !== undefined ? soldIv - boughtIv : undefined,
    qualityFlag,
    qualityReason,
    valuationPurpose: purpose,
    retrospective: purpose === "entry",
    windowStart: Math.min(sold.windowStart, bought.windowStart),
    windowEnd: Math.max(sold.windowEnd, bought.windowEnd),
    earliestEvidenceTimestamp: [sold.earliestEvidenceTimestamp, bought.earliestEvidenceTimestamp].filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0],
    latestEvidenceTimestamp: [sold.latestEvidenceTimestamp, bought.latestEvidenceTimestamp].filter((value): value is number => value !== undefined).sort((a, b) => b - a)[0],
    usedEvidenceAfterTarget: sold.usedEvidenceAfterTarget || bought.usedEvidenceAfterTarget,
  };
}

function historicalLiquidityWindow(
  series: ContractSeries | undefined,
  timestamp: number,
  action: TradeSide,
  executionMode: ExecutionMode,
  lookbackMs: number,
): HistoricalLiquidityWindow {
  if (!series) return { tradeCount: 0, compatibleTradeCount: 0, totalAmount: 0, compatibleAmount: 0 };
  const start = timestamp - lookbackMs;
  const schemaDirection = compatibleSchemaDirection(action, executionMode);
  const rows = series.trades.filter(trade => trade.timestamp >= start && trade.timestamp <= timestamp);
  const compatible = rows.filter(trade => trade.direction === schemaDirection);
  return {
    tradeCount: rows.length,
    compatibleTradeCount: compatible.length,
    totalAmount: rows.reduce((sum, trade) => sum + trade.amount, 0),
    compatibleAmount: compatible.reduce((sum, trade) => sum + trade.amount, 0),
  };
}

function liquidityActivity(candidate: RetrievedSpread) {
  const metrics = candidate.entryLiquidity;
  if (!metrics) return { trades: 0, amount: 0 };
  return {
    trades: metrics.previous24hShort.compatibleTradeCount + metrics.previous24hLong.compatibleTradeCount,
    amount: metrics.previous24hShort.compatibleAmount + metrics.previous24hLong.compatibleAmount,
  };
}

function selectionSummary(candidate: RetrievedSpread, prefix: string) {
  const quality = candidate.entryLiquidityQuality
    ? candidate.entryLiquidityQuality[0].toUpperCase() + candidate.entryLiquidityQuality.slice(1)
    : "Unknown";
  const distance = candidate.dteDistance?.toFixed(1) ?? "—";
  const actualDte = candidate.actualDte?.toFixed(1) ?? "—";
  const shortGap = candidate.entryLiquidity?.shortNearestGapMin;
  const longGap = candidate.entryLiquidity?.longNearestGapMin;
  const proximity = shortGap !== undefined && longGap !== undefined
    ? `nearest leg prints ${Math.round(shortGap)}m / ${Math.round(longGap)}m from entry`
    : "entry prints unavailable";
  return `${prefix}: ${quality} entry liquidity; ${actualDte}D actual; ${distance}D from ~${candidate.targetDte}D; ${proximity}.`;
}

/** Build and rank one auditable row per listed expiry using entry-time evidence only. */
export function buildExpiryCandidates(
  desiredSpreads: DesiredSpread[],
  manifests: ContractCandidateManifest[],
  entryTimestamp: number,
  entryIndex: number,
  inventory: ContractSeries[],
  executionMode: ExecutionMode,
  selectionMode: ExpirySelectionMode,
): RetrievedSpread[] {
  const inventoryByName = new Map(inventory.map(series => [series.instrumentName, series]));
  const byRequest = new Map<string, ContractCandidateManifest[]>();
  for (const manifest of manifests) {
    const group = byRequest.get(manifest.requestId) ?? [];
    group.push(manifest);
    byRequest.set(manifest.requestId, group);
  }

  return desiredSpreads.flatMap(combo => {
    const candidates: RetrievedSpread[] = (byRequest.get(combo.id) ?? []).map(manifest => {
      const soldContract = manifest.soldInstrumentName ? inventoryByName.get(manifest.soldInstrumentName) : undefined;
      const boughtContract = manifest.boughtInstrumentName ? inventoryByName.get(manifest.boughtInstrumentName) : undefined;
      // Listing metadata, not the first observed print, proves existence.
      const soldExistedAtEntry = manifest.soldCreationTimestamp !== undefined && manifest.soldCreationTimestamp <= entryTimestamp;
      const boughtExistedAtEntry = manifest.boughtCreationTimestamp !== undefined && manifest.boughtCreationTimestamp <= entryTimestamp;
      const base: RetrievedSpread = {
        ...combo,
        id: `${combo.id}-${manifest.expiryTimestamp}`,
        expiryTimestamp: manifest.expiryTimestamp,
        expiryLabel: manifest.expiryLabel,
        actualDte: manifest.actualDte,
        actualWidth: manifest.soldStrike !== undefined && manifest.boughtStrike !== undefined
          ? Math.abs(manifest.soldStrike - manifest.boughtStrike)
          : undefined,
        soldContract,
        boughtContract,
        soldExistedAtEntry,
        boughtExistedAtEntry,
        retrievalStatus: "missing",
        retrievalNote: manifest.strikeResolutionNote,
        dteMin: manifest.minDte,
        dteMax: manifest.maxDte,
        dteDistance: Math.abs(manifest.actualDte - combo.targetDte),
        strikeResolutionSensible: manifest.strikeResolutionSensible,
        strikeResolutionNote: manifest.strikeResolutionNote,
        dataStatus: manifest.dataStatus ?? "available",
        failedInstruments: manifest.failedInstruments,
        priceIndex: manifest.priceIndex,
        deliveryPrice: manifest.deliveryPrice,
        deliveryPriceDate: manifest.deliveryPriceDate,
        deliveryPriceSource: manifest.deliveryPriceSource,
      };
      // Candidate selection may rank historical liquidity, but must never see prints
      // that arrived after the selection timestamp.
      const causalSeries = (series: ContractSeries | undefined) => series ? {
        ...series,
        trades: series.trades.filter(trade => trade.timestamp <= entryTimestamp),
      } : undefined;
      const normalization = normalizeSpread({
        ...base,
        soldContract: causalSeries(soldContract),
        boughtContract: causalSeries(boughtContract),
      }, entryTimestamp, entryIndex, executionMode, 120);
      const hasObservedPrices = Boolean(
        normalization?.sold.nearestTrade && normalization?.bought.nearestTrade &&
        normalization.sold.vwapPriceBtc !== undefined && normalization.bought.vwapPriceBtc !== undefined &&
        !normalization.sold.usedModelFallback && !normalization.bought.usedModelFallback,
      );
      const dataUnavailable = manifest.dataStatus === "data-unavailable";
      const viable = Boolean(
        !dataUnavailable &&
        soldContract && boughtContract && soldExistedAtEntry && boughtExistedAtEntry &&
        manifest.strikeResolutionSensible && hasObservedPrices && normalization && normalization.qualityFlag !== "red",
      );
      const quality: QualityFlag | "data-unavailable" = dataUnavailable ? "data-unavailable" : viable ? normalization!.qualityFlag : "red";
      let reason = normalization?.qualityReason ?? "Both contracts could not be priced from observed entry-window trades.";
      if (dataUnavailable) reason = `Required API data unavailable: ${manifest.retrievalErrors?.map(error => `${error.instrumentName}: ${error.cause}`).join("; ") ?? manifest.failedInstruments?.join(", ") ?? "retrieval failed"}.`;
      else if (!manifest.strikeResolutionSensible) reason = manifest.strikeResolutionNote;
      else if (!soldContract || !boughtContract) reason = "One or both resolved contracts could not be loaded.";
      else if (manifest.soldCreationTimestamp === undefined || manifest.boughtCreationTimestamp === undefined) reason = "Listing existence at entry is unknown because creation metadata is missing.";
      else if (!soldExistedAtEntry || !boughtExistedAtEntry) reason = "One or both contracts were created after entry.";
      else if (!hasObservedPrices) reason = "Both legs require observed, non-model prices within ±2h of entry.";
      const entryLiquidity: EntryLiquidityMetrics = {
        quality,
        viable,
        shortTrades2h: normalization?.sold.tradeCount ?? 0,
        longTrades2h: normalization?.bought.tradeCount ?? 0,
        shortCompatible2h: normalization?.sold.compatibleTradeCount ?? 0,
        longCompatible2h: normalization?.bought.compatibleTradeCount ?? 0,
        shortAmount2h: normalization?.sold.totalAmount ?? 0,
        longAmount2h: normalization?.bought.totalAmount ?? 0,
        shortNearestGapMin: normalization?.sold.nearestTimeGapMin,
        longNearestGapMin: normalization?.bought.nearestTimeGapMin,
        legTimeDiffMin: normalization?.legTimeDiffMin,
        indexDiffPct: normalization?.indexDiffPct,
        previous24hShort: historicalLiquidityWindow(soldContract, entryTimestamp, "sell", executionMode, DAY_MS),
        previous24hLong: historicalLiquidityWindow(boughtContract, entryTimestamp, "buy", executionMode, DAY_MS),
        previous7dShort: historicalLiquidityWindow(soldContract, entryTimestamp, "sell", executionMode, 7 * DAY_MS),
        previous7dLong: historicalLiquidityWindow(boughtContract, entryTimestamp, "buy", executionMode, 7 * DAY_MS),
        reason,
      };
      return {
        ...base,
        entryLiquidity,
        entryLiquidityQuality: dataUnavailable ? undefined : quality as QualityFlag,
        retrievalStatus: viable ? (quality === "green" ? "ready" : "partial") : "missing",
        retrievalNote: reason,
        candidateStatus: viable ? "candidate" : "rejected",
        selectedForTest: false,
        expirySelectionReason: viable ? undefined : `Rejected: ${reason}`,
      } satisfies RetrievedSpread;
    });

    const viable = candidates.filter(candidate => candidate.entryLiquidity?.viable);
    const compareActivity = (a: RetrievedSpread, b: RetrievedSpread) => {
      const activityA = liquidityActivity(a);
      const activityB = liquidityActivity(b);
      return activityB.trades - activityA.trades || activityB.amount - activityA.amount;
    };
    viable.sort((a, b) => {
      if (selectionMode === "closest-dte") {
        return (a.dteDistance ?? Infinity) - (b.dteDistance ?? Infinity)
          || qualityRank(b.entryLiquidityQuality ?? "red") - qualityRank(a.entryLiquidityQuality ?? "red")
          || compareActivity(a, b);
      }
      return qualityRank(b.entryLiquidityQuality ?? "red") - qualityRank(a.entryLiquidityQuality ?? "red")
        || (a.dteDistance ?? Infinity) - (b.dteDistance ?? Infinity)
        || compareActivity(a, b);
    });
    const selectedCount = selectionMode === "all-eligible"
      ? viable.length
      : selectionMode === "liquidity-aware" ? Math.min(2, viable.length) : Math.min(1, viable.length);
    viable.forEach((candidate, index) => {
      candidate.expiryRank = index + 1;
      candidate.selectedForTest = index < selectedCount;
      if (index === 0) {
        candidate.candidateStatus = "recommended";
        candidate.expirySelectionReason = selectionSummary(candidate, selectionMode === "closest-dte" ? "Selected by DTE proximity" : "Selected");
      } else if (candidate.selectedForTest) {
        candidate.candidateStatus = selectionMode === "all-eligible" ? "candidate" : "alternative";
        candidate.expirySelectionReason = selectionSummary(candidate, selectionMode === "all-eligible" ? "Eligible candidate retained" : "Alternative retained");
      } else {
        candidate.candidateStatus = "candidate";
        candidate.expirySelectionReason = selectionSummary(candidate, "Viable candidate not selected");
      }
    });
    const rejected = candidates.filter(candidate => !candidate.entryLiquidity?.viable)
      .sort((a, b) => (a.dteDistance ?? Infinity) - (b.dteDistance ?? Infinity));
    return [...viable, ...rejected];
  });
}

export function windowComparison(spread: RetrievedSpread, timestamp: number, targetIndex: number, executionMode: ExecutionMode) {
  return WINDOWS.map(window => normalizeSpread(spread, timestamp, targetIndex, executionMode, window)).filter(Boolean) as SpreadNormalization[];
}

export function optionFeeBtc(optionPriceBtc: number, amount: number) {
  return calculateOptionFee(optionPriceBtc, amount, "taker", STANDARD_INVERSE_BTC_OPTION_FEE).finalFee;
}

export function spreadValue(kind: SpreadKind, soldPrice: number, boughtPrice: number) {
  return kind === "credit" ? soldPrice - boughtPrice : boughtPrice - soldPrice;
}

export function intrinsicPriceBtc(optionType: OptionType, settlementPrice: number, strike: number) {
  if (settlementPrice <= 0) return 0;
  return optionType === "C"
    ? Math.max(settlementPrice - strike, 0) / settlementPrice
    : Math.max(strike - settlementPrice, 0) / settlementPrice;
}

export function latestCompletedCandleAtOrBefore(candles: Candle[], timestamp: number) {
  return candles.reduce<Candle | undefined>((latest, candle) => {
    if (candle.closeTime > timestamp) return latest;
    return !latest || candle.closeTime > latest.closeTime ? candle : latest;
  }, undefined);
}

export function firstTouch(candles: Candle[], price: number, after = 0) {
  return candles.find(candle => candle.openTime >= after && candle.low <= price && candle.high >= price);
}

export function firstInvalidationClose(candles: Candle[], event: BacktestEvent, after: number) {
  if (!event.invalidationPrice) return undefined;
  const ordered = candles.filter(candle => candle.openTime >= after).sort((a, b) => a.openTime - b.openTime);
  for (let index = 3; index < ordered.length; index += 4) {
    const close = ordered[index].close;
    if (event.direction === "long" ? close < event.invalidationPrice : close > event.invalidationPrice) return ordered[index];
  }
  return undefined;
}

export function valuationTimestamps(entryTimestamp: number, expiryTimestamp: number, specialTimestamps: number[] = []) {
  const points = new Set<number>([entryTimestamp, expiryTimestamp, ...specialTimestamps.filter(Boolean)]);
  for (let timestamp = entryTimestamp + 4 * 3_600_000; timestamp < expiryTimestamp; timestamp += 4 * 3_600_000) points.add(timestamp);
  return [...points].filter(timestamp => timestamp >= entryTimestamp && timestamp <= expiryTimestamp).sort((a, b) => a - b);
}

function feesForPair(soldPrice: number, boughtPrice: number, amount: number, comboExecution: boolean, executionMode: ExecutionMode) {
  const route: ExecutionRoute = comboExecution ? "official-combo" : "separate-legs";
  return aggregateRoutedFees([
    { side: "buy", fee: calculateOptionFee(soldPrice, amount, executionMode, STANDARD_INVERSE_BTC_OPTION_FEE) },
    { side: "sell", fee: calculateOptionFee(boughtPrice, amount, executionMode, STANDARD_INVERSE_BTC_OPTION_FEE) },
  ], route).finalFee;
}

function makeEntryLedger(
  spread: RetrievedSpread,
  normalization: SpreadNormalization,
  method: EntryPricingMethod,
  executionMode: ExecutionMode,
  amount: number,
  comboExecution: boolean,
): EntryLedger | undefined {
  if (!spread.soldContract || !spread.boughtContract || !spread.expiryTimestamp || !spread.expiryLabel) return undefined;
  const soldPrice = method === "raw-vwap" ? normalization.sold.vwapPriceBtc : normalization.sold.ivNormalizedPriceBtc;
  const boughtPrice = method === "raw-vwap" ? normalization.bought.vwapPriceBtc : normalization.bought.ivNormalizedPriceBtc;
  if (soldPrice === undefined || boughtPrice === undefined || !normalization.soldLegTimestamp || !normalization.boughtLegTimestamp) return undefined;
  const soldLegFeeCalculation = calculateOptionFee(soldPrice, amount, executionMode, STANDARD_INVERSE_BTC_OPTION_FEE);
  const boughtLegFeeCalculation = calculateOptionFee(boughtPrice, amount, executionMode, STANDARD_INVERSE_BTC_OPTION_FEE);
  const soldLegFeeBtc = soldLegFeeCalculation.finalFee;
  const calculatedBoughtFee = boughtLegFeeCalculation.finalFee;
  const comboFeeBtc = comboExecution ? Math.max(soldLegFeeBtc, calculatedBoughtFee) : undefined;
  const boughtLegFeeBtc = comboExecution ? undefined : calculatedBoughtFee;
  const totalOpeningFeesBtc = comboFeeBtc ?? soldLegFeeBtc + calculatedBoughtFee;
  const grossEntryBtcPerContract = spreadValue(spread.spreadKind, soldPrice, boughtPrice);
  const grossEntryTotalBtc = grossEntryBtcPerContract * amount;
  // Credit opens with cash received; debit opens with cash paid. Fees are always cash paid.
  const netOpeningCashFlowBtc = (spread.spreadKind === "credit" ? grossEntryTotalBtc : -grossEntryTotalBtc) - totalOpeningFeesBtc;
  const index = normalization.targetIndex;
  return {
    pricingMethod: method, spreadKind: spread.spreadKind,
    soldInstrumentName: spread.soldContract.instrumentName, boughtInstrumentName: spread.boughtContract.instrumentName,
    expiryTimestamp: spread.expiryTimestamp, expiryLabel: spread.expiryLabel, optionType: spread.optionType,
    soldStrikeUsd: spread.soldContract.strike, boughtStrikeUsd: spread.boughtContract.strike,
    contractAmount: amount,
    soldPriceBtcPerContract: soldPrice, soldProceedsBtc: soldPrice * amount,
    boughtPriceBtcPerContract: boughtPrice, boughtCostBtc: boughtPrice * amount,
    soldLegFeeBtc, boughtLegFeeBtc, comboFeeBtc, totalOpeningFeesBtc,
    executionRoute: comboExecution ? "official-combo" : "separate-legs", soldLegFeeCalculation, boughtLegFeeCalculation,
    grossEntryBtcPerContract, grossEntryTotalBtc, netOpeningCashFlowBtc,
    entryIndexUsdPerBtc: index,
    soldProceedsUsd: soldPrice * amount * index, boughtCostUsd: boughtPrice * amount * index,
    totalOpeningFeesUsd: totalOpeningFeesBtc * index, grossEntryTotalUsd: grossEntryTotalBtc * index,
    netOpeningCashFlowUsd: netOpeningCashFlowBtc * index,
    soldPricingTimestamp: normalization.soldLegTimestamp, boughtPricingTimestamp: normalization.boughtLegTimestamp,
    normalizationWindowMinutes: normalization.sold.windowMinutes, executionMode,
    qualityFlag: normalization.qualityFlag, qualityReason: normalization.qualityReason,
    valuationPurpose: "entry", soldRequiredAction: "sell", boughtRequiredAction: "buy",
    soldCompatibleDirection: normalization.sold.schemaDirection, boughtCompatibleDirection: normalization.bought.schemaDirection,
    evidenceWindowStart: normalization.windowStart, evidenceWindowEnd: normalization.windowEnd,
    earliestEvidenceTimestamp: normalization.earliestEvidenceTimestamp, latestEvidenceTimestamp: normalization.latestEvidenceTimestamp,
    usedEvidenceAfterEntry: normalization.usedEvidenceAfterTarget, retrospectiveNormalization: true,
  };
}

export function buildEntryLedgers(
  spread: RetrievedSpread, event: BacktestEvent, executionMode: ExecutionMode, amount: number, comboExecution: boolean,
): EntryLedgers | undefined {
  if (!event.entryTimestamp) return undefined;
  const normalization = normalizeSpread(spread, event.entryTimestamp, event.entryPrice, executionMode);
  if (!normalization) return undefined;
  const raw = makeEntryLedger(spread, normalization, "raw-vwap", executionMode, amount, comboExecution);
  const iv = makeEntryLedger(spread, normalization, "iv-normalized", executionMode, amount, comboExecution);
  return raw && iv ? { raw, iv } : undefined;
}

export function buildValuationPath(
  spread: RetrievedSpread,
  event: BacktestEvent,
  candles: Candle[],
  executionMode: ExecutionMode,
  amount: number,
  comboExecution: boolean,
  specialTimestamps: number[] = [],
): ValuationPoint[] {
  if (!event.entryTimestamp || !spread.expiryTimestamp || !spread.soldContract || !spread.boughtContract) return [];
  const timestamps = valuationTimestamps(event.entryTimestamp, spread.expiryTimestamp, specialTimestamps);
  const entryIndex = event.entryPrice;
  const entryNorm = normalizeSpread(spread, event.entryTimestamp, entryIndex, executionMode);
  if (!entryNorm) return [];
  const entryLedgers = buildEntryLedgers(spread, event, executionMode, amount, comboExecution);
  const rawEntrySold = entryNorm.sold.vwapPriceBtc;
  const rawEntryBought = entryNorm.bought.vwapPriceBtc;
  const ivEntrySold = entryNorm.sold.ivNormalizedPriceBtc;
  const ivEntryBought = entryNorm.bought.ivNormalizedPriceBtc;
  const rawEntryValue = rawEntrySold !== undefined && rawEntryBought !== undefined ? spreadValue(spread.spreadKind, rawEntrySold, rawEntryBought) : undefined;
  const ivEntryValue = ivEntrySold !== undefined && ivEntryBought !== undefined ? spreadValue(spread.spreadKind, ivEntrySold, ivEntryBought) : undefined;
  const rawEntryFees = entryLedgers?.raw.totalOpeningFeesBtc;
  const ivEntryFees = entryLedgers?.iv.totalOpeningFeesBtc;
  let maxAdverse = 0;
  let maxFavorable = 0;
  return timestamps.map(timestamp => {
    const isEntry = timestamp === event.entryTimestamp;
    const isSettlement = timestamp === spread.expiryTimestamp;
    const candle = !isEntry && !isSettlement ? latestCompletedCandleAtOrBefore(candles, timestamp) : undefined;
    const btcIndex = isEntry ? event.entryPrice : isSettlement ? spread.deliveryPrice : candle?.close;
    const btcIndexSource: BtcIndexSource = isEntry ? "event-entry-price" : isSettlement && spread.deliveryPrice !== undefined ? "deribit-delivery-price" : candle ? "completed-candle" : "unavailable";
    const btcIndexTimestamp = isEntry ? event.entryTimestamp : isSettlement && spread.deliveryPrice !== undefined ? timestamp : candle?.closeTime;
    const btcIndexAvailabilityReason = btcIndex === undefined
      ? isSettlement ? `Official Deribit delivery price is unavailable for ${spread.deliveryPriceDate ?? new Date(timestamp).toISOString().slice(0, 10)} (${spread.priceIndex ?? "btc_usd"}).` : "No completed underlying candle exists at or before the valuation timestamp."
      : isEntry ? "Supplied event entry price." : isSettlement ? `Official Deribit ${spread.priceIndex ?? "btc_usd"} delivery price for ${spread.deliveryPriceDate}.` : "Latest completed underlying candle at or before valuation timestamp.";
    const indexEvidence = {
      btcIndex, btcIndexSource, btcIndexTimestamp,
      btcIndexSourceCandleOpenTime: candle?.openTime,
      btcIndexSourceCandleCloseTime: candle?.closeTime,
      btcIndexAgeMs: btcIndexTimestamp === undefined ? undefined : timestamp - btcIndexTimestamp,
      btcIndexAvailabilityReason,
    };
    const normalization: SpreadNormalization | null = btcIndex === undefined ? null : normalizeSpread(spread, timestamp, btcIndex, executionMode, undefined, "close");
    if (timestamp === spread.expiryTimestamp) {
      if (btcIndex === undefined) return {
        timestamp, ...indexEvidence, qualityFlag: "settlement" as const, valuationSource: "settlement-data-unavailable" as const,
        qualityReason: btcIndexAvailabilityReason, usedDirectionFallback: false, usedModelFallback: false,
        valuationPurpose: "settlement" as const, soldRequiredAction: "buy" as const, boughtRequiredAction: "sell" as const,
        soldCompatibleDirection: compatibleSchemaDirection("buy", executionMode), boughtCompatibleDirection: compatibleSchemaDirection("sell", executionMode), executionMode,
        evidenceWindowStart: timestamp, evidenceWindowEnd: timestamp,
      };
      const soldIntrinsic = intrinsicPriceBtc(spread.optionType, btcIndex, spread.soldContract!.strike);
      const boughtIntrinsic = intrinsicPriceBtc(spread.optionType, btcIndex, spread.boughtContract!.strike);
      const value = spreadValue(spread.spreadKind, soldIntrinsic, boughtIntrinsic);
      const makePnl = (entryValue?: number, entryFees?: number) => entryValue === undefined || entryFees === undefined
        ? undefined
        : (spread.spreadKind === "credit" ? entryValue - value : value - entryValue) * amount - entryFees;
      const rawPnlBtc = makePnl(rawEntryValue, rawEntryFees);
      const ivPnlBtc = makePnl(ivEntryValue, ivEntryFees);
      const makeUsdPnl = (entryValue?: number, entryFees?: number) => entryValue === undefined || entryFees === undefined
        ? undefined
        : (spread.spreadKind === "credit"
          ? entryValue * entryIndex - value * btcIndex
          : value * btcIndex - entryValue * entryIndex) * amount - entryFees * entryIndex;
      const rawPnlUsd = makeUsdPnl(rawEntryValue, rawEntryFees);
      const ivPnlUsd = makeUsdPnl(ivEntryValue, ivEntryFees);
      const primary = ivPnlBtc ?? rawPnlBtc ?? 0;
      maxAdverse = Math.min(maxAdverse, primary);
      maxFavorable = Math.max(maxFavorable, primary);
      return {
        timestamp, ...indexEvidence, rawSpreadValue: value, ivSpreadValue: value,
        rawSoldLegPrice: soldIntrinsic, rawBoughtLegPrice: boughtIntrinsic,
        ivSoldLegPrice: soldIntrinsic, ivBoughtLegPrice: boughtIntrinsic,
        rawPnlBtc, ivPnlBtc,
        rawPnlUsd, ivPnlUsd,
        qualityFlag: "settlement" as const, valuationSource: "settlement" as const,
        qualityReason: "Expiry intrinsic settlement; both legs use their exact intrinsic value at the expiry BTC index.",
        usedDirectionFallback: false, usedModelFallback: false,
        valuationPurpose: "settlement" as const, soldRequiredAction: "buy" as const, boughtRequiredAction: "sell" as const,
        soldCompatibleDirection: compatibleSchemaDirection("buy", executionMode), boughtCompatibleDirection: compatibleSchemaDirection("sell", executionMode), executionMode,
        evidenceWindowStart: timestamp, evidenceWindowEnd: timestamp,
        maxAdversePnlSoFar: maxAdverse,
        maxFavorablePnlSoFar: maxFavorable,
      };
    }
    if (!normalization || !normalization.sold.nearestTrade || !normalization.bought.nearestTrade) return {
      timestamp, ...indexEvidence, qualityFlag: btcIndex === undefined ? "underlying-unavailable" as const : "red" as const, valuationSource: "unavailable" as const,
      qualityReason: btcIndex === undefined ? btcIndexAvailabilityReason : "Causal closing-side evidence is unavailable for one or both legs.",
      usedDirectionFallback: Boolean(normalization?.sold.usedDirectionFallback || normalization?.bought.usedDirectionFallback),
      usedModelFallback: Boolean(normalization?.sold.usedModelFallback || normalization?.bought.usedModelFallback),
      valuationPurpose: "close" as const, soldRequiredAction: "buy" as const, boughtRequiredAction: "sell" as const,
      soldCompatibleDirection: compatibleSchemaDirection("buy", executionMode), boughtCompatibleDirection: compatibleSchemaDirection("sell", executionMode), executionMode,
      evidenceWindowStart: normalization?.windowStart ?? timestamp - 720 * 60_000, evidenceWindowEnd: normalization?.windowEnd ?? timestamp,
      newestSupportingPrintTimestamp: normalization?.latestEvidenceTimestamp,
    };
    const rawSold = normalization.sold.vwapPriceBtc;
    const rawBought = normalization.bought.vwapPriceBtc;
    const ivSold = normalization.sold.ivNormalizedPriceBtc;
    const ivBought = normalization.bought.ivNormalizedPriceBtc;
    const rawCurrent = rawSold !== undefined && rawBought !== undefined ? spreadValue(spread.spreadKind, rawSold, rawBought) : undefined;
    const ivCurrent = ivSold !== undefined && ivBought !== undefined ? spreadValue(spread.spreadKind, ivSold, ivBought) : undefined;
    const rawExitFees = rawSold !== undefined && rawBought !== undefined ? feesForPair(rawSold, rawBought, amount, comboExecution, executionMode) : undefined;
    const ivExitFees = ivSold !== undefined && ivBought !== undefined ? feesForPair(ivSold, ivBought, amount, comboExecution, executionMode) : undefined;
    const calcPnl = (entryValue?: number, currentValue?: number, entryFees?: number, exitFees?: number) => {
      if (entryValue === undefined || currentValue === undefined || entryFees === undefined || exitFees === undefined) return undefined;
      return (spread.spreadKind === "credit" ? entryValue - currentValue : currentValue - entryValue) * amount - entryFees - exitFees;
    };
    const rawPnlBtc = calcPnl(rawEntryValue, rawCurrent, rawEntryFees, rawExitFees);
    const ivPnlBtc = calcPnl(ivEntryValue, ivCurrent, ivEntryFees, ivExitFees);
    const primary = ivPnlBtc ?? rawPnlBtc ?? 0;
    maxAdverse = Math.min(maxAdverse, primary);
    maxFavorable = Math.max(maxFavorable, primary);
    const currentIndex = btcIndex!;
    const rawPnlUsd = rawPnlBtc === undefined ? undefined : ((spread.spreadKind === "credit" ? (rawEntryValue ?? 0) * entryIndex - (rawCurrent ?? 0) * currentIndex : (rawCurrent ?? 0) * currentIndex - (rawEntryValue ?? 0) * entryIndex) * amount - (rawEntryFees ?? 0) * entryIndex - (rawExitFees ?? 0) * currentIndex);
    const ivPnlUsd = ivPnlBtc === undefined ? undefined : ((spread.spreadKind === "credit" ? (ivEntryValue ?? 0) * entryIndex - (ivCurrent ?? 0) * currentIndex : (ivCurrent ?? 0) * currentIndex - (ivEntryValue ?? 0) * entryIndex) * amount - (ivEntryFees ?? 0) * entryIndex - (ivExitFees ?? 0) * currentIndex);
    return {
      timestamp,
      ...indexEvidence,
      rawSpreadValue: rawCurrent,
      ivSpreadValue: ivCurrent,
      rawSoldLegPrice: rawSold,
      rawBoughtLegPrice: rawBought,
      ivSoldLegPrice: ivSold,
      ivBoughtLegPrice: ivBought,
      rawPnlBtc,
      ivPnlBtc,
      rawPnlUsd,
      ivPnlUsd,
      rawCreditCapturedPct: spread.spreadKind === "credit" && rawEntryValue && rawCurrent !== undefined ? (rawEntryValue - rawCurrent) / rawEntryValue : undefined,
      ivCreditCapturedPct: spread.spreadKind === "credit" && ivEntryValue && ivCurrent !== undefined ? (ivEntryValue - ivCurrent) / ivEntryValue : undefined,
      qualityFlag: normalization.qualityFlag,
      valuationSource: normalization.sold.usedModelFallback || normalization.bought.usedModelFallback ? "model-fallback" : "trade-window",
      qualityReason: normalization.qualityReason,
      soldLegGapMin: normalization.sold.nearestTimeGapMin,
      boughtLegGapMin: normalization.bought.nearestTimeGapMin,
      synchronizationGapMin: normalization.legTimeDiffMin,
      indexMismatch: normalization.indexDiffPct,
      usedDirectionFallback: normalization.sold.usedDirectionFallback || normalization.bought.usedDirectionFallback,
      usedModelFallback: normalization.sold.usedModelFallback || normalization.bought.usedModelFallback,
      maxAdversePnlSoFar: maxAdverse,
      maxFavorablePnlSoFar: maxFavorable,
      valuationPurpose: "close",
      soldRequiredAction: normalization.sold.requiredAction,
      boughtRequiredAction: normalization.bought.requiredAction,
      soldCompatibleDirection: normalization.sold.schemaDirection,
      boughtCompatibleDirection: normalization.bought.schemaDirection,
      executionMode,
      evidenceWindowStart: normalization.windowStart,
      evidenceWindowEnd: normalization.windowEnd,
      newestSupportingPrintTimestamp: normalization.latestEvidenceTimestamp,
      rawExitFeesBtc: rawExitFees,
      ivExitFeesBtc: ivExitFees,
    };
  });
}

export function buildValuation(
  spread: RetrievedSpread, event: BacktestEvent, candles: Candle[], executionMode: ExecutionMode,
  amount: number, comboExecution: boolean, specialTimestamps: number[] = [],
): ValuationRun {
  return {
    entryLedgers: buildEntryLedgers(spread, event, executionMode, amount, comboExecution),
    path: buildValuationPath(spread, event, candles, executionMode, amount, comboExecution, specialTimestamps),
  };
}

function firstCausalPathPoint(path: ValuationPoint[], timestamp: number, allowSettlement = false) {
  return path.find(point => point.timestamp >= timestamp
    && point.rawPnlBtc !== undefined && point.ivPnlBtc !== undefined
    && (allowSettlement ? point.valuationSource === "settlement" : point.valuationSource === "trade-window")
    && (allowSettlement || point.qualityFlag !== "red")
    && !point.usedDirectionFallback && !point.usedModelFallback
    && point.btcIndexSource !== "unavailable"
    && point.btcIndexTimestamp !== undefined && point.btcIndexTimestamp <= point.timestamp
    && (point.btcIndexSourceCandleCloseTime === undefined || point.btcIndexSourceCandleCloseTime <= point.timestamp)
    && (point.newestSupportingPrintTimestamp === undefined || point.newestSupportingPrintTimestamp <= point.timestamp));
}

export function evaluateExits(path: ValuationPoint[], spread: RetrievedSpread, event: BacktestEvent, candles: Candle[]): ExitResult[] {
  if (!path.length || !event.entryTimestamp) return [];
  const toExit = (rule: string, point: ValuationPoint | undefined, timing: Partial<ExitResult> = {}): ExitResult => point ? {
    rule,
    ...timing,
    valuationTimestamp: point.timestamp,
    timestamp: point.timestamp,
    rawPnlBtc: point.rawPnlBtc,
    ivPnlBtc: point.ivPnlBtc,
    rawPnlUsd: point.rawPnlUsd,
    ivPnlUsd: point.ivPnlUsd,
    qualityFlag: point.qualityFlag,
    valuationSource: point.valuationSource,
    rawExitFeesBtc: point.rawExitFeesBtc,
    ivExitFeesBtc: point.ivExitFeesBtc,
    reasonCode: point.valuationSource === "settlement" ? "settlement" : "triggered",
    qualityReason: point.qualityReason,
    status: "hit",
  } : { rule, ...timing, reasonCode: "causal-valuation-unavailable", status: "unavailable", qualityReason: "No causally supported closing-side valuation was available at or after the decision timestamp." };
  const vpocTouch = event.vpocPrice ? firstTouch(candles, event.vpocPrice, event.entryTimestamp) : undefined;
  const invalidation = firstInvalidationClose(candles, event, event.entryTimestamp);
  const results: ExitResult[] = [
    !event.vpocPrice
      ? { rule: "VPOC hit", status: "unavailable", reasonCode: "not-configured", qualityReason: "No VPOC target was configured." }
      : !vpocTouch
        ? { rule: "VPOC hit", status: "not-hit", reasonCode: "not-hit", qualityReason: "The exit condition was not reached." }
        : toExit("VPOC hit", firstCausalPathPoint(path, vpocTouch.closeTime), { triggerTimestamp: vpocTouch.closeTime, sourceCandleOpenTimestamp: vpocTouch.openTime, sourceCandleCloseTimestamp: vpocTouch.closeTime, decisionAvailableTimestamp: vpocTouch.closeTime }),
  ];
  if (spread.spreadKind === "credit") {
    for (const [rule, threshold] of [["50% credit", 0.5], ["70% credit", 0.7]] as const) {
      const point = path.find(candidate => candidate.valuationSource === "trade-window" && candidate.qualityFlag !== "red" && !candidate.usedDirectionFallback && !candidate.usedModelFallback && candidate.btcIndexSource !== "unavailable" && candidate.btcIndexTimestamp !== undefined && candidate.btcIndexTimestamp <= candidate.timestamp && (candidate.btcIndexSourceCandleCloseTime === undefined || candidate.btcIndexSourceCandleCloseTime <= candidate.timestamp) && (candidate.newestSupportingPrintTimestamp === undefined || candidate.newestSupportingPrintTimestamp <= candidate.timestamp) && (candidate.ivCreditCapturedPct ?? candidate.rawCreditCapturedPct ?? -Infinity) >= threshold);
      const triggeredPricingMethod: EntryPricingMethod | undefined = point ? (point.ivCreditCapturedPct !== undefined ? "iv-normalized" : "raw-vwap") : undefined;
      results.push(point ? toExit(rule, point, { triggerTimestamp: point.timestamp, decisionAvailableTimestamp: point.timestamp, triggeredPricingMethod }) : { rule, status: "not-hit", reasonCode: "not-hit", qualityReason: "The causal close-side credit-capture threshold was not reached." });
    }
  } else {
    results.push({ rule: "50% credit", status: "unavailable", reasonCode: "not-configured", qualityReason: "Credit capture does not apply to debit spreads." }, { rule: "70% credit", status: "unavailable", reasonCode: "not-configured", qualityReason: "Credit capture does not apply to debit spreads." });
  }
  for (const days of [3, 5, 7, 14]) {
    const timestamp = event.entryTimestamp + days * 86_400_000;
    if (spread.expiryTimestamp !== undefined && timestamp > spread.expiryTimestamp) results.push({ rule: `${days}D fixed`, triggerTimestamp: timestamp, decisionAvailableTimestamp: timestamp, status: "unavailable", reasonCode: "after-expiry", qualityReason: "The fixed-time target is after contract expiry." });
    else results.push(toExit(`${days}D fixed`, firstCausalPathPoint(path, timestamp), { triggerTimestamp: timestamp, decisionAvailableTimestamp: timestamp }));
  }
  results.push(invalidation ? toExit("4H invalidation", firstCausalPathPoint(path, invalidation.closeTime), { triggerTimestamp: invalidation.closeTime, sourceCandleOpenTimestamp: invalidation.openTime, sourceCandleCloseTimestamp: invalidation.closeTime, decisionAvailableTimestamp: invalidation.closeTime }) : { rule: "4H invalidation", status: "not-hit", reasonCode: "not-hit", qualityReason: "The invalidation condition was not reached." });
  const settlement = path.find(point => point.valuationSource === "settlement");
  const unavailableSettlement = path.find(point => point.valuationSource === "settlement-data-unavailable");
  results.push(settlement ? toExit("Expiry", settlement, { triggerTimestamp: spread.expiryTimestamp, decisionAvailableTimestamp: spread.expiryTimestamp }) : {
    rule: "Expiry", triggerTimestamp: spread.expiryTimestamp, decisionAvailableTimestamp: spread.expiryTimestamp,
    valuationTimestamp: unavailableSettlement?.timestamp, timestamp: unavailableSettlement?.timestamp,
    qualityFlag: unavailableSettlement?.qualityFlag, valuationSource: unavailableSettlement?.valuationSource,
    reasonCode: "causal-valuation-unavailable", status: "unavailable", qualityReason: unavailableSettlement?.qualityReason ?? "Official Deribit settlement data is unavailable.",
  });
  return results;
}

export function qualityRank(flag: QualityFlag) {
  return flag === "green" ? 2 : flag === "yellow" ? 1 : 0;
}
