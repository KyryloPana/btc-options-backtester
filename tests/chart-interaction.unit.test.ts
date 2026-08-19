import test from "node:test";
import assert from "node:assert/strict";
import {
 binAt,formatPercent,formatValue,nearestByX,nearestInPlot,positionInPlot,stepValueAt,
 type PlotGeometry,
} from "../app/lib/chart-interaction.ts";

const geometry:PlotGeometry={
 width:100,height:100,left:10,right:10,top:10,bottom:10,
 xRange:{min:0,max:80},yRange:{min:0,max:1},
};
const rect={left:0,top:0,width:100,height:100};

test("DISCRETE: nearest-by-x only ever returns an observation that exists",()=>{
 const points=[{x:0,y:1},{x:5,y:.8},{x:12,y:.5}];
 assert.deepEqual(nearestByX(points,4.9),{x:5,y:.8});
 assert.deepEqual(nearestByX(points,11),{x:12,y:.5});
 // A cursor between two observations snaps to one of them; it never reports
 // the interpolated 0.65 that would sit halfway up the segment.
 const mid=nearestByX(points,8.5)!;
 assert.ok(points.includes(mid));
 assert.ok(mid.y===.8||mid.y===.5);
});

test("DISCRETE: ties resolve to the earlier point, so hovering is deterministic",()=>{
 const points=[{x:0,y:1},{x:10,y:2}];
 assert.deepEqual(nearestByX(points,5),{x:0,y:1});
});

test("DISCRETE: an empty series reads as nothing, never a fabricated origin",()=>{
 assert.equal(nearestByX([],3),null);
 assert.equal(nearestInPlot([],3,4,{min:0,max:1},{min:0,max:1}),null);
});

test("DISCRETE: a one-point series always reads that point",()=>{
 const only=[{x:7,y:.25}];
 assert.deepEqual(nearestByX(only,-100),{x:7,y:.25});
 assert.deepEqual(nearestByX(only,1e6),{x:7,y:.25});
});

test("DISCRETE: non-finite observations are skipped rather than matched",()=>{
 const points=[{x:Number.NaN,y:1},{x:4,y:2}];
 assert.deepEqual(nearestByX(points,Number.NaN===Number.NaN?0:0),{x:4,y:2});
 assert.deepEqual(nearestInPlot([{x:1,y:Number.NaN},{x:9,y:3}],1,3,{min:0,max:10},{min:0,max:10}),{x:9,y:3});
});

test("SCATTER: 2-D matching normalises the axes so neither scale dominates",()=>{
 // x spans days (0-10), y spans dollars (0-10000). Raw euclidean distance would
 // let y decide every match; normalised, the near-in-x point wins.
 const points=[{x:1,y:9000},{x:9,y:5200}];
 const near=nearestInPlot(points,1.5,5000,{min:0,max:10},{min:0,max:10000})!;
 assert.equal(near.x,1);
});

test("SCATTER: a zero-width axis contributes nothing instead of dividing by zero",()=>{
 const points=[{x:5,y:1},{x:5,y:9}];
 const near=nearestInPlot(points,5,8.6,{min:5,max:5},{min:0,max:10})!;
 assert.equal(near.y,9);
});

test("ESTIMATOR: a step curve reads its defined value between event times",()=>{
 const curve=[{x:0,y:1},{x:4,y:.75},{x:9,y:.5}];
 // Between t=4 and t=9 the estimator legitimately holds .75 -- this is the
 // step's own value, not an interpolation toward .5.
 const reading=stepValueAt(curve,6.2)!;
 assert.equal(reading.y,.75);
 assert.equal(reading.point.x,4);
 assert.equal(reading.withinStep,true);
 // Exactly on an event time the curve is right-continuous: the new value.
 const atEvent=stepValueAt(curve,9)!;
 assert.equal(atEvent.y,.5);
 assert.equal(atEvent.withinStep,false);
});

test("ESTIMATOR: before the curve begins the value is undefined, never guessed",()=>{
 assert.equal(stepValueAt([{x:3,y:1}],1),null);
 assert.equal(stepValueAt([],5),null);
});

test("ESTIMATOR: the step lookup never interpolates toward the next point",()=>{
 const curve=[{x:0,y:1},{x:10,y:0}];
 for(const t of [0.1,2,5,7.5,9.99])assert.equal(stepValueAt(curve,t)!.y,1,`S(${t}) must hold 1, not decay toward 0`);
});

test("HISTOGRAM: bins are half-open except the last, which is closed at its top edge",()=>{
 const bins=[{lo:0,hi:5},{lo:5,hi:10},{lo:10,hi:15}];
 assert.equal(binAt(bins,0),0);
 assert.equal(binAt(bins,5),1,"a value on an internal edge belongs to the upper bin");
 assert.equal(binAt(bins,15),2,"the maximum observation stays inside the chart");
 assert.equal(binAt(bins,-1),null);
 assert.equal(binAt(bins,15.1),null);
 assert.equal(binAt([],3),null);
});

test("HIT TEST: pointer pixels map into data space, and axis margins are outside the plot",()=>{
 // Centre of the plot area: halfway along both axes.
 const middle=positionInPlot(geometry,50,50,rect)!;
 assert.ok(Math.abs(middle.x-40)<1e-9);
 assert.ok(Math.abs(middle.y-0.5)<1e-9);
 // Left edge of the plot is the x minimum; y is inverted (SVG grows downward).
 const topLeft=positionInPlot(geometry,10,10,rect)!;
 assert.ok(Math.abs(topLeft.x-0)<1e-9);
 assert.ok(Math.abs(topLeft.y-1)<1e-9);
 // Over the axis gutters there is no reading at all.
 assert.equal(positionInPlot(geometry,4,50,rect),null,"left gutter");
 assert.equal(positionInPlot(geometry,50,96,rect),null,"bottom gutter");
 assert.equal(positionInPlot(geometry,50,50,{...rect,width:0}),null,"unlaid-out element");
});

test("HIT TEST: a scaled element still maps correctly, since pointer pixels go through the viewBox",()=>{
 const scaled=positionInPlot(geometry,100,100,{left:0,top:0,width:200,height:200})!;
 assert.ok(Math.abs(scaled.x-40)<1e-9,"same data point as the unscaled centre");
 assert.ok(Math.abs(scaled.y-0.5)<1e-9);
});

test("FORMAT: missing values read as an em dash, never as zero",()=>{
 assert.equal(formatValue(null),"—");
 assert.equal(formatValue(undefined),"—");
 assert.equal(formatValue(Number.NaN),"—");
 assert.equal(formatPercent(null),"—");
 assert.equal(formatValue(0),"0.0","a genuine zero is still a zero");
 assert.equal(formatValue(3.14159,"d"),"3.1d");
 assert.equal(formatPercent(0.5),"50.0%");
});
