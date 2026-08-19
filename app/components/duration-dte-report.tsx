"use client";
import {useState} from "react";
import type {
 CaptureThresholdRow,DteBufferRow,DurationDteReport,HoldingPeriodRow,OutcomeBeforeExpiryRow,OverviewRow,
 PnlByOutcomeRow,SynchronizationRow,
} from "../lib/duration-dte/report";
import type {DteCandidate,OutcomeBeforeExpiry,ScenarioCoverage} from "../lib/duration-dte/normalize";

/**
 * Presentation only. Every number comes from the prebuilt Duration & DTE view
 * model; this file performs no analysis, and event-table pagination cannot
 * reach any statistic above it.
 */

/** Maker and taker are scenarios of one structure; Compare shows them matched, never pooled. */
export type ExecutionView="maker"|"taker"|"compare";

const PAGE_SIZE=10;
const NOT_ESTIMABLE="Not estimable";
const UNAVAILABLE="Unavailable";
const NOT_EVALUATED="Not evaluated";

const d1=(x:number)=>x.toFixed(1);
const days=(x:number|null)=>x===null?NOT_ESTIMABLE:`${d1(x)}d`;
const usd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":""}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const pct=(x:number|null)=>x===null?NOT_ESTIMABLE:`${(x*100).toFixed(1)}%`;
const signedUsd=(x:number|null)=>x===null?UNAVAILABLE:`${x<0?"−":"+"}$${Math.abs(x).toLocaleString(undefined,{maximumFractionDigits:0})}`;
const signedDays=(x:number|null)=>x===null?NOT_ESTIMABLE:`${x<0?"−":"+"}${Math.abs(x).toFixed(1)}d`;

const OUTCOME_LABEL:Record<OutcomeBeforeExpiry,string>={
 vpoc_before_expiry:"VPOC before expiry",
 invalidation_before_expiry:"Invalidation before expiry",
 ambiguous_before_expiry:"Ambiguous before expiry",
 no_resolution_before_expiry:"No resolution before expiry",
 vpoc_before_structure_entry:"VPOC already reached before structure entry",
};
const OUTCOME_TONE:Record<OutcomeBeforeExpiry,string>={
 vpoc_before_expiry:"positive",invalidation_before_expiry:"negative",ambiguous_before_expiry:"warn",
 no_resolution_before_expiry:"warn",vpoc_before_structure_entry:"muted",
};
const OUTCOME_ORDER=Object.keys(OUTCOME_LABEL) as OutcomeBeforeExpiry[];

/**
 * Renders the three genuinely distinct coverage states without ever collapsing
 * them: a real percentage, "Unavailable" (assessed, no supporting evidence) and
 * "Not evaluated" (never assessed) are visually and textually different.
 */
function Coverage({coverage}:{coverage:ScenarioCoverage}){
 if(coverage.status==="measured")return <span title={`${coverage.events} of ${coverage.eligibleEvents} eligible MR events`}>{pct(coverage.share)}</span>;
 return <span className="dd-muted" title={coverage.reason??undefined}>{coverage.status==="unavailable"?UNAVAILABLE:NOT_EVALUATED}</span>;
}

function HeadlineCard({label,value,detail,title}:{label:string;value:React.ReactNode;detail?:string;title?:string}){
 return <div className="dd-card" title={title}><span className="dd-label">{label}</span><strong>{value}</strong>{detail&&<small className="dd-muted">{detail}</small>}</div>;
}

/* ---------- 1. DTE overview ---------- */

function OverviewTable({rows}:{rows:readonly OverviewRow[]}){
 return <div className="table-scroll"><table className="dd-table">
  <thead><tr><th>Horizon</th><th>Actual DTE (median / range)</th><th>Events</th><th>Structures</th><th>Not evaluated</th><th>Priced</th><th>Taker exec.</th><th>Maker opp.</th><th>Res. coverage</th><th>No res. before expiry</th><th>Median buffer</th><th>Median T50%</th><th>Capital-day return</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.horizon.nominalDays}>
   <td>{r.horizon.label}{r.horizon.eligibleDteRange&&<small className="dd-muted"> ({r.horizon.eligibleDteRange.min}–{r.horizon.eligibleDteRange.max}d)</small>}</td>
   <td>{r.actualDte?`${d1(r.actualDte.median)}d (${d1(r.actualDte.min)}–${d1(r.actualDte.max)}d)`:NOT_ESTIMABLE}</td>
   <td title="One MR event is one observation per horizon, however many width/strike variants it generated.">{r.eventsN}</td>
   <td className="dd-muted">{r.structuresN}</td>
   <td className={r.notEvaluatedN>0?"dd-muted":undefined}>{r.notEvaluatedN}</td>
   <td>{pct(r.pricedShare)}</td>
   <td><Coverage coverage={r.taker}/></td>
   <td><Coverage coverage={r.maker}/></td>
   <td className={r.resolutionCoverageShare===null?"dd-muted":"positive"}>{pct(r.resolutionCoverageShare)}</td>
   <td className={r.noResolutionBeforeExpiryShare===null?"dd-muted":"negative"}>{pct(r.noResolutionBeforeExpiryShare)}</td>
   <td>{days(r.medianDteBufferDays)}</td>
   <td>{days(r.medianTimeToCapture50Days)}</td>
   <td>{r.medianCapitalDayReturn===null?UNAVAILABLE:r.medianCapitalDayReturn.toFixed(3)}</td>
  </tr>)}</tbody>
 </table>
 <small className="dd-note">Events, actual DTE, resolution coverage and DTE buffer are execution-independent and do not change with the selected scenario. Taker/maker coverage, T50% capture and capital-day return are execution-dependent.</small>
 </div>;
}

