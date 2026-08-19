"use client";
import {useCallback,useState} from "react";
import {positionInPlot,type PlotGeometry,type PlotPosition} from "../lib/chart-interaction";

/**
 * Shared cursor/crosshair primitives for Research Analytics charts.
 *
 * Every interactive chart in the reports draws its crosshair and readout
 * through these, so a future report inherits the same interaction language
 * without reimplementing pointer maths, hit testing or tooltip styling. The
 * arithmetic itself lives in lib/chart-interaction.ts and is unit-tested
 * separately; this file is only the React and SVG surface.
 *
 * Styling comes entirely from the Kyron token set already in globals.css --
 * no colours are declared here.
 */

export interface ChartCursor {
 readonly position:PlotPosition|null;
 /** Spread onto the <svg> element. Pointer-only; it never captures scroll or clicks. */
 readonly handlers:{
  onPointerMove:(event:React.PointerEvent<SVGSVGElement>)=>void;
  onPointerLeave:()=>void;
 };
 readonly clear:()=>void;
}

/**
 * Tracks the pointer inside a chart's plot area.
 *
 * Only pointermove and pointerleave are bound: scrolling, clicking and text
 * selection are all left alone, so adding inspection to a chart cannot change
 * how the page behaves around it.
 */
export function useChartCursor(geometry:PlotGeometry):ChartCursor{
 const [position,setPosition]=useState<PlotPosition|null>(null);
 const onPointerMove=useCallback((event:React.PointerEvent<SVGSVGElement>)=>{
  const rect=event.currentTarget.getBoundingClientRect();
  setPosition(positionInPlot(geometry,event.clientX,event.clientY,rect));
 },[geometry]);
 const clear=useCallback(()=>setPosition(null),[]);
 return {position,handlers:{onPointerMove,onPointerLeave:clear},clear};
}

/**
 * Hairlines marking the inspected position, clipped to the plot area so they
 * never run out over the axis labels.
 */
export function ChartCrosshair({geometry,px,py,vertical=true,horizontal=true}:{
 geometry:PlotGeometry;px:number;py:number;vertical?:boolean;horizontal?:boolean;
}){
 return <g className="chart-crosshair" pointerEvents="none">
  {vertical&&<line x1={px} x2={px} y1={geometry.top} y2={geometry.height-geometry.bottom}/>}
  {horizontal&&<line x1={geometry.left} x2={geometry.width-geometry.right} y1={py} y2={py}/>}
 </g>;
}

/** A marker sitting on the inspected observation itself. */
export function ChartMarker({px,py,r=3.5}:{px:number;py:number;r?:number}){
 return <circle className="chart-cursor-dot" cx={px} cy={py} r={r} pointerEvents="none"/>;
}

export interface ReadoutLine {readonly label:string;readonly value:string;readonly tone?:"positive"|"negative"|"muted"}

/**
 * The value readout, anchored beside the cursor and flipped to the other side
 * when it would otherwise overflow the plot. Sized from the content rather
 * than a fixed box so a short reading does not draw a large empty card.
 */
export function ChartReadout({geometry,px,py,title,lines}:{
 geometry:PlotGeometry;px:number;py:number;title?:string;lines:readonly ReadoutLine[];
}){
 const longest=Math.max(title?title.length:0,...lines.map(l=>l.label.length+l.value.length+3));
 const width=Math.min(Math.max(112,longest*6.1+22),260);
 const height=(title?17:0)+lines.length*15+14;
 const flipX=px+width+14>geometry.width-geometry.right;
 const x=flipX?px-width-10:px+10;
 const y=Math.min(Math.max(geometry.top,py-height/2),geometry.height-geometry.bottom-height);
 return <foreignObject className="chart-readout-object" x={x} y={y} width={width} height={height} pointerEvents="none">
  <div className="chart-readout" role="tooltip">
   {title&&<strong>{title}</strong>}
   {lines.map(line=><span key={line.label} className={line.tone?`chart-readout-${line.tone}`:undefined}>
    <small>{line.label}</small><b>{line.value}</b>
   </span>)}
  </div>
 </foreignObject>;
}

/**
 * Axis-edge tick showing the raw cursor coordinate, the way the reference
 * engine labels its price and time axes while the pointer moves.
 */
export function ChartAxisTag({geometry,px,text}:{geometry:PlotGeometry;px:number;text:string}){
 const width=Math.max(30,text.length*6+10);
 const x=Math.min(Math.max(geometry.left,px-width/2),geometry.width-geometry.right-width);
 return <foreignObject className="chart-readout-object" x={x} y={geometry.height-geometry.bottom+4} width={width} height={18} pointerEvents="none">
  <div className="chart-axis-tag">{text}</div>
 </foreignObject>;
}
