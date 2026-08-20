export const LOCAL_PERSISTENCE_REQUIRED_MESSAGE =
  "Research-state persistence requires the local application server.";
export const RESEARCH_SELECTION_ENDPOINT_FAILED_MESSAGE =
  "Research-selection persistence endpoint failed.";
export const LOCAL_PERSISTENCE_CAPABILITY_PATH = "/__local/persistence-capabilities";

export type LocalPersistenceProbe =
  | { status: "available" }
  | { status: "unsupported"; detail: string }
  | { status: "unreachable"; detail: string };

type FetchLike = (input: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** Explicitly probes the local route set; a connection failure is inconclusive. */
export async function probeLocalPersistence(fetcher: FetchLike = fetch): Promise<LocalPersistenceProbe> {
  try {
    const response = await fetcher(LOCAL_PERSISTENCE_CAPABILITY_PATH);
    if (!response.ok) {
      if (response.status !== 404) return { status: "unreachable", detail: `Capability probe returned HTTP ${response.status}.` };
      // A stale Vite process can serve the dataset plugin while its older route
      // set lacks this capability endpoint. That is a local-server fault, not
      // evidence of static hosting.
      try {
        const datasets = await fetcher("/__local/trade-datasets");
        const payload = datasets.ok ? await datasets.json().catch(() => undefined) as { datasets?: unknown } | undefined : undefined;
        if (Array.isArray(payload?.datasets)) return { status: "unreachable", detail: "The local dataset route is active, but the persistence capability route is missing; restart the development server." };
      } catch { /* Both local probes are absent, which confirms no local route set. */ }
      return { status: "unsupported", detail: "The local persistence route set is not registered." };
    }
    const body = await response.json().catch(() => undefined) as { runtime?: unknown; researchSelections?: unknown } | undefined;
    return body?.runtime === "local-application-server" && body.researchSelections === true
      ? { status: "available" }
      : { status: "unsupported", detail: "The current origin did not identify a local persistence runtime." };
  } catch (error) {
    return { status: "unreachable", detail: error instanceof Error ? error.message : "Capability probe failed before receiving a response." };
  }
}

export function researchSelectionFailure(error: unknown, probe: LocalPersistenceProbe): { unavailable: boolean; message: string } {
  if (probe.status === "unsupported") return { unavailable: true, message: LOCAL_PERSISTENCE_REQUIRED_MESSAGE };
  const detail = error instanceof Error ? error.message : "The request failed without an error message.";
  const probeDetail = probe.status === "unreachable" ? ` Capability probe: ${probe.detail}` : "";
  return { unavailable: false, message: `${RESEARCH_SELECTION_ENDPOINT_FAILED_MESSAGE} ${detail}${probeDetail}` };
}