/* ---------- 2. Availability & executability ---------- */

function CoverageFunnel({report}:{report:DurationDteReport}){
 return <div className="dd-funnel">{report.availability.map(a=><div key={a.nominalDays} className="dd-funnel-row">
  <span>{a.label}</span>
  <div className="dd-funnel-bars">
   {([["Eligible events",a.eligibleEvents],["Priced",a.priced],["Selected",a.selected]] as const).map(([label,n])=>
    <div key={label} className="dd-funnel-bar"><small>{label}</small><div className="dd-funnel-track"><i style={{width:`${a.eligibleEvents>0?n/a.eligibleEvents*100:0}%`}}/></div><em>{n} · {pct(a.eligibleEvents>0?n/a.eligibleEvents:null)}</em></div>)}
   {([["Taker exec.",a.taker],["Maker opp.",a.maker]] as const).map(([label,coverage])=>
    <div key={label} className="dd-funnel-bar"><small>{label}</small><div className="dd-funnel-track"><i style={{width:`${(coverage.share??0)*100}%`}}/></div><em>{coverage.status==="measured"?`${coverage.events} · ${pct(coverage.share)}`:<span className="dd-muted" title={coverage.reason??undefined}>{coverage.status==="unavailable"?UNAVAILABLE:NOT_EVALUATED}</span>}</em></div>)}
  </div>
 </div>)}
 <small className="dd-note">Every stage counts DISTINCT MR EVENTS, so an event that generated six width variants is still one observation. &ldquo;Priced&rdquo; collapses the canonical bundle&rsquo;s single per-candidate availability status; eligible-expiry and both-legs-available are not separately recorded. Maker opportunity is never confirmed execution.</small>
</div>;
}

function EntryQualityBars({report}:{report:DurationDteReport}){
 return <div className="dd-quality">{report.availability.map(a=>{
  const total=a.entryQuality.green+a.entryQuality.yellow+a.entryQuality.red+a.entryQuality.unavailable;
  return <div key={a.nominalDays} className="dd-quality-row"><span>{a.label}</span>
   <div className="dd-quality-bar">
    {(["green","yellow","red","unavailable"] as const).map(k=>total>0&&a.entryQuality[k]>0?<i key={k} className={`dd-q-${k}`} style={{width:`${a.entryQuality[k]/total*100}%`}} title={`${k}: ${a.entryQuality[k]}`}/>:null)}
   </div>
   <em>{total?`${a.entryQuality.green}G / ${a.entryQuality.yellow}Y / ${a.entryQuality.red}R`:NOT_ESTIMABLE}</em>
  </div>;
 })}</div>;
}

function SynchronizationTable({rows,scenario}:{rows:readonly SynchronizationRow[];scenario:string}){
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>Median sync (min)</th><th>P95 sync (min)</th><th>N</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.horizon.nominalDays}>
   <td>{r.horizon.label}</td>
   <td>{r.medianMinutes===null?NOT_ESTIMABLE:`${r.medianMinutes.toFixed(2)}m`}</td>
   <td>{r.p95Minutes===null?NOT_ESTIMABLE:`${r.p95Minutes.toFixed(2)}m`}</td>
   <td>{r.n}</td>
  </tr>)}</tbody>
 </table>
 <small className="dd-note">Median and P95 leg-synchronization gap for the {scenario} scenario only — maker and taker draw on different tape prints, so their gaps are reported separately rather than pooled.</small>
 </div>;
}

/* ---------- 3. Thesis survival vs actual DTE (centrepiece) ---------- */

const W=880,H=300,ML=54,MR=18,MT=16,MB=42;

