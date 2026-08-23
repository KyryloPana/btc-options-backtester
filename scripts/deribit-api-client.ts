export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * One Deribit JSON-RPC-over-HTTP request with the project's shared retry policy.
 * Only 408/429/5xx are retried; every other non-2xx is a hard failure so a
 * malformed request can never be mistaken for a transient outage.
 */
export async function deribitApiRequest(fetcher: FetchLike, baseUrl: string, method: string, params: Record<string, string | number | boolean>, onAttempt?: () => void) {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    onAttempt?.();
    const response = await fetcher(url);
    if (response.ok) {
      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? "Deribit API error");
      return payload.result;
    }
    if (![408, 429].includes(response.status) && response.status < 500) throw new Error(`Deribit HTTP ${response.status}`);
    if (attempt === 4) throw new Error(`Deribit HTTP ${response.status} after retries`);
    const retry = response.headers.get("retry-after");
    const delay = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(Date.parse(retry) - Date.now(), 0)) : 250 * 2 ** attempt;
    await sleep(Math.min(delay, 10_000));
  }
}
