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
  ivDecimal?: number;
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
  if (!(index > 0) || !(strike > 0) || (input.optionType !== "call" && input.optionType !== "put") || ![index, strike, valuationTimestamp, expiryTimestamp].every(Number.isFinite)) {
    return { status: "unavailable", reason: "Option type, index, strike, and timestamps must be valid; prices must be positive." };
  }
  const timeYears = Math.max((expiryTimestamp - valuationTimestamp) / MILLISECONDS_PER_YEAR, 0);
  if (timeYears === 0) {
    const priceBtc = input.optionType === "call" ? Math.max(index - strike, 0) / index : Math.max(strike - index, 0) / index;
    return Number.isFinite(priceBtc) ? { status: "priced", priceBtc, priceUsd: priceBtc * index, timeYears, forwardPrice: index, rate: 0 } : { status: "unavailable", reason: "Intrinsic value is non-finite." };
  }
  if (ivDecimal === undefined || !(ivDecimal > 0) || !Number.isFinite(ivDecimal)) return { status: "unavailable", reason: "Pre-expiry IV must be finite and positive." };
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

/** Deterministic inversion of the authoritative inverse-option equation. */
export function impliedVolatilityFromInversePrice(input: Omit<InverseOptionPricingInput,"ivDecimal"> & {priceBtc:number}): number|null {
  if (!(input.priceBtc >= 0) || !Number.isFinite(input.priceBtc) || input.expiryTimestamp <= input.valuationTimestamp) return null;
  const value=(iv:number)=>{const result=priceInverseOption({...input,ivDecimal:iv});return result.status==="priced"?result.priceBtc:null};
  let low=1e-6,high=8;
  const lo=value(low),hi=value(high);
  if(lo===null||hi===null||input.priceBtc<lo-1e-12||input.priceBtc>hi+1e-12)return null;
  for(let i=0;i<100;i++){const mid=(low+high)/2,price=value(mid);if(price===null)return null;if(price<input.priceBtc)low=mid;else high=mid;}
  return (low+high)/2;
}
