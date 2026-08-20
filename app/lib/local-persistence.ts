export const LOCAL_PERSISTENCE_REQUIRED_MESSAGE =
  "Research-state persistence requires the local application server.";

/** Fetch rejects before an HTTP response exists for an absent or lost route. */
export function persistenceEndpointUnavailable(
  error: unknown,
  responseReceived: boolean,
): boolean {
  return !responseReceived && error instanceof TypeError;
}
