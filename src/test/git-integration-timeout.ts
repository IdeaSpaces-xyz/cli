/**
 * Real executable/repository fixtures, not a latency contract: native Windows
 * Git setup/probes have taken 5.3–17.8s. Opt in only for those integration cases;
 * Vitest's global default and production Git/network deadlines stay unchanged.
 */
export const GIT_INTEGRATION_TIMEOUT = 30_000;