function CoverageChart({report}:{report:DurationDteReport}){
 const curve=report.coverageCurve;
 if(curve.length<2)return <div className="dd-empty">{NOT_ESTIMABLE} — no eligible events with a usable observation window.</div>;
 const maxT=Math.max(...curve.map(p=>p.timeDays),...report.horizons.flatMap(h=>h.eligibleDteRange?[h.eligibleDteRange.max]:[]))||1;
 const px=(t:number)=>ML+t/maxT*(W-ML-MR),py=(c:number)=>MT+(1-c)*(H-MT-MB);
 let path=`M ${px(0)} ${py(0)}`,prev=0;
 for(const point of curve.slice(1)){path+=` L ${px(point.timeDays)} ${py(prev)} L ${px(point.timeDays)} ${py(point.coverage)}`;prev=point.coverage}
 path+=` L ${px(maxT)} ${py(prev)}`;
 const banded=curve.filter(p=>p.lower!==null&&p.upper!==null);
 const band=banded.length>1?"M "+banded.map(p=>`${px(p.timeDays)} ${py(p.upper!)}`).join(" L ")+" L "+[...banded].reverse().map(p=>`${px(p.timeDays)} ${py(p.lower!)}`).join(" L ")+" Z":"";
 const yTicks=[0,0.25,0.5,0.75,1],xTicks=Array.from({length:5},(_,i)=>maxT*i/4);
 return <>
  <figure className="dd-chart">
   <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MR first-resolution coverage versus actual DTE">
    {report.horizons.map(h=>h.eligibleDteRange&&<rect key={h.nominalDays} className="dd-band-ref" x={px(h.eligibleDteRange.min)} width={Math.max(px(h.eligibleDteRange.max)-px(h.eligibleDteRange.min),1)} y={MT} height={H-MT-MB}>
     <title>{`${h.label} eligible DTE ${h.eligibleDteRange.min}–${h.eligibleDteRange.max}d`}</title>
    </rect>)}
    {yTicks.map(t=><g key={t}><line className="dd-grid" x1={ML} x2={W-MR} y1={py(t)} y2={py(t)}/><text className="dd-tick" x={ML-9} y={py(t)+4} textAnchor="end">{(t*100).toFixed(0)}%</text></g>)}
    {xTicks.map(t=><text key={t} className="dd-tick" x={px(t)} y={H-MB+20} textAnchor="middle">{d1(t)}</text>)}
    {band&&<path className="dd-band" d={band}/>}
    <path className="dd-curve" d={path}/>
    {curve.slice(1).map(p=><circle key={p.timeDays} className="dd-step-dot" cx={px(p.timeDays)} cy={py(p.coverage)} r={3}><title>{`DTE=${d1(p.timeDays)}d · coverage=${(p.coverage*100).toFixed(1)}%`}</title></circle>)}
    <line className="dd-axis" x1={ML} x2={ML} y1={MT} y2={H-MB}/>
    <line className="dd-axis" x1={ML} x2={W-MR} y1={H-MB} y2={H-MB}/>
    <text className="dd-axis-label" x={W/2} y={H-6} textAnchor="middle">Actual DTE (days)</text>
   </svg>
  </figure>
  <div className="dd-legend">{report.horizons.map(h=><span key={h.nominalDays} className="dd-band-swatch">{h.label}{h.eligibleDteRange&&` (${h.eligibleDteRange.min}–${h.eligibleDteRange.max}d)`}</span>)}</div>
  <small className="dd-note">Same Kaplan-Meier curve as Underlying Resolution, relabelled as coverage = 1 − S(t). Shaded regions are each horizon family&rsquo;s configured eligible DTE range, shown for reference only.</small>
 </>;
}

/* ---------- 4. Outcome before expiry ---------- */

function OutcomeBeforeExpiryBars({rows}:{rows:readonly OutcomeBeforeExpiryRow[]}){
 return <div className="dd-stacked">{rows.map(r=><div key={r.horizon.nominalDays} className="dd-stacked-row"><span>{r.horizon.label}</span>
  <div className="dd-stacked-bar">{OUTCOME_ORDER.map(k=>r.counts[k]>0&&r.determinateN>0?
   <i key={k} className={`dd-o-${k}`} style={{width:`${r.counts[k]/r.determinateN*100}%`}} title={k==="no_resolution_before_expiry"
    ?`${OUTCOME_LABEL[k]}: ${r.counts[k]} — ${r.noResolutionDetail.resolved_later} resolved later, ${r.noResolutionDetail.still_unresolved} still unresolved`
    :`${OUTCOME_LABEL[k]}: ${r.counts[k]}`}/>:null)}</div>
  <em>n={r.determinateN}
   {r.counts.no_resolution_before_expiry>0&&<small className="dd-muted"> · no-res: {r.noResolutionDetail.resolved_later} later / {r.noResolutionDetail.still_unresolved} censored</small>}
   {r.notDeterminableN>0&&<small className="dd-muted"> · {r.notDeterminableN} not determinable</small>}</em>
 </div>)}
 <div className="dd-legend">{OUTCOME_ORDER.map(k=><span key={k} className={`dd-legend-${OUTCOME_TONE[k]}`}>{OUTCOME_LABEL[k]}</span>)}</div>
 <small className="dd-note">Buckets are candidate-relative: they describe what happened while the structure existed, never the event&rsquo;s eventual outcome. &ldquo;No resolution before expiry&rdquo; stays one category because both cases mean the option did not survive long enough to observe resolution, but it is split internally into resolved-later and still-censored, shown above and on hover.</small>
 </div>;
}

/* ---------- 5. DTE buffer ---------- */

