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

export interface EventTiming {
  /** Signal timestamp; the entry decision is available at the same instant. */
  entryTimestamp: number | null;
  direction: "long" | "short" | null;
  invalidationPrice: number | null;
  /** VPOC touch as recorded on the event. */
  vpocTriggerTimestamp: number | null;
  /** VPOC is only actionable at the close of the candle that touched it. */
  vpocDecisionTimestamp: number | null;
  /** Open of the first post-entry candle that traded through the invalidation level. */
  invalidationTriggerTimestamp: number | null;
  /** Close of that candle: the first instant the breach is known. */
  invalidationDecisionTimestamp: number | null;
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

export function resolveEventTiming(input: EventTimingInput): EventTiming {
  const source = object(input.sourceRun), event = object(source.event ?? source);
  const entryTimestamp = number(event.entryTimestamp) ?? (typeof event.entryDate === "string" ? Date.parse(`${event.entryDate}T00:00:00Z`) : null);
  const vpocTriggerTimestamp = number(event.vpocTimestamp);
  const invalidationPrice = number(event.invalidationPrice);
  const direction = event.direction === "long" ? "long" : event.direction === "short" ? "short" : null;
  const path = input.underlyingHourlyPath;
  let invalidationDecisionTimestamp: number | null = null;
  if (entryTimestamp !== null && invalidationPrice !== null) {
    const hit = path.find(candle => candle.openTime >= entryTimestamp && (direction === "long" ? candle.low <= invalidationPrice : candle.high >= invalidationPrice));
    invalidationDecisionTimestamp = hit?.closeTime ?? null;
  }
  const observationEndTimestamp = path.length ? Math.max(...path.map(candle => candle.closeTime)) : entryTimestamp;
  // Preserved exactly as `events.jsonl` has always computed it: the VPOC touch
  // is compared against the invalidation *decision*, and equality is reported
  // as ambiguous rather than silently ordered.
  const sequenceStatus: EventSequenceStatus = vpocTriggerTimestamp !== null && invalidationDecisionTimestamp !== null
    ? (vpocTriggerTimestamp === invalidationDecisionTimestamp ? "ambiguous" : vpocTriggerTimestamp < invalidationDecisionTimestamp ? "vpoc_first" : "invalidation_first")
    : vpocTriggerTimestamp !== null ? "vpoc_first" : invalidationDecisionTimestamp !== null ? "invalidation_first" : "unresolved";
  return {
    entryTimestamp, direction, invalidationPrice,
    vpocTriggerTimestamp,
    vpocDecisionTimestamp: vpocTriggerTimestamp === null ? null : vpocTriggerTimestamp + HOUR_MS,
    invalidationTriggerTimestamp: invalidationDecisionTimestamp === null ? null : invalidationDecisionTimestamp - HOUR_MS,
    invalidationDecisionTimestamp,
    observationEndTimestamp,
    sequenceStatus,
  };
}
