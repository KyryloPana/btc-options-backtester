/**
 * The research hierarchy the Analytics workspace actually uses, stated once.
 *
 * The workspace used to present two controls -- "Pricing track: raw_vwap /
 * iv_normalized" and "Execution assumption: maker / taker" -- as if they
 * determined every report. They did not, and could not: underlying MR
 * resolution is execution-independent, contract/DTE availability has its own
 * denominator, short-strike and width comparisons are structural analyses, and
 * modeled execution is a sensitivity rather than observed truth. Worse, the
 * execution-assumption control reached no report at all, because every layer
 * that needs a scenario sets its own.
 *
 * There is deliberately NO report-wide track selector. Each report states which
 * layer it is using instead, and this table is what it states.
 */

export type AnalyticalLayerGroup = "primary_baseline" | "execution_robustness" | "modeled_sensitivity";

export interface AnalyticalTrackLayer {
 readonly id:string;
 readonly group:AnalyticalLayerGroup;
 readonly label:string;
 /** The research question this layer answers, in the workspace's own words. */
 readonly question:string;
 /** Stated when the layer is conditionally available. Null when unconditional. */
 readonly availability:string|null;
}

export const ANALYTICAL_LAYER_GROUPS:readonly {group:AnalyticalLayerGroup;label:string;summary:string}[]=[
 {group:"primary_baseline",label:"Primary baseline",
  summary:"Is the structure economically interesting independent of strict sparse-tape execution evidence?"},
 {group:"execution_robustness",label:"Execution robustness",
  summary:"How much of the reference economics survives executable or delayed entry assumptions? These are sensitivity layers and never replace the baseline."},
 {group:"modeled_sensitivity",label:"Modeled sensitivity",
  summary:"Modelled execution is sensitivity, not observed truth. An uncalibrated modeled layer stays Unavailable and is never shown as zero."},
];

export const ANALYTICAL_TRACK_LAYERS:readonly AnalyticalTrackLayer[]=[
 {id:"market_volatility_state",group:"primary_baseline",label:"Market volatility state",
  question:"What did admissible strike/expiry IV, causal reference IV, trailing RV and broad volatility evidence show at entry and while the position was open?",
  availability:"Missing market evidence remains unavailable; pricing reconstruction and DVOL are not substitutes."},
 {id:"reference",group:"primary_baseline",label:"Reference fair value",
  question:"The fair-value counterfactual for execution economics, and the structural baseline for short-strike, width and core DTE comparisons.",
  availability:null},
 {id:"immediate_maker",group:"execution_robustness",label:"Immediate Maker",
  question:"Does the reference economics survive a resting maker fill at the signal?",
  availability:"Available only where the historical tape supports a maker opportunity."},
 {id:"immediate_taker",group:"execution_robustness",label:"Immediate Taker",
  question:"Does it survive paying the spread immediately?",
  availability:"Available only where the historical tape supports a taker execution."},
 {id:"delayed_maker",group:"execution_robustness",label:"Delayed Maker",
  question:"A different question: does the structure still work if the order is placed later?",
  availability:"Requires a delayed opening AND a causal post-entry path; opening evidence alone is entry-only, not a complete economic track."},
 {id:"delayed_taker",group:"execution_robustness",label:"Delayed Taker",
  question:"The same delayed question under taker execution.",
  availability:"Requires a delayed opening AND a causal post-entry path."},
 {id:"modeled_conservative",group:"modeled_sensitivity",label:"Conservative modeled",
  question:"A deliberately pessimistic modelled opening, used as a downside sensitivity.",
  availability:"Modelled. Never used as a substitute for expected modelled execution."},
 {id:"modeled_expected",group:"modeled_sensitivity",label:"Expected modeled",
  question:"The modelled central opening estimate.",
  availability:"Unavailable unless the existing calibration requirements pass. It is never shown as observed, and conservative modelled execution is never substituted for it."},
 {id:"penalty_sensitivity",group:"modeled_sensitivity",label:"Penalty sensitivity",
  question:"How the result moves as an execution penalty is varied.",
  availability:"Modelled sensitivity only."},
];

