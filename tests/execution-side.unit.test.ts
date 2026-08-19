import test from "node:test";
import assert from "node:assert/strict";
import {tapeDirectionFor} from "../app/lib/execution-side.ts";

/**
 * The four rows of the reference table, expressed as (action, mode) pairs.
 * Open/close is not an input to tapeDirectionFor -- "sell to open short" and
 * "sell to close long" both reduce to action="sell", and the table's own
 * rows confirm the mapping is identical in both cases. Callers are
 * responsible for choosing the right action per leg per entry/exit; this
 * function only maps action+mode -> tape direction.
 */

test("sell to open short: maker-relevant tape is taker buy, taker-relevant tape is taker sell",()=>{
 assert.equal(tapeDirectionFor("sell","maker"),"buy");
 assert.equal(tapeDirectionFor("sell","taker"),"sell");
});

test("buy to open long: maker-relevant tape is taker sell, taker-relevant tape is taker buy",()=>{
 assert.equal(tapeDirectionFor("buy","maker"),"sell");
 assert.equal(tapeDirectionFor("buy","taker"),"buy");
});

test("buy to close short: same mapping as any other buy action",()=>{
 // The reference table lists this as its own row, but the mapping only
 // depends on the action -- confirms open/close does not need to be a
 // separate input.
 assert.equal(tapeDirectionFor("buy","maker"),"sell");
 assert.equal(tapeDirectionFor("buy","taker"),"buy");
});

test("sell to close long: same mapping as any other sell action",()=>{
 assert.equal(tapeDirectionFor("sell","maker"),"buy");
 assert.equal(tapeDirectionFor("sell","taker"),"sell");
});

test("maker and taker are always opposite tape directions for the same action",()=>{
 for(const action of ["buy","sell"] as const){
  assert.notEqual(tapeDirectionFor(action,"maker"),tapeDirectionFor(action,"taker"));
 }
});
