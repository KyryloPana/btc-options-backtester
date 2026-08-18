import test from "node:test";
import assert from "node:assert/strict";
import {fiveNumber,kaplanMeier,kaplanMeierQuantile,observedPercentiles,quantiles,riskSummary} from "../app/lib/underlying-resolution/statistics.ts";

const at=(curve:ReturnType<typeof kaplanMeier>,t:number)=>curve.find(p=>p.timeDays===t);
const close=(a:number|null|undefined,b:number,msg?:string)=>assert.ok(a!==null&&a!==undefined&&Math.abs(a-b)<1e-9,`${msg??""} expected ${b}, got ${a}`);

test("D: Kaplan-Meier on a fully observed dataset steps by 1/n each time",()=>{
 const curve=kaplanMeier([1,2,3,4,5].map(timeDays=>({timeDays,observed:true})));
 close(at(curve,1)?.survival,0.8);
 close(at(curve,2)?.survival,0.6);
 close(at(curve,3)?.survival,0.4);
 close(at(curve,4)?.survival,0.2);
 close(at(curve,5)?.survival,0);
 close(curve[0]?.survival,1,"S(0) anchor");
});

test("D: a censored observation leaves the risk set without counting as a resolution",()=>{
 const curve=kaplanMeier([{timeDays:1,observed:true},{timeDays:2,observed:false},{timeDays:3,observed:true}]);
 // t=1: 3 at risk, 1 event -> 2/3. The censoring at t=2 produces no step.
 close(at(curve,1)?.survival,2/3);
 assert.equal(at(curve,2),undefined,"censoring alone must not create a step");
 // t=3: only the last observation remains at risk.
 assert.equal(at(curve,3)?.atRisk,1);
 close(at(curve,3)?.survival,0);
});

test("D: tied resolutions collapse into a single step",()=>{
 const curve=kaplanMeier([{timeDays:2,observed:true},{timeDays:2,observed:true},{timeDays:5,observed:true}]);
 assert.equal(at(curve,2)?.events,2);
 assert.equal(at(curve,2)?.atRisk,3);
 close(at(curve,2)?.survival,1/3);
});

test("D: an observation censored at an event time stays in that event's risk set",()=>{
 const curve=kaplanMeier([{timeDays:2,observed:true},{timeDays:2,observed:false},{timeDays:4,observed:true}]);
 assert.equal(at(curve,2)?.atRisk,3,"events precede censorings at tied times");
 close(at(curve,2)?.survival,2/3);
 assert.equal(at(curve,4)?.atRisk,1);
});

test("D: multiple censoring times shrink the risk set without altering survival",()=>{
 const curve=kaplanMeier([{timeDays:1,observed:false},{timeDays:2,observed:false},{timeDays:3,observed:true},{timeDays:4,observed:false}]);
 assert.equal(at(curve,3)?.atRisk,2);
 close(at(curve,3)?.survival,0.5);
});

test("D: confidence band stays inside (0,1) and is absent where not estimable",()=>{
 const curve=kaplanMeier([1,2,3,4,5,6,7,8].map(timeDays=>({timeDays,observed:true})));
 const mid=at(curve,4)!;
 assert.ok(mid.lower!==null&&mid.upper!==null);
 assert.ok(mid.lower! > 0 && mid.lower! <= mid.survival,"lower bound below estimate");
 assert.ok(mid.upper! >= mid.survival && mid.upper! < 1,"upper bound above estimate");
 // Once survival hits exactly 0 the log-log band is undefined.
 assert.equal(at(curve,8)?.lower,null);
});

test("E: percentiles are read off the curve, not from raw order statistics",()=>{
 const curve=kaplanMeier([1,2,3,4,5].map(timeDays=>({timeDays,observed:true})));
 // Smallest t where S(t) <= 0.5 is t=3 (S=0.4), not the raw median of 3.
 assert.equal(kaplanMeierQuantile(curve,0.5),3);
 assert.equal(kaplanMeierQuantile(curve,0.2),1);
 assert.equal(kaplanMeierQuantile(curve,0.9),5);
});

test("E: a percentile the curve never reaches is Not estimable, never a number",()=>{
 // Heavy censoring: survival never falls below 0.75.
 const curve=kaplanMeier([{timeDays:1,observed:true},{timeDays:2,observed:false},{timeDays:3,observed:false},{timeDays:4,observed:false}]);
 close(curve[curve.length-1]?.survival,0.75);
 assert.equal(kaplanMeierQuantile(curve,0.5),null,"median must be Not estimable");
 assert.equal(kaplanMeierQuantile(curve,0.9),null);
 assert.equal(kaplanMeierQuantile(curve,0.2),1,"P20 is still reachable");
});

test("E: all-censored and empty samples yield Not estimable rather than zero",()=>{
 const allCensored=[{timeDays:3,observed:false},{timeDays:9,observed:false}];
 assert.deepEqual(quantiles(allCensored,[0.2,0.5,0.8,0.9]),[null,null,null,null]);
 assert.deepEqual(kaplanMeier([]),[]);
 assert.deepEqual(quantiles([],[0.5]),[null]);
});

test("E: non-finite and negative times are excluded rather than coerced",()=>{
 const summary=riskSummary([{timeDays:Number.NaN,observed:true},{timeDays:-1,observed:true},{timeDays:2,observed:true},{timeDays:4,observed:false}]);
 assert.deepEqual(summary,{effectiveN:2,observed:1,censored:1});
});

test("E: an invalid percentile request is not estimable",()=>{
 const curve=kaplanMeier([{timeDays:1,observed:true}]);
 assert.equal(kaplanMeierQuantile(curve,0),null);
 assert.equal(kaplanMeierQuantile(curve,1),null);
});

test("observed conditional percentiles interpolate and never coerce missing to zero",()=>{
 // Known sample: linear interpolation between order statistics.
 assert.deepEqual(observedPercentiles([1,2,3,4,5],[0.5]),[3]);
 assert.deepEqual(observedPercentiles([10,20],[0.5]),[15]);
 assert.deepEqual(observedPercentiles([],[0.2,0.5,0.9]),[null,null,null]);
 // A single observation is that value, not zero and not a distribution.
 assert.deepEqual(observedPercentiles([7],[0.2,0.9]),[7,7]);
 assert.deepEqual(observedPercentiles([1,2],[0,1]),[null,null],"degenerate p is not estimable");
});

test("five-number summary supports small-sample box rendering",()=>{
 assert.equal(fiveNumber([]),null);
 const s=fiveNumber([4,1,3,2])!;
 assert.deepEqual([s.min,s.median,s.max,s.n],[1,2.5,4,4]);
 assert.ok(s.q1<s.median&&s.median<s.q3);
});
