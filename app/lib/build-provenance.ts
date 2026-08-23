/**
 * Application build identity for newly generated runs.
 *
 * The commit is injected at build/dev time by the Vite config, which reads it
 * from Git. It is never hardcoded in source, and when Git metadata is genuinely
 * unavailable the value is an explicit sentinel rather than an invented SHA or
 * a silent null — a run that cannot say which code produced it must say so.
 */
export const BUILD_PROVENANCE_UNAVAILABLE = "unavailable:no-build-metadata" as const;
export const BUILD_PROVENANCE_ENV_KEY = "VITE_APP_COMMIT" as const;

export type BuildProvenanceStatus = "available" | "unavailable";
export interface BuildProvenance { applicationBuild: string; status: BuildProvenanceStatus; source: string }

const COMMIT = /^[0-9a-f]{7,40}(?:-dirty)?$/i;

/**
 * Accepts the injected environment and returns a value that is always a
 * non-empty string, so provenance can be validated rather than being
 * indistinguishable from "the field was never populated".
 */
export function resolveBuildProvenance(env?: Record<string, string | undefined> | null): BuildProvenance {
  const raw = env?.[BUILD_PROVENANCE_ENV_KEY]?.trim();
  if (!raw || raw === BUILD_PROVENANCE_UNAVAILABLE) return { applicationBuild: BUILD_PROVENANCE_UNAVAILABLE, status: "unavailable", source: "no git metadata was available at build time" };
  if (!COMMIT.test(raw)) return { applicationBuild: BUILD_PROVENANCE_UNAVAILABLE, status: "unavailable", source: `injected build id ${JSON.stringify(raw)} is not a git commit` };
  return { applicationBuild: raw, status: "available", source: "git rev-parse at build time" };
}

/** Convenience for call sites that only persist the identifier. */
export function resolveApplicationBuild(env?: Record<string, string | undefined> | null): string {
  return resolveBuildProvenance(env).applicationBuild;
}

export function buildProvenanceStatus(applicationBuilds: readonly unknown[]): BuildProvenanceStatus {
  const values = applicationBuilds.map(value => typeof value === "string" ? value.trim() : "");
  return values.length > 0 && values.every(value => value !== "" && value !== BUILD_PROVENANCE_UNAVAILABLE) ? "available" : "unavailable";
}
