/**
 * Shared cursor-inspection maths for Research Analytics charts.
 *
 * Deliberately pure and free of React or SVG: every report's chart reads its
 * values through these functions, so hover behaviour cannot drift between
 * reports and can be tested without rendering anything.
 *
 * THE CENTRAL DISTINCTION, and the reason there are two lookup functions
 * rather than one:
 *
 *  - `nearestByX` / `nearestInPlot` inspect OBSERVED DISCRETE DATA. They only
 *    ever return a point that genuinely exists in the dataset. A cursor
 *    between two observations snaps to the nearer one; it never reports an
 *    interpolated value, because no such market observation was recorded.
 *  - `stepValueAt` inspects a CONTINUOUS STATISTICAL ESTIMATOR defined for
 *    every t -- a Kaplan-Meier survival curve or the coverage curve derived
 *    from it. Reading S(t) strictly between two event times is legitimate:
 *    the estimator holds its previous value there by definition. This is a
 *    step lookup, never a linear interpolation between the two points.
 *
 * Mixing those two up is how a chart starts implying market data that was
 * never observed, so the callers pick explicitly.
 */

export interface ChartPoint {readonly x:number;readonly y:number}

/** Inclusive numeric span of one axis, used to normalise 2-D distance. */
export interface AxisRange {readonly min:number;readonly max:number}

/**
 * The observed point nearest `x`, for discrete series. Ties resolve to the
 * earlier point so repeated hovering is deterministic. Returns null for an
 * empty series rather than a fabricated origin.
 */
export function nearestByX<T extends ChartPoint>(points:readonly T[],x:number):T|null{
 let best:T|null=null,bestDistance=Infinity;
 for(const point of points){
  if(!Number.isFinite(point.x))continue;
  const distance=Math.abs(point.x-x);
  if(distance<bestDistance){best=point;bestDistance=distance}
 }
 return best;
}

/**
 * The observed point nearest the cursor in two dimensions, for scatter plots.
 *
 * Distance is measured in NORMALISED axis units: a chart whose x axis spans
 * days and whose y axis spans dollars would otherwise let whichever axis has
 * the larger raw numbers decide every match, which feels wrong under the
 * cursor. A zero-width axis contributes nothing instead of dividing by zero.
 */
export function nearestInPlot<T extends ChartPoint>(points:readonly T[],x:number,y:number,xRange:AxisRange,yRange:AxisRange):T|null{
 const xSpan=xRange.max-xRange.min,ySpan=yRange.max-yRange.min;
 let best:T|null=null,bestDistance=Infinity;
 for(const point of points){
  if(!Number.isFinite(point.x)||!Number.isFinite(point.y))continue;
  const dx=xSpan>0?(point.x-x)/xSpan:0,dy=ySpan>0?(point.y-y)/ySpan:0;
  const distance=dx*dx+dy*dy;
  if(distance<bestDistance){best=point;bestDistance=distance}
 }
 return best;
}

export interface StepReading<T> {
 /** The step the estimator is currently sitting on. */
 readonly point:T;
 /** The estimator's value at the queried t -- the step's own value, never interpolated. */
 readonly y:number;
 /** True when t falls strictly after the step's own x, i.e. inside the flat run. */
 readonly withinStep:boolean;
}

/**
 * Value of a right-continuous step estimator at `t`: the most recent point at
 * or before t. Before the curve begins the estimator is undefined here and the
 * function returns null rather than guessing an initial value -- callers that
 * know their estimator starts at 1 can say so themselves.
 *
 * `curve` must be sorted ascending by x; the Kaplan-Meier and coverage curves
 * both are, by construction.
 */
export function stepValueAt<T extends ChartPoint>(curve:readonly T[],t:number):StepReading<T>|null{
 let found:T|null=null;
 for(const point of curve){
  if(!Number.isFinite(point.x))continue;
  if(point.x<=t)found=point;else break;
 }
 return found===null?null:{point:found,y:found.y,withinStep:t>found.x};
}

export interface HistogramBin {readonly lo:number;readonly hi:number}

/**
 * Index of the bin containing `x`, with the last bin closed at its upper edge
 * so the maximum observation lands inside the chart rather than outside it.
 * Returns null when x falls outside the histogram entirely.
 */
export function binAt(bins:readonly HistogramBin[],x:number):number|null{
 for(const [index,bin] of bins.entries()){
  const last=index===bins.length-1;
  if(x>=bin.lo&&(last?x<=bin.hi:x<bin.hi))return index;
 }
 return null;
}

/**
 * Maps a pointer position within an SVG element to that chart's data space.
 *
 * The plot area is described by the same margin constants the chart draws
 * with, so the hit test and the rendering can never disagree. Returns null
 * when the pointer is outside the plot area, which is what stops a readout
 * appearing while the cursor is over an axis label.
 */
export interface PlotGeometry {
 readonly width:number;readonly height:number;
 readonly left:number;readonly right:number;readonly top:number;readonly bottom:number;
 readonly xRange:AxisRange;readonly yRange:AxisRange;
}

export interface PlotPosition {readonly x:number;readonly y:number;readonly px:number;readonly py:number}

export function positionInPlot(geometry:PlotGeometry,clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number}):PlotPosition|null{
 if(rect.width<=0||rect.height<=0)return null;
 // The SVG scales to its box, so pointer pixels convert through the viewBox.
 const px=(clientX-rect.left)/rect.width*geometry.width;
 const py=(clientY-rect.top)/rect.height*geometry.height;
 const plotWidth=geometry.width-geometry.left-geometry.right;
 const plotHeight=geometry.height-geometry.top-geometry.bottom;
 if(plotWidth<=0||plotHeight<=0)return null;
 if(px<geometry.left||px>geometry.width-geometry.right)return null;
 if(py<geometry.top||py>geometry.height-geometry.bottom)return null;
 const x=geometry.xRange.min+(px-geometry.left)/plotWidth*(geometry.xRange.max-geometry.xRange.min);
 const y=geometry.yRange.max-(py-geometry.top)/plotHeight*(geometry.yRange.max-geometry.yRange.min);
 return {x,y,px,py};
}

/** Compact, tabular-friendly number formatting shared by every chart readout. */
export function formatValue(value:number|null|undefined,unit?:string,digits=1):string{
 if(value===null||value===undefined||!Number.isFinite(value))return "—";
 const text=Math.abs(value)>=1000
  ?value.toLocaleString(undefined,{maximumFractionDigits:0})
  :value.toFixed(digits);
 return unit?`${text}${unit}`:text;
}

export function formatPercent(value:number|null|undefined,digits=1):string{
 return value===null||value===undefined||!Number.isFinite(value)?"—":`${(value*100).toFixed(digits)}%`;
}
