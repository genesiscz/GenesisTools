/**
 * eve's local environment facade.
 *
 * The parent repo's rule is that application code never touches `process.env`
 * directly — it goes through `@genesiscz/utils/env`, so every variable has one
 * named accessor and one place that documents its default. `apps/eve` cannot
 * import that module: it is not in the root `workspaces` array (root
 * package.json lists only `src/utils`), carries no dependency entry for it, and
 * has no path alias to it. eve's dependency list is deliberately thin, and
 * wiring the whole parent workspace in to reach an env helper would be a much
 * larger change than the rule is worth.
 *
 * So this mirrors the pattern locally, per the Phase 8d fallback: the accessors
 * live here, and everything else in `apps/eve/agent` calls them. `process.env`
 * appears in this file and nowhere else under `agent/` (its test files aside,
 * which set variables to exercise the readers).
 *
 * Accessors return `undefined` rather than throwing when unset; a caller that
 * genuinely requires a value says so at its own call site, where it can give a
 * useful error.
 */

export type Env = Record<string, string | undefined>;

/**
 * The environment the agent boots from, and the ONLY `process.env` reference
 * under `agent/`.
 *
 * Modules like `world.ts` take the map as a parameter rather than reading the
 * global, which is the better shape (it is trivially testable). They keep that
 * signature; callers pass this instead of reaching for the global themselves.
 */
export const agentEnv: Env = process.env;

function read(env: Env, name: string): string | undefined {
    const value = env[name];

    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();

    return trimmed === "" ? undefined : trimmed;
}

/**
 * Every accessor takes the environment explicitly rather than closing over
 * `process.env`. eve's agent module is evaluated at import time, and a test that
 * wants to exercise a different environment cannot re-import it; passing the map
 * in keeps these readable without a module-reset dance.
 */
export const eveEnv = {
    /** Base URL of the local ai-proxy that serves eve's model calls. */
    getAiProxyBaseUrl: (env: Env = agentEnv): string =>
        read(env, "AI_PROXY_BASE_URL") ?? "http://127.0.0.1:8317/v1",

    /** Client key for that proxy. Required — `createProxyModel` errors when absent. */
    getAiProxyApiKey: (env: Env = agentEnv): string | undefined => read(env, "AI_PROXY_API_KEY"),

    /** ai-proxy model id eve talks to, in `<client>/<slug>/<model>` form. */
    getModelId: (env: Env = agentEnv): string => read(env, "EVE_MODEL_ID") ?? "martin/grok/grok-4-fast",

    /** Comma-separated service keys, one per user. Unset leaves the agent open. */
    getServiceKey: (env: Env = agentEnv): string | undefined => read(env, "EVE_SERVICE_KEY"),

    /** Base URL of the GenesisTools youtube API server eve connects to. */
    getYoutubeApiBaseUrl: (env: Env = agentEnv): string =>
        (read(env, "YOUTUBE_API_BASE_URL") ?? "http://127.0.0.1:9876").replace(/\/$/, ""),

    /** Comma-separated service keys for that youtube server. */
    getYoutubeServiceKey: (env: Env = agentEnv): string | undefined => read(env, "YOUTUBE_SERVICE_KEY"),
};
