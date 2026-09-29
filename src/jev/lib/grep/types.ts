import { SafeJSON } from "@genesiscz/utils/json";
import type { OwnedProject, TestCommand } from "@genesiscz/utils/repo-context";
import type { FilesystemPolicy } from "./filesystem";

/** Inclusive, 1-based source lines. */
export interface Range {
    startLine: number;
    endLine: number;
}

/** A line range that names a slice of a giant line with a half-open UTF-8 byte interval. */
export type EvidenceRange = Range & { sourceByteStart?: number; sourceByteEnd?: number };

export interface ReadingLead {
    name: string;
    range: EvidenceRange;
    score: number;
}

export interface Excerpt {
    range: EvidenceRange;
    source: string;
    sourceByteStart?: number;
    sourceByteEnd?: number;
    partial?: boolean;
}

export interface CallLead {
    caller: string;
    name: string;
    range: Range;
    unknownEarlierBases: string[];
}

/** One admitted file. The row stays even when selection leaves `excerpts` empty: the path is a lead. */
export interface FileEvidence {
    path: string;
    contentHash: string;
    score: number;
    priority?: number;
    roles: string[];
    leads: ReadingLead[];
    selected: EvidenceRange[];
    rendered: EvidenceRange[];
    excerpts: Excerpt[];
    presentationExcerpts?: Excerpt[];
    selectedPresentationExcerpts?: Excerpt[];
    presentationSelected?: EvidenceRange[];
    sourceDecisions?: Array<{ range: EvidenceRange; score: number }>;
    callLeads?: CallLead[];
    sourceOmitted: boolean;
}

export interface IssueCount {
    kind: string;
    count: number;
}

/** Upstream's three fields first, then what the shared gatherers in `@genesiscz/utils/repo-context` add. */
export interface RepositoryContext {
    /** Agent instruction files at the root and at returned-file ancestors, never above the root. */
    instructionFiles: string[];
    instructionLookupIncomplete: boolean;
    /** The pytest files among `testCommands`, kept so `--json` still reads next to an upstream trace. */
    pytestFiles: string[];
    projects: OwnedProject[];
    testCommands: TestCommand[];
    /** Gatherers that failed. Their fields above are empty because they are unknown, not absent. */
    failedGatherers: string[];
}

export type RetrievalStatus = "complete" | "incomplete" | "interrupted";

/** Field names follow upstream `packages/core/src/types.ts` so `--json` reads next to an upstream trace. */
export interface RetrievalResult {
    root: string;
    query: string;
    status: RetrievalStatus;
    files: FileEvidence[];
    issues: IssueCount[];
    providerFailure?: string;
    warnings?: IssueCount[];
    repositoryContext: RepositoryContext;
    /**
     * Upstream's three counts, then what this run spent. `costUsd` is the catalog list price the usage
     * ledger booked; calls the catalog could not price are counted in `unpricedCalls`, never as free.
     */
    counts: {
        requests: number;
        cacheHits: number;
        inspectedFiles: number;
        inputTokens?: number;
        costUsd?: number;
        unpricedCalls?: number;
    };
    provider?: string;
    model?: string;
}

export interface SearchInput {
    root: string;
    query: string;
    policy?: FilesystemPolicy;
    signal: AbortSignal;
    /** Absolute paths never listed, read or uploaded, under any flag. */
    protectedPaths?: string[];
    /**
     * Jev calls the search plans for. Absent or 0 runs upstream's exhaustive loop unchanged. A positive
     * number runs the budgeted loop: best-first directories, file cards, full-source checks for the
     * shortlist only, and source selection for the top files only.
     */
    budget?: number;
}

export interface BooleanQuestion {
    type: "boolean";
    instructions: string;
}

/** `state` is an object handed to the SDK as-is. Never stringify it first. */
export interface EvaluationRequest {
    state: Record<string, unknown>;
    questions: Record<string, BooleanQuestion>;
}

export interface EvaluationPolicy {
    navigation?: boolean;
    /** Snapshots the request was built from. Their paths and content hashes are part of the cache key. */
    sources?: Array<{ path: string; contentHash: string }>;
    /** Validates the donor snapshots before each network attempt and before a cached answer is trusted. */
    beforeAttempt?: () => Promise<void>;
}

export interface Evaluator {
    readonly requests: number;
    readonly cacheHits?: number;
    readonly cacheIssues?: IssueCount[];
    readonly provider?: string;
    readonly model?: string;
    readonly spend?: { inputTokens: number; costUsd: number; unpricedCalls: number };
    evaluate(request: EvaluationRequest, policy?: EvaluationPolicy): Promise<Record<string, number>>;
}

export type EvaluationFailureKind = "authentication" | "request-limit" | "provider" | "cancelled" | "source-invalid";

/**
 * The retrieval loop's failure. `source-invalid` is internal: a donor changed between discovery and
 * the call, so the batch is re-split or dropped instead of being reported as a provider problem.
 */
export class EvaluationFailure extends Error {
    readonly kind: EvaluationFailureKind;
    readonly splitEligible: boolean;

    constructor(kind: EvaluationFailureKind, options: { splitEligible?: boolean; message?: string } = {}) {
        super(options.message ?? `Jev evaluation failed: ${kind}`);
        this.name = "EvaluationFailure";
        this.kind = kind;
        this.splitEligible = options.splitEligible ?? false;
    }
}

/** Plain-data serialization for every size gate and every quoted path; identical to the native serializer. */
export function toJson(value: unknown): string {
    return SafeJSON.stringify(value, { strict: true });
}

export function jsonBytes(value: unknown): number {
    return Buffer.byteLength(toJson(value));
}
