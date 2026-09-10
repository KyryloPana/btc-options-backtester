import type {AnalysisConfiguration} from "../lib/analysis-configuration";
import type {FuturesComparisonReport} from "../lib/futures-comparison/report";

export function FuturesBenchmarkScope({report,candidatePolicy}:{report:FuturesComparisonReport;candidatePolicy:AnalysisConfiguration["exitPolicy"]}){
 return <section className="benchmark-scope" aria-labelledby="benchmark-scope-title"><h3 id="benchmark-scope-title">Benchmark Scope</h3><dl><dt>Instrument</dt><dd>Canonical BTC-PERPETUAL</dd><dt>Option layer</dt><dd>Reference</dd><dt>Equal-risk sizing</dt><dd>{report.equalRiskSizingMethod}</dd><dt>Candidate policy</dt><dd>{candidatePolicy??"not configured"} (Economics strategy input)</dd><dt>Futures comparison endpoint</dt><dd>Canonical endpoint carried by each exported comparison row; the candidate policy does not rewrite it.</dd><dt>Funding</dt><dd>{report.summary.eventsWithCompleteFunding} complete; {report.summary.eventsWithPartialOrMissingFunding} partial or missing</dd></dl></section>;
}