function BufferStrip({rows}:{rows:readonly DteBufferRow[]}){
 const all=rows.flatMap(r=>r.values);
 if(!all.length)return <div className="dd-empty">No structure has a post-entry resolution and a known expiry, so no buffer can be measured.</div>;
 const max=Math.max(...all.map(Math.abs))||1;
 const x=(v:number)=>50+v/(max*1.1)*50;
 return <div className="dd-strips">
  <div className="dd-strip-zero" style={{left:"50%"}}/>
  {rows.map(r=>{
   if(!r.summary)return <div key={r.horizon.nominalDays} className="dd-strip-row"><span>{r.horizon.label}</span><em className="dd-muted">No post-entry resolution</em></div>;
   const box=r.summary.n>=4;
   return <div key={r.horizon.nominalDays} className="dd-strip-row"><span>{r.horizon.label}</span>
    <div className="dd-strip">
     {box&&<i className="ur-iqr" style={{left:`${x(r.summary.q1)}%`,width:`${Math.max(x(r.summary.q3)-x(r.summary.q1),0.5)}%`}}/>}
     {r.values.map((v,i)=><i key={i} className={`dd-obs${v<0?" negative-dot":""}`} style={{left:`${x(v)}%`}} title={`${d1(v)}d buffer`}/>)}
     <i className="ur-median" style={{left:`${x(r.summary.median)}%`}} title={`median ${d1(r.summary.median)}d`}/>
    </div>
    <em>median {days(r.summary.median)} · n={r.summary.n}</em>
   </div>;
  })}
  <small className="dd-note">Positive = time remaining after the post-entry resolution. Negative = the thesis resolved after this structure&rsquo;s expiry. A resolution that occurred before the structure was entered never contributes a buffer. Axis spans ±{d1(max*1.1)} days.</small>
 </div>;
}

/* ---------- 6. Credit capture ---------- */

function CaptureSection({report}:{report:DurationDteReport}){
 const [threshold,setThreshold]=useState<25|50|70>(50);
 const rows=report.captureByThreshold[threshold];
 return <>
  <div className="dd-tabs" role="tablist">{([25,50,70] as const).map(t=><button key={t} role="tab" aria-selected={t===threshold} className={t===threshold?"dd-tab-active":undefined} onClick={()=>setThreshold(t)}>{t}%</button>)}</div>
  <div className="table-scroll"><table className="dd-table dd-compact">
   <thead><tr><th>Horizon</th><th>Reached</th><th>Median time to capture</th><th>Before VPOC</th><th>Before invalidation</th></tr></thead>
   <tbody>{rows.map((r:CaptureThresholdRow)=>
    <tr key={r.horizon.nominalDays}><td>{r.horizon.label}</td>
     <td>{r.totalN?`${r.reachedN} / ${r.totalN} (${(r.reachedN/r.totalN*100).toFixed(0)}%)`:NOT_ESTIMABLE}</td>
     <td>{days(r.medianTimeToCaptureDays)}</td><td>{pct(r.beforeVpocShare)}</td><td>{pct(r.beforeInvalidationShare)}</td>
    </tr>)}</tbody>
  </table></div>
  <small className="dd-note">Capture timestamps use canonical valuation/outcome evidence for the selected execution scenario only; a threshold never reached leaves its time Not estimable, never zero.</small>
 </>;
}

/* ---------- 7. PnL by candidate-relative outcome ---------- */

function PnlSection({rows}:{rows:readonly PnlByOutcomeRow[]}){
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>Bucket</th><th>N</th><th>Median PnL</th><th>Median worst adverse</th><th>Median MAE before profit</th></tr></thead>
  <tbody>{rows.flatMap(r=>r.buckets.filter(b=>b.n>0).map(b=>
   <tr key={`${r.horizon.nominalDays}-${b.outcome}`}><td>{r.horizon.label}</td>
    <td title={b.note??undefined}>{b.label}{b.note&&<small className="dd-muted"> ⓘ</small>}</td>
    <td>{b.n}</td>
    <td className={b.medianPnlUsd===null?"dd-muted":b.medianPnlUsd>=0?"positive":"negative"}>{usd(b.medianPnlUsd)}</td>
    <td className={b.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(b.medianWorstAdverseUsd)}</td>
    <td className={b.medianMaeBeforeProfitUsd===null?"dd-muted":"negative"}>{usd(b.medianMaeBeforeProfitUsd)}</td>
   </tr>))}</tbody>
 </table>
 <small className="dd-note">Each bucket is priced at the outcome that actually occurred while the structure existed: VPOC before expiry → PnL at VPOC, invalidation before expiry → PnL at invalidation, no resolution before expiry → settlement. A structure entered after VPOC has no post-entry PnL at VPOC and is reported in its own bucket.</small>
 </div>;
}

/* ---------- 8. Matched DTE comparison ---------- */

function MatchedDteSection({report}:{report:DurationDteReport}){
 if(!report.matchedDte.length)return <p className="dd-empty-inline">{UNAVAILABLE} — no structural variant (same event, strike method, width, structure and option type) appears at two different horizons, so no controlled DTE comparison is possible in this bundle.</p>;
 return <><div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Comparison</th><th>Matched variants</th><th>Δ actual DTE</th><th>Δ PnL</th><th>Δ worst adverse</th><th>Δ holding</th><th>Δ T50% capture</th></tr></thead>
  <tbody>{report.matchedDte.map(r=><tr key={`${r.shorter.nominalDays}-${r.longer.nominalDays}`}>
   <td>{r.longer.label} − {r.shorter.label}</td>
   <td>{r.matchedVariants}</td>
   <td>{signedDays(r.medianDteDeltaDays)}</td>
   <td className={r.medianPnlDeltaUsd===null?"dd-muted":r.medianPnlDeltaUsd>=0?"positive":"negative"}>{signedUsd(r.medianPnlDeltaUsd)}</td>
   <td className={r.medianWorstAdverseDeltaUsd===null?"dd-muted":"negative"}>{signedUsd(r.medianWorstAdverseDeltaUsd)}</td>
   <td>{signedDays(r.medianHoldingDeltaDays)}</td>
   <td>{signedDays(r.medianCapture50DeltaDays)}</td>
  </tr>)}</tbody>
 </table></div>
 <small className="dd-note">Longer minus shorter, within MATCHED structural variants only — the same MR event, short-strike method, width, structure and option type, under the same execution scenario. A variant present at only one horizon is excluded entirely, so a width or strike-placement difference is never attributed to duration.</small>
 </>;
}

