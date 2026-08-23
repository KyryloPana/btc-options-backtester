import test from "node:test";import assert from "node:assert/strict";
import {buildEventFuturesBaseline,FUTURES_ENGINE_VERSION} from "../app/lib/futures-baseline.ts";
import {ENTRY,HOUR,VPOC_DECISION,futuresEvent,futuresMarket} from "./fixtures/futures-market.ts";

test("genuine perpetual baseline is causal, direction aware, event-level and funded",()=>{
 for(const direction of ["long","short"] as const){
  const x=buildEventFuturesBaseline(futuresEvent(direction));
  assert.equal(x.comparison.instrument,"BTC-PERPETUAL");
  assert.equal(x.comparison.direction,direction);
  assert.equal(x.comparison.engine_version,FUTURES_ENGINE_VERSION);
  assert.equal((x.comparison.observed_evidence_ids as string[])[0],"perp-trade-1");
  // Entry bar through the VPOC decision bar inclusive: eight hourly observations.
  assert.equal(x.path.length,8);
  assert.ok(x.path.every(p=>p.event_id==="mr-1"&&p.series_kind==="futures"&&p.observation_kind==="reference"));
  assert.equal(x.comparison.futures_margin_status,"unavailable");
  assert.equal(x.comparison.equal_capital_status,"unavailable");
  assert.equal(x.comparison.funding_status,"available");
 }
});

test("the VPOC exit is taken at the decision, never backdated to the touch candle",()=>{
 const x=buildEventFuturesBaseline(futuresEvent("long"));
 assert.equal(x.comparison.exit_decision_timestamp_utc,new Date(VPOC_DECISION).toISOString());
 assert.equal(x.comparison.exit_timestamp_utc,new Date(VPOC_DECISION).toISOString());
 assert.notEqual(x.comparison.exit_timestamp_utc,x.comparison.exit_trigger_timestamp_utc);
 assert.equal(x.comparison.exit_price,107,"filled at the open of the first bar at or after the decision");
});

test("spot identity and zero invalidation distance cannot masquerade or size",()=>{
 const bad=futuresEvent("long",{futuresMarket:futuresMarket("long",{instrument:"btc_usd"})});
 const rejected=buildEventFuturesBaseline(bad);
 assert.equal(rejected.comparison.availability,"unavailable");
 assert.deepEqual(rejected.comparison.reason_codes,["unsupported_futures_instrument","futures_margin_unavailable"]);
 const zero=buildEventFuturesBaseline(futuresEvent("long",{invalidationPrice:100}));
 assert.equal(zero.comparison.quantity,null);
 assert.equal(zero.comparison.equal_risk_sizing_status,"downstream_derivable");
 assert.equal(zero.comparison.gross_pnl_usd_per_unit,7,"per-unit economics survive when a derived quantity cannot");
});

test("future tape is not borrowed and missing funding is explicit",()=>{
 const market=futuresMarket("long");
 market.trades=[{...market.trades![0],timestamp:ENTRY-1}];
 delete market.funding;
 delete market.fundingCoverage;
 const x=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:market}));
 assert.equal(x.comparison.observed_execution_status,"unavailable");
 assert.equal(x.comparison.funding_status,"unavailable");
 assert.equal(x.comparison.funding_usd_per_unit,null,"funding is unknown, never zero");
 assert.equal(x.comparison.net_pnl_usd_per_unit_after_funding,null);
 assert.equal(x.comparison.net_pnl_usd,null);
 assert.ok(Number.isFinite(x.comparison.net_pnl_usd_per_unit_before_funding as number),"a price-and-fee baseline still stands without funding");
 assert.ok((x.comparison.reason_codes as string[]).includes("funding_unavailable"));
});

test("a fully absent perpetual retrieval is never replaced by the underlying path",()=>{
 const x=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:undefined}));
 assert.equal(x.comparison.availability,"unavailable");
 assert.deepEqual(x.comparison.reason_codes,["futures_instrument_unavailable","futures_margin_unavailable"]);
 assert.equal(x.path.length,0);
 const empty=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:futuresMarket("long",{reference:[]})}));
 assert.equal(empty.comparison.availability,"unavailable");
 assert.ok((empty.comparison.reason_codes as string[]).includes("futures_reference_series_unavailable"));
});

test("a hole at the exit decision is unavailable rather than carried forward",()=>{
 const market=futuresMarket("long");
 market.reference=market.reference.filter(point=>point.timestamp!==ENTRY+7*HOUR);
 const x=buildEventFuturesBaseline(futuresEvent("long",{futuresMarket:market}));
 assert.equal(x.comparison.availability,"unavailable");
 assert.ok((x.comparison.reason_codes as string[]).includes("futures_series_gap_at_decision"));
 assert.equal(x.comparison.exit_price,undefined,"no price is invented for the missing bar");
});
