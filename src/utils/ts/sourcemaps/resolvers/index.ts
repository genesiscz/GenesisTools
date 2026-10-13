import { profiler } from "@genesiscz/utils/profile";
import type { ResolvedPosition, ResolveRequest, ResolverAttempt, SourceResolver } from "./types.ts";

const prof = profiler.scope("sourcemaps");

export { DebugIdResolver } from "./debug-id.ts";
export { DeployedMapResolver } from "./deployed-map.ts";
export { type LocalBuild, LocalBuildResolver } from "./local-build.ts";
export type * from "./types.ts";

export interface ChainResult {
    request: ResolveRequest;
    result: ResolvedPosition | null;
    /** Every resolver tried, in order, with the reason the earlier ones could not answer. */
    attempts: ResolverAttempt[];
}

/**
 * Resolvers that cost something to make (a local build runs the caller's build command), made the first time a
 * position reaches them and then reused, so a position an earlier resolver answers never waits on them.
 */
export class DeferredResolvers {
    private made?: Promise<SourceResolver[]>;

    constructor(
        readonly name: string,
        private readonly make: () => Promise<SourceResolver[]>
    ) {}

    resolvers(): Promise<SourceResolver[]> {
        this.made ??= this.make();
        return this.made;
    }
}

export type ResolverChain = Array<SourceResolver | DeferredResolvers>;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Asks each resolver in order (cheapest and most exact first) and stops at the first answer. */
export async function resolvePosition(request: ResolveRequest, resolvers: ResolverChain): Promise<ChainResult> {
    // Per position: only at --detail all, since check resolves hundreds.
    const detail = profiler.detail === "all";
    const stopProfile = detail ? prof.start("resolve") : () => 0;
    try {
        const attempts: ResolverAttempt[] = [];
        for (const entry of resolvers) {
            let group: SourceResolver[];
            if (entry instanceof DeferredResolvers) {
                try {
                    group = await entry.resolvers();
                } catch (error) {
                    attempts.push({ resolver: entry.name, result: null, reason: reasonOf(error) });
                    continue;
                }
            } else {
                group = [entry];
            }

            for (const resolver of group) {
                const attempt = await (detail
                    ? prof.measureAsync(`resolve.${resolver.name}`, () => resolver.resolve(request))
                    : resolver.resolve(request)
                ).catch(
                    (error: unknown): ResolverAttempt => ({
                        resolver: resolver.name,
                        result: null,
                        reason: reasonOf(error),
                    })
                );
                attempts.push(attempt);
                if (attempt.result) {
                    return { request, result: attempt.result, attempts };
                }
            }
        }

        return { request, result: null, attempts };
    } finally {
        stopProfile();
    }
}