/* ---------- 9. Compare: maker vs taker on matched structures ---------- */

function MatchedExecutionSection({report}:{report:DurationDteReport}){
 const rows=report.matchedExecution;
 if(!rows.some(r=>r.matchedN>0))return <p className="dd-empty-inline">{UNAVAILABLE} — no structure in this bundle was genuinely evaluated under both maker and taker, so there is no matched pair to compare. Unmatched structures are never compared against each other.</p>;
 return <><div className="table-scroll"><table className="dd-table">
  <thead><tr><th>Horizon</th><th>Matched</th><th>Maker only</th><th>Taker only</th><th>Δ PnL</th><th>Δ worst adverse</th><th>Δ T50% capture</th><th>Δ sync</th><th>Δ capital-day return</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.horizon.nominalDays}>
   <td>{r.horizon.label}</td>
   <td>{r.matchedN}</td>
   <td className="dd-muted">{r.makerOnlyN}</td>
   <td className="dd-muted">{r.takerOnlyN}</td>
   <td className={r.medianPnlDragUsd===null?"dd-muted":r.medianPnlDragUsd>=0?"positive":"negative"}>{signedUsd(r.medianPnlDragUsd)}</td>
   <td className={r.medianWorstAdverseDragUsd===null?"dd-muted":"negative"}>{signedUsd(r.medianWorstAdverseDragUsd)}</td>
   <td>{signedDays(r.medianCapture50DragDays)}</td>
   <td>{r.medianSynchronizationDragMinutes===null?NOT_ESTIMABLE:`${r.medianSynchronizationDragMinutes>=0?"+":"−"}${Math.abs(r.medianSynchronizationDragMinutes).toFixed(2)}m`}</td>
   <td>{r.medianCapitalDayReturnDrag===null?UNAVAILABLE:r.medianCapitalDayReturnDrag.toFixed(4)}</td>
  </tr>)}</tbody>
 </table></div>
 <small className="dd-note">Maker-opportunity result minus taker result, for structures genuinely evaluated under BOTH scenarios (same candidate_id). Maker-only and taker-only structures are counted and shown but never entered into the difference. A negative Δ PnL means the maker opportunity, had it filled, would have underperformed the conservative taker proxy for that structure; it says nothing about whether the resting order would actually have filled.</small>
 </>;
}

/* ---------- 10. Holding period (capital-free) ---------- */

function HoldingPeriodSection({rows}:{rows:readonly HoldingPeriodRow[]}){
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>N</th><th>Median holding</th><th>P80 holding</th><th>Held to settlement</th></tr></thead>
  <tbody>{rows.map(r=><tr key={r.horizon.nominalDays}>
   <td>{r.horizon.label}</td><td>{r.n}</td>
   <td>{days(r.medianHoldingDays)}</td><td>{days(r.p80HoldingDays)}</td>
   <td>{pct(r.heldToSettlementShare)}</td>
  </tr>)}</tbody>
 </table>
 <small className="dd-note">T_hold = min(post-entry first resolution, expiry), measured from structure entry. This needs no margin data and is reported whether or not required capital is available. A VPOC that occurred before entry is never used as the holding endpoint.</small>
 </div>;
}

/* ---------- 11. Capital-time efficiency ---------- */

function CapitalTimeSection({report}:{report:DurationDteReport}){
 const c=report.capitalTime;
 if(!c.available)return <p className="dd-empty-inline">{UNAVAILABLE} — {c.reason}</p>;
 return <div className="dd-endpoints">
  <div className="dd-endpoint"><span className="dd-label">Median capital-days</span><strong>{c.medianCapitalDays===null?UNAVAILABLE:c.medianCapitalDays.toFixed(1)}</strong></div>
  <div className="dd-endpoint"><span className="dd-label">Median capital-day return</span><strong>{c.medianCapitalDayReturn===null?UNAVAILABLE:c.medianCapitalDayReturn.toFixed(4)}</strong></div>
 </div>;
}

/* ---------- 12. Resolution-speed sensitivity ---------- */

