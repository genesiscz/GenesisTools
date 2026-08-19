import { basename } from "node:path";
import { loadPins } from "@app/claude/lib/cmux/pins";
import type { RestoreCandidate } from "@app/claude/lib/cmux/types";
import { readTranscriptTail } from "@app/claude/lib/history/limit-kill";
import { getSessionListing } from "@app/claude/lib/history/search";
import { resolveProjectFilter } from "@genesiscz/utils/claude";
import type { SessionMetadataRecord } from "@genesiscz/utils/claude/history-cache";
import { logger } from "@genesiscz/utils/logger";

export interface ListCandidatesOptions {
    /** How many sessions to offer, newest activity first. */
    limit: number;
    /**
     * Limit the scan to the current directory's project. Off by default: after a crash
     * the sessions you want back are spread across every repo you had open, and scoping
     * to one project hides most of them.
     */
    thisProjectOnly?: boolean;
    /** Drop sessions older than this. */
    maxAgeMs?: number;
    /** Read the pin journal without compacting it — for callers that must not mutate (`--dry-run`). */
    readOnly?: boolean;
    onProgress?: (processed: number, total: number, file: string) => void;
}

/** 30 days: older than that and "resume it" stops being a realistic thing to want. */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resumable sessions, most recently ACTIVE first.
 *
 * The cached metadata index sorts by session start, which is the wrong order here —
 * a session opened yesterday and worked on ten minutes ago is the one you want back
 * after a crash. So the ordering is by transcript mtime, and only the sessions that
 * survive the cut pay for a tail read (last prompt, rate-limit death, live cwd).
 */
export async function listCandidates(opts: ListCandidatesOptions): Promise<RestoreCandidate[]> {
    const project = opts.thisProjectOnly ? resolveProjectFilter() : undefined;
    const listing = await getSessionListing({
        project,
        excludeSubagents: true,
        onProgress: opts.onProgress,
    });

    const cutoff = Date.now() - (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    const recent = listing.sessions
        .filter((s) => s.sessionId && s.cwd && s.mtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, opts.limit);

    logger.debug(
        { scope: listing.scope, total: listing.total, offered: recent.length, limit: opts.limit },
        "[claude-cmux] session candidates selected"
    );

    const pins = await loadPins({ readOnly: opts.readOnly });

    return Promise.all(recent.map((record) => toCandidate(record, pins)));
}

async function toCandidate(
    record: SessionMetadataRecord,
    pins: Awaited<ReturnType<typeof loadPins>>
): Promise<RestoreCandidate> {
    const tail = await readTranscriptTail(record.filePath);
    const cwd = tail?.cwd ?? record.cwd ?? "";
    const pin = record.sessionId ? pins.get(record.sessionId) : undefined;
    const project = record.project || basename(cwd) || "unknown";

    return {
        sessionId: record.sessionId as string,
        cwd,
        project,
        branch: record.gitBranch,
        title: record.customTitle || record.summary || record.firstPrompt,
        lastPrompt: tail?.lastPrompt ?? null,
        limitStop: tail?.limitStop ?? null,
        subdir: subdirOf(cwd, project),
        mtimeMs: record.mtime,
        account: pin?.account ?? null,
        model: pin?.model ?? null,
        pinned: pin !== undefined,
    };
}

/**
 * Which directory the session actually ran in, when that is not the project root.
 *
 * Two shapes matter, and both are worktrees:
 *  - NESTED (`GenesisTools/.worktrees/fix`) — the tail below the project root.
 *  - SIBLING (`col-fe-col-297040-burn-auth`) — a directory next to the repo. Claude
 *    Code still files it under the project `col-fe`, so without this the row reads as
 *    the plain repo and several worktrees look identical. The redundant `col-fe-`
 *    prefix is dropped, leaving the part that tells them apart.
 *
 * Returns null when the session ran in the project root, where there is nothing to add.
 */
export function subdirOf(cwd: string, project: string): string | null {
    const marker = `/${project}/`;
    const at = cwd.lastIndexOf(marker);

    if (at !== -1) {
        return cwd.slice(at + marker.length) || null;
    }

    const dir = basename(cwd);

    if (!dir || dir === project) {
        return null;
    }

    return dir.startsWith(`${project}-`) ? dir.slice(project.length + 1) : dir;
}
