"use client";
import { useMemo, useState } from "react";
import {
  ANALYTICS_TRACKS,
  buildResearchAnalyticsModel,
} from "../lib/research-analytics-model";
import type { AnalysisDataset } from "../lib/research-analysis";

const label = (value: string) => value.replaceAll("_", " ");
const number = (value: number | null) =>
  value === null
    ? "—"
    : Math.abs(value) < 1
      ? value.toFixed(4)
      : value.toFixed(2);

/** Engineering and methodological audit surface. It deliberately has no report-wide track control. */
export function ResearchAnalyticsWorkbench({
  dataset,
}: {
  dataset: AnalysisDataset;
}) {
  const model = useMemo(() => buildResearchAnalyticsModel(dataset), [dataset]);
  const [selected, setSelected] = useState<string | null>(null);
  const inspection = model.observations.find(
    (observation) => observation.id === selected,
  );
  return (
    <details
      className="analytics-workbench workspace-section"
      data-testid="diagnostics-audit"
    >
      <summary>
        <strong>Diagnostics &amp; Audit</strong>
        <span>
          Denominators, coverage, confidence, missingness and provenance
        </span>
      </summary>
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            Normalized analytical unit · event × strategy variant
          </p>
          <h2>Diagnostics &amp; Audit</h2>
        </div>
        <em className="report-state available">
          {model.observations.length} observations
        </em>
      </div>
      <p className="resolution-banner">
        Tracks attach to—and never multiply—a structural observation. This
        troubleshooting surface does not select a track for research reports.
      </p>
      <h3>Denominator ledger</h3>
      <div className="count-grid">
        {Object.entries(model.denominators).flatMap(([key, value]) =>
          typeof value === "number" ? (
            <span key={key}>
              <b>{value}</b>
              {label(key)}
            </span>
          ) : (
            Object.entries(value).map(([bucket, count]) => (
              <span key={`${key}-${bucket}`}>
                <b>{Number(count)}</b>
                {label(key)} · {bucket}
              </span>
            ))
          ),
        )}
      </div>
      <h3>Track/source coverage and quality composition</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Track</th>
              <th>Events / eligible / available</th>
              <th>Sources</th>
              <th>Confidence</th>
              <th>Trade conditional</th>
              <th>Opportunity normalized</th>
            </tr>
          </thead>
          <tbody>
            {model.summaries.map((summary) => (
              <tr key={summary.track}>
                <td>{label(summary.track)}</td>
                <td>
                  {summary.events} / {summary.eligible} / {summary.entered}
                </td>
                <td>
                  {Object.entries(summary.sourceComposition)
                    .map(([key, value]) => `${key} ${value}`)
                    .join(" · ") || "none"}
                </td>
                <td>
                  {Object.entries(summary.tierComposition)
                    .map(([key, value]) => `${key} ${value}`)
                    .join(" · ")}
                </td>
                <td>
                  {number(summary.tradeConditional.pnl)} (
                  {summary.tradeConditional.count})
                </td>
                <td>
                  {number(summary.opportunityNormalized.pnl)} (
                  {summary.opportunityNormalized.count}); missed{" "}
                  {summary.opportunityNormalized.missed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Observation inspector, schema/provenance and missingness</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Observation</th>
              <th>Contract status</th>
              {ANALYTICS_TRACKS.map((track) => (
                <th key={track}>{label(track)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.observations.map((observation) => (
              <tr key={observation.id}>
                <td>
                  <button onClick={() => setSelected(observation.id)}>
                    {observation.eventId}
                    <br />
                    {observation.strategyVariantId}
                  </button>
                </td>
                <td>{observation.contractStatus}</td>
                {ANALYTICS_TRACKS.map((track) => (
                  <td key={track}>
                    {observation.tracks[track]?.status ?? "unavailable"}
                    <br />
                    <small>
                      {observation.tracks[track]?.reason ??
                        observation.reasons.join("; ")}
                    </small>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inspection ? (
        <pre className="analytics-inspector">
          {JSON.stringify(inspection, null, 2)}
        </pre>
      ) : (
        <p>
          Select an observation to inspect evidence, entry ledger, valuation
          path, outcomes, uncertainty and missing reasons.
        </p>
      )}
    </details>
  );
}