function ResolutionSpeedSection({report}:{report:DurationDteReport}){
 const rs=report.resolutionSpeed;
 if(!rs.available)return <p className="dd-empty-inline">{UNAVAILABLE} — {rs.reason}</p>;
 return <><p className="dd-sub">Cohorts cut from the observed first-resolution distribution: fast &lt; {days(rs.boundaries.p25Days)} (P25), slow &gt; {days(rs.boundaries.p75Days)} (P75), over {rs.boundaries.resolvedEventsN} resolved event(s). {rs.boundaries.unresolvedEventsN} unresolved event(s) stay in their own cohort.</p>
 <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Horizon</th><th>Cohort</th><th>N</th><th>Survived to resolution</th><th>Held to settlement</th><th>Median PnL</th><th>Median worst adverse</th><th>Median T50%</th></tr></thead>
  <tbody>{rs.rows.flatMap(row=>row.cells.filter(c=>c.n>0).map(c=>
   <tr key={`${row.horizon.nominalDays}-${c.cohort}`}>
    <td>{row.horizon.label}</td><td className={c.cohort==="unresolved"?"dd-muted":undefined}>{c.cohort}</td><td>{c.n}</td>
    <td>{pct(c.survivedToResolutionShare)}</td><td>{pct(c.settlementShare)}</td>
    <td className={c.medianPnlUsd===null?"dd-muted":c.medianPnlUsd>=0?"positive":"negative"}>{usd(c.medianPnlUsd)}</td>
    <td className={c.medianWorstAdverseUsd===null?"dd-muted":"negative"}>{usd(c.medianWorstAdverseUsd)}</td>
    <td>{days(c.medianCapture50Days)}</td>
   </tr>))}</tbody>
 </table></div>
 <small className="dd-note">How dependent is each DTE choice on the MR thesis resolving quickly? Cohorts come from naturally observed resolution behaviour, never invented price paths. Unresolved events are kept explicit rather than folded into &ldquo;slow&rdquo;, and every cell is computed inside one execution scenario.</small>
 </>;
}

/* ---------- 13. Entry-delay sensitivity ---------- */

function EntryDelaySection({report}:{report:DurationDteReport}){
 const ed=report.entryDelay;
 if(!ed.supported)return <div className="dd-unsupported">
  <p className="dd-empty-inline"><strong>Not supported by current canonical export.</strong> {ed.reason}</p>
  <p className="dd-sub">Required to enable this analysis later:</p>
  <ul className="fine-print">{ed.requiredCanonicalInputs.map((x,i)=><li key={i}>{x}</li>)}</ul>
 </div>;
 return <div className="table-scroll"><table className="dd-table dd-compact">
  <thead><tr><th>Delay</th><th>Structures with maker evidence</th><th>Structures with taker evidence</th></tr></thead>
  <tbody>{ed.rows.map(r=><tr key={r.delayHours}>
   <td>+{r.delayHours}h</td><td>{r.structuresWithRawEvidence.maker}</td><td>{r.structuresWithRawEvidence.taker}</td>
  </tr>)}</tbody>
 </table>
 <small className="dd-note">Delayed maker and taker scenarios each use only evidence available after the delayed order time; the original fill is never reused and a model mark is never treated as a historical fill.</small>
 </div>;
}

/* ---------- 14. Worst-adverse diagnostics ---------- */

function AdverseDiagnosticsSection({report}:{report:DurationDteReport}){
 const d=report.adverseDiagnostics;
 return <div className="dd-diagnostics">
  <div className="dd-endpoints">
   <div className="dd-endpoint"><span className="dd-label">Rows with a value</span><strong>{d.withValue} / {d.totalRows}</strong></div>
   <div className="dd-endpoint"><span className="dd-label">Reached profit (raw)</span><strong>{d.profitObservedN}</strong></div>
   <div className="dd-endpoint"><span className="dd-label">MAE before profit</span><strong>{d.maeBeforeProfitN}</strong></div>
  </div>
  <div className="table-scroll"><table className="dd-table dd-compact">
   <thead><tr><th>Evidence status</th><th>Rows</th></tr></thead>
   <tbody>{(Object.entries(d.byStatus) as [string,number][]).filter(([,n])=>n>0).map(([status,n])=>
    <tr key={status}><td>{status.replaceAll("_"," ")}</td><td>{n}</td></tr>)}</tbody>
  </table></div>
  {d.dominantReason&&<p className="dd-note">{d.dominantReason}</p>}
  <small className="dd-note">Worst adverse and MAE-before-profit are read only from this scenario&rsquo;s raw-VWAP valuation track. Where that track carries no priced mark the value stays Unavailable and the reason is shown here — a modelled mark is never substituted to fill the column.</small>
 </div>;
}

/* ---------- 15. Actual DTE distribution ---------- */

function DteHistogram({report}:{report:DurationDteReport}){
 const values=report.actualDteAll;
 if(!values.length)return <div className="dd-empty">No selected structure has a known actual DTE.</div>;
 const max=Math.max(...values,...report.horizons.flatMap(h=>h.eligibleDteRange?[h.eligibleDteRange.max]:[]))||1,bins=24;
 const counts=Array.from({length:bins},(_,i)=>values.filter(v=>{const lo=i*max/bins,hi=(i+1)*max/bins;return i===bins-1?v>=lo&&v<=hi:v>=lo&&v<hi}).length);
 const peak=Math.max(...counts)||1;
 return <div className="dd-hist"><div className="dd-hist-bars">{counts.map((c,i)=><i key={i} style={{height:`${c/peak*100}%`}} title={`${c} structure(s)`}/>)}</div>
  <small className="dd-note">0 – {d1(max)} days actual DTE across {values.length} structure(s). Actual DTE is execution-independent, so this distribution does not change with the selected scenario.</small>
 </div>;
}

