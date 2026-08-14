import type { DeploymentModel } from "./margin.ts";

export interface DeribitCredentials { clientId: string; clientSecret: string; apiUrl?: string }

/** Server-only authenticated RPC client. Callers must source credentials from server environment variables. */
export async function simulateDeribitMargin(input: {
  credentials: DeribitCredentials;
  model: DeploymentModel;
  currency: string;
  simulatedPositions: unknown;
  fetchImpl?: typeof fetch;
}) {
  if (typeof window !== "undefined") throw new Error("Deribit credentials must never be used in the browser");
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiUrl = input.credentials.apiUrl ?? "https://www.deribit.com/api/v2";
  const authResponse = await fetchImpl(`${apiUrl}/public/auth?${new URLSearchParams({ grant_type: "client_credentials", client_id: input.credentials.clientId, client_secret: input.credentials.clientSecret })}`, { method: "GET", cache: "no-store" });
  if (!authResponse.ok) throw new Error(`Deribit authentication failed (${authResponse.status})`);
  const auth = await authResponse.json() as { result?: { access_token?: string } };
  if (!auth.result?.access_token) throw new Error("Deribit authentication returned no access token");
  const method = input.model.endsWith("pm") ? "private/simulate_portfolio" : "private/get_margins";
  const response = await fetchImpl(`${apiUrl}/${method}`, {
    method: "POST", cache: "no-store",
    headers: { authorization: `Bearer ${auth.result.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: { currency: input.currency, simulated_positions: input.simulatedPositions } }),
  });
  if (!response.ok) throw new Error(`Deribit margin simulation failed (${response.status})`);
  return response.json() as Promise<unknown>;
}
