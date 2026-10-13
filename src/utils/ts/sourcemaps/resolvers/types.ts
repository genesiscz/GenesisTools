import type { OriginalPosition } from "../source-map.ts";

/** A position in a deployed file: a character offset (LoAF `sourceCharPosition`) or a 1-based line + 0-based column. */
export type GeneratedPosition = { offset: number } | { line: number; column: number };

export interface ResolveRequest {
    /** The deployed file's URL (LoAF `sourceURL`, a stack frame URL). */
    url: string;
    position: GeneratedPosition;
}

/**
 * - `exact`: the deployment's own map answered.
 * - `aligned`: a local build's map answered after the position was carried over by a unique code window.
 * - `approximate`: carried over by the nearest of several matching windows; check the excerpt.
 */
export type ResolveConfidence = "exact" | "aligned" | "approximate";

export interface ResolvedPosition extends OriginalPosition {
    resolver: string;
    confidence: ResolveConfidence;
    /** Lines of the original source around the position, when the map embeds `sourcesContent`. */
    excerpt?: string[];
    /** Why the resolver believes this: window size, chunk similarity, which build. */
    evidence: string[];
    /** Reasons to doubt it: the build is not the deployed commit, the chunk changed, a coarse map segment. */
    warnings: string[];
}

export interface ResolverAttempt {
    resolver: string;
    result: ResolvedPosition | null;
    /** Why it could not answer. */
    reason?: string;
}

export interface SourceResolver {
    readonly name: string;
    resolve(request: ResolveRequest): Promise<ResolverAttempt>;
}