/* ---------- 16. event-level audit ---------- */

function EventRow({c}:{c:DteCandidate}){
 return <tr>
  <td>{c.eventId}</td>
  <td>{c.horizonNominalDays===null?"—":`~${c.horizonNominalDays}D`}</td>
  <td>{c.actualDteDays===null?UNAVAILABLE:d1(c.actualDteDays)}</td>
  <td className="dd-muted">{c.widthUsd===null?"—":c.widthUsd.toLocaleString()}</td>
  <td>{c.entryQuality??UNAVAILABLE}</td>
  <td className={c.executionScenarioStatus==="evaluated"?undefined:"dd-muted"} title={c.executionScenarioReason??undefined}>{c.executionScenarioStatus==="evaluated"?"Evaluated":NOT_EVALUATED}</td>
  <td>{c.postEntryResolutionDays===null?"—":d1(c.postEntryResolutionDays)}</td>
  <td>{c.outcomeBeforeExpiry?OUTCOME_LABEL[c.outcomeBeforeExpiry]:"—"}
   {c.noResolutionDetail&&<small className="dd-muted"> ({c.noResolutionDetail.replaceAll("_"," ")})</small>}</td>
  <td className={c.dteBufferDays===null?"dd-muted":c.dteBufferDays<0?"negative":"positive"}>{c.dteBufferDays===null?"—":d1(c.dteBufferDays)}</td>
  <td>{c.holdingDays===null?"—":d1(c.holdingDays)}</td>
  <td>{c.capture50?.reached?days(c.capture50.timeToCaptureDays):c.capture50===null?UNAVAILABLE:"not reached"}</td>
  <td className={c.pnlAtVpocUsd===null?"dd-muted":"positive"} title={c.vpocBeforeStructureEntry?"VPOC preceded structure entry — no post-entry PnL at VPOC exists.":undefined}>{usd(c.pnlAtVpocUsd)}</td>
  <td className={c.pnlAtInvalidationUsd===null?"dd-muted":"negative"}>{usd(c.pnlAtInvalidationUsd)}</td>
  <td className={c.worstAdverseUsd===null?"dd-muted":"negative"} title={c.adversePath.reason??undefined}>{usd(c.worstAdverseUsd)}</td>
 </tr>;
}

/* ---------- report ---------- */

const VIEWS:readonly {value:ExecutionView;label:string}[]=[
 {value:"maker",label:"Maker opportunity"},
 {value:"taker",label:"Taker"},
 {value:"compare",label:"Compare"},
];

