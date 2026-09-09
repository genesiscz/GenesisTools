import { sep } from "node:path";

export interface ListingWavePlan {
    excludeSubagents: boolean;
    needAgentFill: boolean;
    subagentsOnly: boolean;
}

export interface AgentListingOptions {
    project?: string;
    excludeSubagents: boolean;
    subagentsOnly: boolean;
    limit?: number;
}

export function listingStalePaths(options: {
    cachedPaths: string[];
    diskFiles: Set<string>;
    projectDir?: string;
    excludeSubagents?: boolean;
    subagentsOnly?: boolean;
}): string[] {
    if (options.excludeSubagents || options.subagentsOnly) {
        return [];
    }

    const cachedPathsInScope = options.projectDir
        ? options.cachedPaths.filter((path) => path.startsWith(options.projectDir + sep) || path === options.projectDir)
        : options.cachedPaths;

    return cachedPathsInScope.filter((path) => !options.diskFiles.has(path));
}

export function listingIndexSlice<T extends { mtime: number }>(entries: T[], limit?: number): T[] {
    const sorted = [...entries].sort((left, right) => right.mtime - left.mtime);
    if (limit == null) {
        return sorted;
    }

    return sorted.slice(0, Math.max(20, limit * 4));
}

export function listingWavePlan<T extends { agentsOnly?: boolean; excludeAgents?: boolean; limit?: number }>(
    filters: T
): ListingWavePlan {
    if (filters.agentsOnly) {
        return { excludeSubagents: false, needAgentFill: false, subagentsOnly: true };
    }

    if (filters.excludeAgents) {
        return { excludeSubagents: true, needAgentFill: false, subagentsOnly: false };
    }

    return { excludeSubagents: true, needAgentFill: true, subagentsOnly: false };
}

export function listingPassesDate(timestamp: Date, filters: { since?: Date; until?: Date }): boolean {
    if (filters.since && timestamp < filters.since) {
        return false;
    }

    if (filters.until && timestamp > filters.until) {
        return false;
    }

    return true;
}

export function relevanceParseCap(fileCount: number, limit?: number): number {
    const floor = Math.max(8, (limit ?? 20) * 2);
    return Math.min(fileCount, floor);
}

export const RELEVANCE_MATCH_COUNT_CAP = 20;

export function selectRelevanceParseFiles(
    files: Array<{ path: string; mtime: number; matchCount?: number }>,
    limit?: number
): string[] {
    const cap = relevanceParseCap(files.length, limit);
    const cappedCount = (file: { matchCount?: number }): number =>
        Math.min(file.matchCount ?? 0, RELEVANCE_MATCH_COUNT_CAP);

    return [...files]
        .sort((left, right) => {
            const countDelta = cappedCount(right) - cappedCount(left);
            if (countDelta !== 0) {
                return countDelta;
            }

            return right.mtime - left.mtime;
        })
        .slice(0, cap)
        .map((file) => file.path);
}

export function ranksByRelevance(filters: { sortByRelevance?: boolean; query?: string }): boolean {
    return Boolean(filters.sortByRelevance && filters.query);
}

export function agentWaveStopAfter(options: {
    limit?: number;
    mainHitCount: number;
    sortByRelevance?: boolean;
}): number | undefined {
    if (options.limit == null) {
        return undefined;
    }

    if (options.sortByRelevance) {
        return undefined;
    }

    return Math.max(0, options.limit - options.mainHitCount);
}

export function agentFillListingOptions(project: string | undefined, remaining?: number): AgentListingOptions {
    return {
        project,
        excludeSubagents: false,
        subagentsOnly: true,
        limit: remaining,
    };
}

export function shouldLoadAgentListing<T extends { needAgentFill: boolean }>(
    plan: T,
    mainCount: number,
    limit?: number
): boolean {
    if (!plan.needAgentFill) {
        return false;
    }

    if (limit == null) {
        return true;
    }

    return mainCount < limit;
}

export function mergeSearchWaves<T extends { timestamp: Date; relevanceScore?: number }>(
    mains: T[],
    agents: T[],
    options: { limit?: number; sortByRelevance?: boolean } = {}
): T[] {
    const byRelevance = (left: T, right: T) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0);
    const byTime = (left: T, right: T) => right.timestamp.getTime() - left.timestamp.getTime();
    const sort = options.sortByRelevance ? byRelevance : byTime;
    const merged = options.sortByRelevance
        ? [...mains, ...agents].sort(sort)
        : [...mains].sort(sort).concat([...agents].sort(sort));

    if (options.limit && merged.length > options.limit) {
        return merged.slice(0, options.limit);
    }

    return merged;
}
