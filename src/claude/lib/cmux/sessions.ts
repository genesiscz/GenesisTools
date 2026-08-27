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

/** One session as a RestoreCandidate, by full id or a prefix of at least 8 chars. */
export async function findCandidate(
    sessionId: string,
    opts: { readOnly?: boolean } = {}
): Promise<RestoreCandidate | null> {
    const needle = sessionId.trim().toLowerCase();

    if (needle.length < 8) {
        return null;
    }

    const listing = await getSessionListing({ excludeSubagents: true });
    // Filter to usable records FIRST. `find` returned the earliest prefix match,
    // so an exact id could lose to a longer one listed before it, and a first
    // match with no cwd aborted the lookup even when a complete record followed.
    const usable = listing.sessions.filter((s) => {
        const id = (s.sessionId ?? "").toLowerCase();
        return Boolean(s.sessionId && s.cwd) && (id === needle || id.startsWith(needle));
    });
    const record = usable.find((s) => (s.sessionId ?? "").toLowerCase() === needle) ?? usable[0];

    if (!record?.sessionId || !record.cwd) {
        return null;
    }

    const pins = await loadPins({ readOnly: opts.readOnly ?? true });
    return toCandidate(record, pins);
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
        title:
            cleanPromptText(record.customTitle) ??
            cleanPromptText(record.summary) ??
            cleanPromptText(record.firstPrompt),
        lastPrompt: cleanPromptText(tail?.lastPrompt),
        limitStop: tail?.limitStop ?? null,
        subdir: subdirOf(cwd, project),
        mtimeMs: record.mtime,
        account: pin?.account ?? null,
        model: pin?.model ?? null,
        auth: pin?.auth,
        pinned: pin !== undefined,
    };
}

/** Harness blocks whose CONTENT is noise, not something the user typed. */
const NOISE_BLOCKS =
    /<(local-command-caveat|local-command-stdout|system-reminder|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

/** Lines pasted from a terminal screenshot: the Claude Code status line and its neighbours. */
const NOISE_LINES = [/bypass permissions/i, /\d+k\/\d+k\(/, /^\s*claude-[a-z]+-[\d.]/i, /for agents\s*$/];

/** Long enough to identify a session, short enough that the picker keeps its columns. */
const TITLE_MAX = 120;

/**
 * A session's prompt text, with the parts the user did not write removed.
 *
 * The raw first prompt is whatever the transcript recorded, and that is often harness
 * boilerplate: a `<local-command-caveat>` block for a session opened with a slash
 * command, or a pasted status line above the real question. Both then became the row
 * title AND the cmux tab name, which is how a tab ended up called
 * `<local-command-caveat>Caveat: T…`.
 */
export function cleanPromptText(raw: string | null | undefined): string | null {
    if (!raw) {
        return null;
    }

    const text = raw
        .replace(NOISE_BLOCKS, " ")
        // Any leftover tag: keep what it wrapped, drop the markup.
        .replace(/<\/?[a-z][\w-]*>/gi, " ")
        .split("\n")
        .filter((line) => !NOISE_LINES.some((pattern) => pattern.test(line)))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    if (!text) {
        return null;
    }

    return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * Which directory the session actually ran in, when that is not the project root.
 *
 * Two shapes matter, and both are worktrees:
 *  - NESTED (`GenesisTools/.worktrees/fix`) — the tail below the project root.
 *  - SIBLING (`web-app-297040-auth`) — a directory next to the repo. Claude
 *    Code still files it under the project `web-app`, so without this the row reads as
 *    the plain repo and several worktrees look identical. The redundant `web-app-`
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