export function DurationDteReportView({report,view="maker",onViewChange}:{report:DurationDteReport;view?:ExecutionView;onViewChange?:(view:ExecutionView)=>void}){
 const [page,setPage]=useState(0);
 const pages=Math.max(1,Math.ceil(report.candidates.length/PAGE_SIZE));
 const current=Math.min(page,pages-1);
 const rows=report.candidates.slice(current*PAGE_SIZE,(current+1)*PAGE_SIZE);
 const h=report.headline;
 const compare=view==="compare";
 const scenarioLabel=report.scenario==="maker"?"maker opportunity":"taker";

 return <section className="workspace-section dd-report" data-testid="duration-dte-report">
  <header className="dd-header">
   <div>
    <p className="eyebrow">Options structure analysis · after underlying resolution</p>
    <h2>Duration &amp; DTE Analysis</h2>
    <p className="dd-sub">How does actual DTE affect thesis survival, execution availability, path behaviour and holding-time economics, controlling for structure variant and execution assumption?</p>
    <p className="dd-note">All analysis uses actual selected contract DTE; horizon labels are grouping bands only. {compare
     ?"Compare mode contrasts maker and taker on matched structures only; execution-dependent sections below remain scoped to the maker opportunity scenario."
     :`Execution-dependent sections are scoped to the ${scenarioLabel} scenario — ${report.scenario==="maker"?"a passive-limit opportunity supported by historical tape, never a confirmed fill":"a conservative tape-based execution proxy, never the sole default strategy"}.`} Execution-independent metrics are identical in every view.</p>
   </div>
   {onViewChange&&<div className="dd-tabs dd-scenario-tabs" role="tablist" aria-label="Execution view">
    {VIEWS.map(v=><button key={v.value} role="tab" aria-selected={v.value===view} className={v.value===view?"dd-tab-active":undefined} onClick={()=>onViewChange(v.value)}>{v.label}</button>)}
   </div>}
   <div className="dd-horizons">{report.horizons.map(hz=><span key={hz.nominalDays} className="dd-horizon-pill">{hz.label}{hz.eligibleDteRange&&<small> {hz.eligibleDteRange.min}–{hz.eligibleDteRange.max}d</small>}</span>)}</div>
  </header>

  {report.excludedIneligible>0&&<p className="dd-notice">{report.excludedIneligible} structure(s) excluded — their underlying MR event is ineligible for time-to-event analysis, never counted as a resolution or a failure.</p>}

  <div className="dd-cards">
   <HeadlineCard label="Effective MR events" value={String(h.effectiveEvents)} detail={h.totalEvents!==h.effectiveEvents?`of ${h.totalEvents}`:"100% of dataset"}/>
   <HeadlineCard label="Maker opportunity coverage" value={<Coverage coverage={h.maker}/>} detail={h.maker.status==="measured"?`${h.maker.events} of ${h.maker.eligibleEvents} eligible events`:undefined} title="Eligible MR events with at least one structure genuinely evaluated as a maker opportunity. Not a confirmed fill."/>
   <HeadlineCard label="Taker executable coverage" value={<Coverage coverage={h.taker}/>} detail={h.taker.status==="measured"?`${h.taker.events} of ${h.taker.eligibleEvents} eligible events`:undefined} title="Eligible MR events with at least one structure genuinely evaluated as taker-executable."/>
   <HeadlineCard label="Median actual DTE" value={h.medianActualDteDays===null?NOT_ESTIMABLE:`${d1(h.medianActualDteDays)}d`}/>
   <HeadlineCard label="Median holding period" value={days(h.medianHoldingDays)} detail="capital-free"/>
   <HeadlineCard label="No resolution before expiry" value={pct(h.noResolutionBeforeExpiryShare)}/>
   <HeadlineCard label="Median T resolution" value={days(h.medianFirstResolutionDays)}/>
  </div>

  {compare&&<section className="dd-block dd-centerpiece"><h3>Compare · maker vs. taker on matched structures</h3><MatchedExecutionSection report={report}/></section>}

  <section className="dd-block"><h3>1 · DTE overview</h3><OverviewTable rows={report.overview}/></section>

  <section className="dd-block"><h3>2 · Availability &amp; executability</h3>
   <div className="dd-two-col">
    <div><h4 className="dd-subhead">Coverage funnel (per MR event)</h4><CoverageFunnel report={report}/></div>
    <div><h4 className="dd-subhead">Entry quality</h4><EntryQualityBars report={report}/><h4 className="dd-subhead">Leg synchronization</h4><SynchronizationTable rows={report.synchronization} scenario={scenarioLabel}/></div>
   </div>
  </section>

  <section className="dd-block dd-centerpiece"><h3>3 · Thesis survival vs actual DTE</h3><CoverageChart report={report}/></section>

  <section className="dd-block"><h3>4 · Outcome before expiry</h3><OutcomeBeforeExpiryBars rows={report.outcomeBeforeExpiry}/></section>

  <div className="dd-two-col">
   <section className="dd-block"><h3>5 · DTE buffer</h3><BufferStrip rows={report.dteBuffer}/></section>
   <section className="dd-block"><h3>6 · Credit capture</h3><CaptureSection report={report}/></section>
  </div>

  <section className="dd-block"><h3>7 · PnL by candidate-relative outcome</h3><PnlSection rows={report.pnlByOutcome}/></section>

  <section className="dd-block"><h3>8 · Matched DTE comparison</h3><MatchedDteSection report={report}/></section>

  {!compare&&<section className="dd-block"><h3>9 · Execution drag: maker vs. taker</h3><MatchedExecutionSection report={report}/></section>}

  <div className="dd-two-col">
   <section className="dd-block"><h3>10 · Holding period</h3><HoldingPeriodSection rows={report.holdingPeriod}/></section>
   <section className="dd-block"><h3>11 · Capital-time efficiency</h3><CapitalTimeSection report={report}/></section>
  </div>

  <section className="dd-block"><h3>12 · Resolution-speed sensitivity</h3><ResolutionSpeedSection report={report}/></section>

  <section className="dd-block"><h3>13 · Entry-delay sensitivity</h3><EntryDelaySection report={report}/></section>

  <div className="dd-two-col">
   <section className="dd-block"><h3>14 · Adverse-path evidence</h3><AdverseDiagnosticsSection report={report}/></section>
   <section className="dd-block"><h3>15 · Actual DTE distribution</h3><DteHistogram report={report}/></section>
  </div>

  <section className="dd-block">
   <h3>Event-level observations</h3>
   <p className="dd-sub">Individual {scenarioLabel} rows underlying this report.</p>
   <div className="table-scroll"><table className="dd-table">
    <thead><tr><th>Event</th><th>Horizon</th><th>Actual DTE</th><th>Width</th><th>Quality</th><th>{report.scenario==="maker"?"Maker":"Taker"} status</th><th>T_res (post-entry)</th><th>Outcome before expiry</th><th>DTE buffer</th><th>T_hold</th><th>T50%</th><th>PnL@VPOC</th><th>PnL@Inv.</th><th>Worst adverse</th></tr></thead>
    <tbody>{rows.map(c=><EventRow key={c.structureExecutionId} c={c}/>)}</tbody>
   </table></div>
   <div className="ur-pager">
    <small>Showing {report.candidates.length?current*PAGE_SIZE+1:0}–{Math.min((current+1)*PAGE_SIZE,report.candidates.length)} of {report.candidates.length}. Paging never changes the statistics above.</small>
    <div><button disabled={current<=0} onClick={()=>setPage(current-1)}>Previous</button><span>{current+1} / {pages}</span><button disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next</button></div>
   </div>
  </section>

  <details className="ur-methodology"><summary>Methodology, availability and missing data</summary>
   {report.methodology.map((line,i)=><p className="fine-print" key={i}>{line}</p>)}
  </details>
 </section>;
}