export interface ReportTrackRoute {
 readonly report:string;
 /** The layer the report's primary analysis is computed on. */
 readonly primaryLayer:string;
 /** Layers attached beside the primary analysis, never pooled into it. */
 readonly robustnessLayers:readonly string[];
 /** False when the report's primary analysis cannot depend on an execution assumption. */
 readonly executionDependent:boolean;
 readonly note:string;
}

/**
 * What each report is actually routed to. This is a description of the wiring,
 * not a control: nothing here is selectable.
 */
export const REPORT_TRACK_ROUTES:readonly ReportTrackRoute[]=[
 {report:"Underlying Resolution",primaryLayer:"underlying_path",robustnessLayers:[],executionDependent:false,
  note:"MR resolution is a property of the underlying path. It has no options execution track and no maker/taker switch."},
 {report:"Volatility",primaryLayer:"market_volatility_state",robustnessLayers:[],executionDependent:false,
  note:"Descriptive market-state evidence with explicit missingness. Pricing IV and DVOL never substitute for strike/expiry market IV, and there is no execution selector."},
 {report:"Duration & DTE",primaryLayer:"reference",robustnessLayers:["immediate_maker","immediate_taker","delayed_maker","delayed_taker","modeled_expected","modeled_conservative"],executionDependent:false,
  note:"Structural timing, actual DTE and thesis resolution are execution-independent and have their own denominator. Maker and taker coverage, leg synchronization, the matched maker-vs-taker comparison and the operational holding period are execution-dependent subsections and say so; one display scenario scopes those subsections only."},
 {report:"Short Strike",primaryLayer:"reference",robustnessLayers:["immediate_maker","immediate_taker"],executionDependent:false,
  note:"Strike placement is a structural comparison, so Reference is the primary layer. Maker and taker are attached as separate robustness layers and are never pooled with it."},
 {report:"Spread Width",primaryLayer:"reference",robustnessLayers:["immediate_maker","immediate_taker"],executionDependent:false,
  note:"Protective width is a structural comparison, so Reference is the primary layer. Maker and taker are attached as separate robustness layers and are never pooled with it."},
 {report:"Exit Policy",primaryLayer:"reference",robustnessLayers:["immediate_maker","immediate_taker"],executionDependent:false,
  note:"Every policy is compared on ONE canonical same-track methodology: triggers and economics on the reference path, with observed maker/taker close support attached separately. Pricing and execution tracks are never pooled. The selected complete exit policy remains a genuine policy control."},
 {report:"Economics",primaryLayer:"modeled_expected",robustnessLayers:["reference","modeled_conservative","immediate_maker","immediate_taker","penalty_sensitivity"],executionDependent:true,
  note:"Empirical Q50 is central, Reference is the fair-value counterfactual, and empirical Q90 is the conservative execution layer."},
];

/**
 * The visible label for the capital basis.
 *
 * COMPATIBILITY TOKEN. The serialized configuration value is still
 * `maximum_economic_loss`, because it participates in the analysis-run identity
 * and renaming it would invalidate stored configurations for no analytical gain.
 * The quantity it selects is, and always was, the canonical bounded MAXIMUM
 * STRUCTURAL LOSS -- `margin_scenarios.maximum_structural_loss_native` -- so
 * only the wording changes here. Risk semantics are unchanged.
 */
export const CAPITAL_BASIS_LABELS:Readonly<Record<string,string>>={
 maximum_economic_loss:"Maximum structural loss",
 incremental_opening_margin:"Incremental opening margin",
 peak_required_capital:"Peak required capital",
};
export const CAPITAL_BASIS_COMPATIBILITY_NOTE="The capital-basis value `maximum_economic_loss` is retained as a serialized compatibility token; the quantity it selects is the canonical bounded maximum structural loss. Structural loss is not Initial Margin and not Maintenance Margin." as const;
