import test from "node:test";
import assert from "node:assert/strict";
import {buildResearchEconomicsReport} from "../app/lib/research-economics/report.ts";
import {completeStatistic} from "../app/lib/research-economics/statistics.ts";

test("null Research exit policy is not silently replaced by Thesis",()=>{const report=buildResearchEconomicsReport({tables:{}} as never,null,"modeled_expected");assert.equal(report.status,"not_configured");assert.equal(report.researchExitPolicy,null);assert.deepEqual(report.configurations,[])});
test("incomplete canonical USD coverage cannot appear complete and unavailable is not zero",()=>{const result=completeStatistic([10,null],2);assert.equal(result.value,null);assert.equal(result.effectiveN,1);assert.equal(result.requiredN,2);assert.match(result.reason!,/1 \/ 2/)});
test("complete USD aggregation uses per-observation USD values",()=>{const result=completeStatistic([100,300],2);assert.equal(result.value,200);assert.equal(result.reason,null)});
test("Research implementation has no portfolio/account dependency",async()=>{const source=await import("node:fs/promises").then(fs=>fs.readFile(new URL("../app/lib/research-economics/report.ts",import.meta.url),"utf8"));assert.doesNotMatch(source,/portfolio\.ts|reconstructPortfolio|accountEquity|drawdown|concurrency|availableFunds/) });
