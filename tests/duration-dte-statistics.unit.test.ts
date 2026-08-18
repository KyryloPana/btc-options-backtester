import test from "node:test";
import assert from "node:assert/strict";
import {coverageFromSurvival,share} from "../app/lib/duration-dte/statistics.ts";
import {kaplanMeier} from "../app/lib/underlying-resolution/statistics.ts";

test("coverage is 1 - survival, with bounds swapped, off the SAME KM curve",()=>{
 const curve=kaplanMeier([1,2,3,4,5].map(timeDays=>({timeDays,observed:true})));
 const coverage=coverageFromSurvival(curve);
 assert.equal(coverage.length,curve.length);
 for(let i=0;i<curve.length;i++){
  assert.ok(Math.abs(coverage[i]!.coverage-(1-curve[i]!.survival))<1e-12);
  if(curve[i]!.lower===null)assert.equal(coverage[i]!.upper,null);
  else assert.ok(Math.abs(coverage[i]!.upper!-(1-curve[i]!.lower!))<1e-12);
  if(curve[i]!.upper===null)assert.equal(coverage[i]!.lower,null);
  else assert.ok(Math.abs(coverage[i]!.lower!-(1-curve[i]!.upper!))<1e-12);
 }
});

test("coverage of an all-censored curve stays at 0%, never fabricated",()=>{
 const curve=kaplanMeier([{timeDays:5,observed:false},{timeDays:9,observed:false}]);
 const coverage=coverageFromSurvival(curve);
 assert.ok(coverage.length>=2);
 for(const p of coverage)assert.equal(p.coverage,0);
});

test("share is null for a zero denominator, never a fabricated 0 or division error",()=>{
 assert.equal(share(0,0),null);
 assert.equal(share(3,0),null);
 assert.equal(share(1,4),0.25);
 assert.equal(share(0,4),0);
});
