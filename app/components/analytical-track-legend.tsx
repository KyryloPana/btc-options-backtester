"use client";
import {ANALYTICAL_LAYER_GROUPS,ANALYTICAL_TRACK_LAYERS,REPORT_TRACK_ROUTES} from "../lib/analytical-track-layers";

const layerLabel=(id:string)=>ANALYTICAL_TRACK_LAYERS.find(x=>x.id===id)?.label??id.replaceAll("_"," ");

/**
 * Methodology communication, not a control panel. Nothing here is selectable:
 * the workspace does not have one maker/taker selector that reroutes every
 * report, because the reports answer different questions and correctly use
 * different layers. Each report states the layer it uses, and this is where the
 * layers and the routing are named.
 */
export function AnalyticalTrackLegend(){
 return <section className="workspace-section analytical-track-legend" data-testid="analytical-track-legend" aria-labelledby="analytical-track-legend-title">
  <div className="section-heading"><div><p className="eyebrow">Read-only methodology</p><h2 id="analytical-track-legend-title">Analytical tracks</h2></div></div>
  <p className="resolution-banner">Different research questions use different tracks. There is no workspace-wide execution selector: each report below states the layer it is computed on, and robustness layers are attached beside the primary baseline rather than replacing it.</p>
  <div className="capability-table">{ANALYTICAL_LAYER_GROUPS.map(group=><div key={group.group}>
   <strong>{group.label}</strong>
   <em>{ANALYTICAL_TRACK_LAYERS.filter(x=>x.group===group.group).map(x=>x.label).join(" · ")}</em>
   <small>{group.summary}</small>
  </div>)}</div>
  <div className="dd-table-scroll"><table className="dd-table">
   <thead><tr><th>Report</th><th>Primary layer</th><th>Robustness / sensitivity layers</th><th>Scope</th></tr></thead>
   <tbody>{REPORT_TRACK_ROUTES.map(route=><tr key={route.report}>
    <td>{route.report}</td>
    <td>{route.primaryLayer==="underlying_path"?"Underlying path":layerLabel(route.primaryLayer)}</td>
    <td>{route.robustnessLayers.length?route.robustnessLayers.map(layerLabel).join(", "):<span className="dd-muted">none</span>}</td>
    <td>{route.note}</td>
   </tr>)}</tbody>
  </table></div>
  <small className="dd-note">{ANALYTICAL_TRACK_LAYERS.filter(x=>x.availability).map(x=>`${x.label}: ${x.availability}`).join(" ")}</small>
 </section>;
}
