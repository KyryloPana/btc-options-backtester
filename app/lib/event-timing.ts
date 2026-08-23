import type { Candle } from "./backtester.ts";
import type { JsonValue } from "./research-selections.ts";

/**
 * The single canonical reading of an MR event's timing.
 *
 * This is the exact policy the options research layer exports on
 * `events.jsonl`; the futures baseline consumes the same function so the two
 * layers cannot drift into disagreeing about when a decision became
 * actionable. Triggers and decisions are kept separate on purpose: the
 * underlying path is stamped at candle open, so a level touched inside an
 * hourly candle is only *known* at that candle's close.
 */
export type EventSequenceStatus = "vpoc_first" | "invalidation_first" | "ambiguous" | "unresolved";
/**
 * `not_configured` means the event carries no VPOC target at all -- a
 * data-quality fact. `not_reached` means the target exists and simply was not
 * touched during the observation window, which is a genuine research outcome
 * and must stay analysable. The two are never collapsed.
 */
export type VpocTargetStatus = "reached" | "not_reached" | "not_configured";

export interface EventTiming {
  /** Signal timestamp; the entry decision is available at the same instant. */
  entryTimestamp: number | null;
  direction: "long" | "short" | null;
  invalidationPrice: number | null;
  vpocTargetPrice: number | null;
  vpocTargetStatus: VpocTargetStatus;
  /** VPOC touch as recorded on the event. */
  vpocTriggerTimestamp: number | null;
  /** VPOC is only actionable at the close of the candle that touched it. */
  vpocDecisionTimestamp: number | null;
  /** Open of the first post-entry candle that traded through the invalidation level. */
  invalidationTriggerTimestamp: number | null;
  /** Close of that candle: the first instant the breach is known. */
  invalidationDecisionTimestamp: number | null;
  /**
   * The candle each decision lands in. Sequence classification compares THESE,
   * so neither outcome gains priority from being represented by a candle open
   * while the other is represented by a candle close.
   */
  vpocDecisionCandleOpenTimestamp: number | null;
  invalidationDecisionCandleOpenTimestamp: number | null;
  /** Resolution the ordering claim is asserted at. */
  sequenceResolutionMs: number;
  observationEndTimestamp: number | null;
  /**
   * Canonical `sequence_status`. `ambiguous` means VPOC and invalidation cannot
   * be ordered at the precision the underlying path has.
   */
  sequenceStatus: EventSequenceStatus;
}

const HOUR_MS = 3_600_000;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

export interface EventTimingInput { sourceRun: JsonValue; underlyingHourlyPath: readonly Candle[] }

/** Smallest positive candle spacing actually present; the precision any ordering claim may be asserted at. */
function pathResolutionMs(path: readonly Candle[]): number {
  let smallest = Infinity;
  for (let i = 1; i < path.length; i += 1) { const gap = path[i].openTime - path[i - 1].openTime; if (gap > 0 && gap < smallest) smallest = gap; }
  return Number.isFinite(smallest) ? smallest : HOUR_MS;
}

export function resolveEventTiming(input: EventTimingInput): EventTiming {
  const source = object(input.sourceRun), event = object(source.event ?? source);
  const entryTimestamp = number(event.entryTimestamp) ?? (typeof event.entryDate === "string" ? Date.parse(`${event.entryDate}T00:00:00Z`) : null);
  const vpocTriggerTimestamp = number(event.vpocTimestamp);
  const vpocTargetPrice = number(event.vpocPrice);
  const invalidationPrice = number(event.invalidationPrice);
  const direction = event.direction === "long" ? "long" : event.direction === "short" ? "short" : null;
  const path = input.underlyingHourlyPath;
  const resolutionMs = pathResolutionMs(path);
  const invalidationCandle = entryTimestamp !== null && invalidationPrice !== null
    ? path.find(candle => candle.openTime >= entryTimestamp && (direction === "long" ? candle.low <= invalidationPrice : candle.high >= invalidationPrice))
    : undefined;
  const invalidationDecisionTimestamp = invalidationCandle?.closeTime ?? null;
  const observationEndTimestamp = path.length ? Math.max(...path.map(candle => candle.closeTime)) : entryTimestamp;
  // The candle each decision belongs to. The invalidation candle is the one the
  // path scan actually matched; the VPOC candle is the one containing its touch.
  const vpocCandle = vpocTriggerTimestamp === null ? undefined
    : path.find(candle => candle.openTime <= vpocTriggerTimestamp && vpocTriggerTimestamp <= candle.closeTime);
  const vpocDecisionCandleOpenTimestamp = vpocTriggerTimestamp === null ? null
    : vpocCandle?.openTime ?? Math.floor(vpocTriggerTimestamp / resolutionMs) * resolutionMs;
  const invalidationDecisionCandleOpenTimestamp = invalidationCandle?.openTime ?? null;
  // Like-for-like: both sides are compared as the candle their decision lands
  // in. Comparing a VPOC candle OPEN against an invalidation candle CLOSE used
  // to hand VPOC a systematic sub-candle head start, so a touch and a breach
  // inside the same hour were reported as vpoc_first instead of ambiguous.
  const sequenceStatus: EventSequenceStatus = vpocDecisionCandleOpenTimestamp !== null && invalidationDecisionCandleOpenTimestamp !== null
    ? (vpocDecisionCandleOpenTimestamp === invalidationDecisionCandleOpenTimestamp ? "ambiguous"
      : vpocDecisionCandleOpenTimestamp < invalidationDecisionCandleOpenTimestamp ? "vpoc_first" : "invalidation_first")
    : vpocDecisionCandleOpenTimestamp !== null ? "vpoc_first"
      : invalidationDecisionCandleOpenTimestamp !== null ? "invalidation_first" : "unresolved";
  return {
    entryTimestamp, direction, invalidationPrice, vpocTargetPrice,
    vpocTargetStatus: vpocTriggerTimestamp !== null ? "reached" : vpocTargetPrice !== null ? "not_reached" : "not_configured",
    vpocTriggerTimestamp,
    vpocDecisionTimestamp: vpocTriggerTimestamp === null ? null : vpocTriggerTimestamp + HOUR_MS,
    invalidationTriggerTimestamp: invalidationCandle?.openTime ?? null,
    invalidationDecisionTimestamp,
    vpocDecisionCandleOpenTimestamp, invalidationDecisionCandleOpenTimestamp,
    sequenceResolutionMs: resolutionMs,
    observationEndTimestamp, sequenceStatus,
  };
}
