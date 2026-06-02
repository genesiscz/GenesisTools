/**
 * Shared query-key CONVENTION (D32 + per-feature layout). This file is read, almost never edited,
 * when a feature is added — it holds the namespacing rule and a couple of cross-cutting helpers,
 * NOT a per-feature-growing registry. Each feature owns its own keys, co-located with its query
 * factories in `src/features/<feature>/queries.ts` (e.g. `pulseKeys`), so parallel feature agents
 * never collide on a shared file.
 *
 * THE RULE (must hold for invalidation + cache reads to stay sane):
 *   1. Every key is an `as const` tuple whose FIRST element is the feature's unique root segment
 *      ("pulse", "weather", "tmux", "qa", "obsidian", "cmux", "ttyd", …). Distinct roots = no
 *      runtime collision between features.
 *   2. Components/hooks NEVER hand-write a tuple inline — they reference the feature's keys object.
 *   3. Parameterized keys are functions returning the tuple (`history: (m, min) => [...] as const`).
 *
 * Example (lives in src/features/pulse/queries.ts, not here):
 *   export const pulseKeys = {
 *       snap: ["pulse", "snap"] as const,
 *       history: (metric: string, minutes: number) => ["pulse", "history", metric, minutes] as const,
 *   };
 */

/** A query key is a readonly tuple led by the feature root segment. */
export type QueryKey = readonly [string, ...unknown[]];

/** Build a feature key namespace helper (optional sugar): `ns("pulse")("snap")` → `["pulse","snap"]`. */
export function featureKey(root: string) {
    return (...parts: unknown[]): QueryKey => [root, ...parts] as const;
}
