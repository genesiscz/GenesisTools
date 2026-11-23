import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
    type CodeModeForkScan,
    claudeCodeModePin,
    writeCodeModeFork,
} from "@genesiscz/utils/agent-sessions/readers/claude-fork";
import {
    AmbiguousSessionIdError,
    canonicalClaudeTranscript,
} from "@genesiscz/utils/agent-sessions/readers/claude-locate";
import { claudeSessionHolders } from "@genesiscz/utils/agent-sessions/readers/claude-peer";
import {
    appendClaudeTitle,
    lastClaudeAiTitleIn,
    lastClaudeTitleIn,
} from "@genesiscz/utils/agent-sessions/readers/claude-title";
import { findSessionsByTitle } from "@genesiscz/utils/ai/transcripts/session-title";

export const DEFAULT_OLD_SUFFIX = "-without-fork";

export interface CodeModeForkPlan {
    sourceId: string;
    sourcePath: string;
    forkId: string;
    forkPath: string;
    /** The new session's title: the one `claude --resume` should pick. */
    title: string;
    /** The old session's title after the fork. */
    oldTitle: string;
}

export type CodeModeForkOutcome =
    | { kind: "refused"; reason: string }
    | { kind: "planned"; plan: CodeModeForkPlan }
    | { kind: "forked"; plan: CodeModeForkPlan; fork: CodeModeForkScan };

export interface CodeModeForkOptions {
    /** A session id, a prefix of eight characters or more, or the session's exact `/rename` title. */
    session: string;
    /** The new session's title; default: the old session's own title. */
    title?: string;
    oldSuffix?: string;
    dryRun?: boolean;
}

/** An id or an id prefix first, then a `/rename` title. Only an exact title counts: a fork of the wrong session is two sessions to undo. */
async function findTranscript(session: string): Promise<string | CodeModeForkOutcome> {
    try {
        const byId = await canonicalClaudeTranscript(session);

        if (byId) {
            return byId;
        }
    } catch (error) {
        if (error instanceof AmbiguousSessionIdError) {
            return { kind: "refused", reason: `${session} starts several sessions: ${error.ids.join(", ")}.` };
        }

        throw error;
    }

    const wanted = session.trim().toLowerCase();
    const hits = findSessionsByTitle(session, { provider: "claude" });
    const exact = hits.filter((hit) => hit.title.trim().toLowerCase() === wanted);
    const ids = [...new Set(exact.map((hit) => hit.sessionId))];

    if (ids.length > 1) {
        return { kind: "refused", reason: `Several sessions are titled "${session}": ${ids.join(", ")}. Pass an id.` };
    }

    const [id] = ids;

    if (id) {
        return (await canonicalClaudeTranscript(id)) ?? { kind: "refused", reason: `No transcript for session ${id}.` };
    }

    const near = hits.map((hit) => `${hit.sessionId.slice(0, 8)} "${hit.title}"`).slice(0, 5);
    return {
        kind: "refused",
        reason: `No Claude session with the id or title ${session}.${near.length > 0 ? ` Titles that contain it: ${near.join(", ")}.` : ""}`,
    };
}

/**
 * Copies a session that runs without Code Mode into a new session that resumes in Code Mode, then renames the old
 * one. It refuses while a Claude Code process has the session open: that process would keep writing to the old file
 * and could write its own title over the rename.
 */
export async function forkSessionIntoCodeMode(options: CodeModeForkOptions): Promise<CodeModeForkOutcome> {
    const found = await findTranscript(options.session);

    if (typeof found !== "string") {
        return found;
    }

    const sourcePath = found;
    const sourceId = basename(sourcePath, ".jsonl");
    const holders = claudeSessionHolders(sourceId);

    if (holders.length > 0) {
        return {
            kind: "refused",
            reason: `Session ${sourceId} is open in Claude Code (pid ${holders.join(", ")}). Exit it first.`,
        };
    }

    if (claudeCodeModePin(sourcePath) === true) {
        return {
            kind: "refused",
            reason: `Session ${sourceId} already runs in Code Mode. Resume it with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1.`,
        };
    }

    const suffix = options.oldSuffix ?? DEFAULT_OLD_SUFFIX;
    const customTitle = lastClaudeTitleIn(sourcePath);

    if (customTitle?.endsWith(suffix)) {
        return {
            kind: "refused",
            reason: `Session ${sourceId} is titled "${customTitle}": it was forked before. Fork the new session instead.`,
        };
    }

    const ownTitle = customTitle ?? lastClaudeAiTitleIn(sourcePath);
    const title = options.title ?? ownTitle;

    if (!title) {
        return { kind: "refused", reason: `Session ${sourceId} has no title. Pass --title <title>.` };
    }

    const forkId = randomUUID();
    const plan: CodeModeForkPlan = {
        sourceId,
        sourcePath,
        forkId,
        forkPath: join(dirname(sourcePath), `${forkId}.jsonl`),
        title,
        oldTitle: `${ownTitle ?? title}${suffix}`,
    };

    if (options.dryRun) {
        return { kind: "planned", plan };
    }

    const fork = await writeCodeModeFork({ ...plan });
    appendClaudeTitle(sourcePath, sourceId, plan.oldTitle);
    return { kind: "forked", plan, fork };
}
