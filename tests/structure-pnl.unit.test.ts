import test from "node:test";import assert from "node:assert/strict";import {pricedStructures,reconcileStructureSelection,structureCoverage} from "../app/lib/structure-pnl.ts";
const rows=[{id:"green",status:"priced" as const,estimateQuality:"green" as const},{id:"red",status:"priced" as const,estimateQuality:"red" as const},{id:"missing",status:"unavailable" as const,reason:"no legs"}];
test("unavailable rows excluded and red priced rows retained",()=>assert.deepEqual(pricedStructures(rows).map(r=>r.id),["green","red"]));
test("coverage denominator includes every eligible structure",()=>assert.deepEqual(structureCoverage(rows),{priced:2,total:3,unavailable:1,reasons:{"no legs":1}}));
test("selection clears when unavailable",()=>assert.deepEqual(reconcileStructureSelection(rows,"missing",["green","missing"]),{selectedId:undefined,expandedIds:["green"]}));
test("event or dataset replacement leaves no stale payoff",()=>assert.deepEqual(reconcileStructureSelection([{id:"new",status:"priced"}],"green",["green"]),{selectedId:undefined,expandedIds:[]}));
