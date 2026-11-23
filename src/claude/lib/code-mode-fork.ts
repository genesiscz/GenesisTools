import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
    appendClaudeCodeModePin,
    claudeCodeModePin,
    type SessionCopyScan,
    writeSessionCopy,
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

export const DEFAULT_BACKUP_SUFFIX = "-without-codemode";

export interface CodeModeForkPlan {
    /** The session that gets the Code Mode marker and keeps its id, so every link to it reaches Code Mode. */
    sessionId: string;
    sessionPath: string;
    title: string;
    /** The copy without Code Mode, under a new id. */
    backupId: string;
    backupPath: string;
    backupTitle: string;
}

export type CodeModeForkOutcome =
    | { kind: "refused"; reason: string }
    | { kind: "planned"; plan: CodeModeForkPlan }
    | { kind: "forked"; plan: CodeModeForkPlan; backup: SessionCopyScan };

export interface CodeModeForkOptions {
    /** A session id, a prefix of eight characters or more, or the session's exact `/rename` title. */
    session: string;
    /** A new title for the Code Mode session; default: its own title. */
    title?: string;
    /** Added to the title of the copy without Code Mode. */
    backupSuffix?: string;
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
 * Moves a session into Code Mode: a copy under a new id keeps the conversation without Code Mode, then the session
 * itself gets the Code Mode marker and keeps its id. It refuses while a Claude Code process has the session open: that
 * process would keep writing to the file and could write its own name over the rename.
 */
export async function forkSessionIntoCodeMode(options: CodeModeForkOptions): Promise<CodeModeForkOutcome> {
    const found = await findTranscript(options.session);

    if (typeof found !== "string") {
        return found;
    }

    const sessionPath = found;
    const sessionId = basename(sessionPath, ".jsonl");
    const holders = claudeSessionHolders(sessionId);

    if (holders.length > 0) {
        return {
            kind: "refused",
            reason: `Session ${sessionId} is open in Claude Code (pid ${holders.join(", ")}). Exit it first.`,
        };
    }

    if (claudeCodeModePin(sessionPath) === true) {
        return {
            kind: "refused",
            reason: `Session ${sessionId} already runs in Code Mode. Resume it with CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1.`,
        };
    }

    const suffix = options.backupSuffix ?? DEFAULT_BACKUP_SUFFIX;
    const customTitle = lastClaudeTitleIn(sessionPath);

    if (customTitle?.endsWith(suffix)) {
        return {
            kind: "refused",
            reason: `Session ${sessionId} is titled "${customTitle}": it is the copy without Code Mode.`,
        };
    }

    const ownTitle = customTitle ?? lastClaudeAiTitleIn(sessionPath);
    const title = options.title ?? ownTitle;

    if (!title) {
        return { kind: "refused", reason: `Session ${sessionId} has no title. Pass --title <title>.` };
    }

    const backupId = randomUUID();
    const plan: CodeModeForkPlan = {
        sessionId,
        sessionPath,
        title,
        backupId,
        backupPath: join(dirname(sessionPath), `${backupId}.jsonl`),
        backupTitle: `${ownTitle ?? title}${suffix}`,
    };

    if (options.dryRun) {
        return { kind: "planned", plan };
    }

    // The copy comes first: when a later step fails, the conversation without Code Mode already exists.
    const backup = await writeSessionCopy({
        sourcePath: sessionPath,
        sourceId: sessionId,
        copyId: backupId,
        copyPath: plan.backupPath,
        title: plan.backupTitle,
    });
    appendClaudeCodeModePin(sessionPath, sessionId);

    if (options.title && options.title !== ownTitle) {
        appendClaudeTitle(sessionPath, sessionId, options.title);
    }

    return { kind: "forked", plan, backup };
}
