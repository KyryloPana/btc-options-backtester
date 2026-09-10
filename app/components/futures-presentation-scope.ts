import type {FuturesComparisonReport} from "../lib/futures-comparison/report";

/** Presentation-only row scoping. The source report and its summary remain untouched. */
export function scopeFuturesEvents(report:FuturesComparisonReport,selectedCandidateIds:readonly string[]|null){if(selectedCandidateIds===null)return report.events;const selected=new Set(selectedCandidateIds);return report.events.map(event=>({...event,options:event.options.filter(option=>selected.has(option.candidateId))})).filter(event=>event.options.length>0)}
