export type ResearchEvidenceStatus="VALID"|"PARTIAL"|"UNAVAILABLE"|"INVALID"|"UNUSUAL";
export interface EvidenceAssessment{readonly status:ResearchEvidenceStatus;readonly reason:string|null}
export function evidenceRowProps(assessment:EvidenceAssessment){return {className:`evidence-status-${assessment.status.toLowerCase()}`,title:assessment.status==="VALID"?undefined:assessment.reason??`${assessment.status} evidence`}}
export function ResearchEvidenceBadge({assessment}:{assessment:EvidenceAssessment}){return <span className={`evidence-badge evidence-badge-${assessment.status.toLowerCase()}`} title={assessment.status==="VALID"?undefined:assessment.reason??`${assessment.status} evidence`}>{assessment.status}</span>}
