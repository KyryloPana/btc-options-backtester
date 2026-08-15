export const INVERSE_OPTION_MODEL = "Deribit inverse Black–Scholes/1.0.0";
export const MILLISECONDS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export type InverseOptionPricingResult =
  | { status: "priced"; priceBtc: number; priceUsd: number; timeYears: number; forwardPrice: number; rate: number }
  | { status: "unavailable"; reason: string };

export interface InverseOptionPricingInput {
  optionType: "call" | "put";
  indexPrice: number;
  strike: number;
  valuationTimestamp: number;
  expiryTimestamp: number;
  ivDecimal: number;
  forwardPrice?: number;
}

/** Abramowitz-Stegun 7.1.26; maximum absolute error is approximately 7.5e-8. */
export function normalCdf(value: number): number {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * x);
  const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const tail = density * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
}

export function priceInverseOption(input: InverseOptionPricingInput): InverseOptionPricingResult {
  const { indexPrice: index, strike, valuationTimestamp, expiryTimestamp, ivDecimal } = input;
  if (!(index > 0) || !(strike > 0) || !(ivDecimal > 0) || ![index, strike, ivDecimal, valuationTimestamp, expiryTimestamp].every(Number.isFinite)) {
    return { status: "unavailable", reason: "Index, strike, IV, and timestamps must be finite; prices and IV must be positive." };
  }
  const timeYears = Math.max((expiryTimestamp - valuationTimestamp) / MILLISECONDS_PER_YEAR, 0);
  if (timeYears === 0) {
    const priceBtc = input.optionType === "call" ? Math.max(index - strike, 0) / index : Math.max(strike - index, 0) / index;
    return Number.isFinite(priceBtc) ? { status: "priced", priceBtc, priceUsd: priceBtc * index, timeYears, forwardPrice: index, rate: 0 } : { status: "unavailable", reason: "Intrinsic value is non-finite." };
  }
  const suppliedForward = input.forwardPrice;
  const hasForward = suppliedForward !== undefined && Number.isFinite(suppliedForward) && suppliedForward > 0;
  const forwardPrice = hasForward ? suppliedForward : index;
  const rate = hasForward ? Math.log(forwardPrice / index) / timeYears : 0;
  const sigmaRootT = ivDecimal * Math.sqrt(timeYears);
  const d1 = (Math.log(index / strike) + (rate + ivDecimal * ivDecimal / 2) * timeYears) / sigmaRootT;
  const d2 = d1 - sigmaRootT;
  const discountedStrike = strike * Math.exp(-rate * timeYears);
  const priceUsd = input.optionType === "call"
    ? index * normalCdf(d1) - discountedStrike * normalCdf(d2)
    : discountedStrike * normalCdf(-d2) - index * normalCdf(-d1);
  const priceBtc = priceUsd / index;
  if (![d1, d2, rate, priceUsd, priceBtc].every(Number.isFinite) || priceUsd < 0 || priceBtc < 0) return { status: "unavailable", reason: "The model produced a non-finite or negative value." };
  return { status: "priced", priceBtc, priceUsd, timeYears, forwardPrice, rate };
}
