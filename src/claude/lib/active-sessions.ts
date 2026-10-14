import { getSessionListing } from "@app/claude/lib/history/search";
import { getActiveSessionIds } from "@app/claude/lib/tail-list";
import { accountFromEnv, type LiveAccount } from "@genesiscz/utils/ai/account-env";
import { type PsProcessRow, parseLsofCwd, parsePsLine } from "@genesiscz/utils/ai/active-processes";
import type { AgentSessionFacts, AgentWhoSource } from "@genesiscz/utils/ai/active-sessions";
import { cleanTranscriptText } from "@genesiscz/utils/ai/transcripts/clean-text";
import { humanTextOf, readTailBytes } from "@genesiscz/utils/claude/session.utils";
import type { ContentBlock } from "@genesiscz/utils/claude/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Claude's part of `tools claude who`: which `ps` lines are Claude, the session its argv resumes, the live
 * sessions and their names from the history index, and the last message off a transcript. The scan, the cmux join
 * and the assignment are shared by every agent (`@genesiscz/utils/ai/active-sessions`). The account is
 * per-process: `tools claude run <name>` exports TOOLS_CLAUDE_ACCOUNT into the launched claude's environment
 * (start.ts / run.ts), so reading it back off the process table is the ONLY truthful answer to "which account does
 * this pane bill"; session files and statusline state do not record it.
 */

export type ClaudeProcessKind = "tui" | "sdk" | "mcp";

// The ps / lsof / account-env scan is the same on every coding agent. Re-exported so the tests that pin the
// parsers keep their import.
export { type PsProcessRow, parseLsofCwd, parsePsLine };

export interface SessionTail {
    lastUserMessage: string | null;
    lastActivityAt: number | null;
}

/**
 * Last user message and last main-thread activity from transcript tail lines,
 * newest first.
 *
 * `isSidechain` lines are subagent traffic: counting them would report a
 * subagent's clock as the session's, which is exactly the mismatch that makes
 * an idle pane look busy. Same rule as the statusline's `@HH:MM:SS`
 * (see lib/usage/session-rows.ts).
 */
export function parseSessionTail(lines: string[]): SessionTail {
    const tail: SessionTail = { lastUserMessage: null, lastActivityAt: null };

    for (let i = lines.length - 1; i >= 0; i--) {
        let obj: {
            type?: unknown;
            timestamp?: unknown;
            isSidechain?: unknown;
            isMeta?: unknown;
            message?: { content?: string | ContentBlock[] };
        };

        try {
            obj = SafeJSON.parse(lines[i], { strict: true });
        } catch {
            continue;
        }

        if ((obj.type !== "user" && obj.type !== "assistant") || obj.isSidechain === true) {
            continue;
        }

        if (tail.lastActivityAt === null && typeof obj.timestamp === "string") {
            const parsed = Date.parse(obj.timestamp);

            if (Number.isFinite(parsed)) {
                tail.lastActivityAt = parsed;
            }
        }

        if (tail.lastUserMessage === null && obj.type === "user" && obj.isMeta !== true) {
            const text = cleanUserText(humanTextOf(obj.message?.content));

            if (text) {
                tail.lastUserMessage = text;
            }
        }

        if (tail.lastActivityAt !== null && tail.lastUserMessage !== null) {
            break;
        }
    }

    return tail;
}

/**
 * The text a HUMAN typed, ignoring tool results.
 *
 * Every tool return is also recorded as a `type: "user"` record whose content is
 * `tool_result` blocks, so a plain text extraction reports the last command's stdout
 * ("Bash completed with no output") as the user's last message — which is exactly
 * backwards for a column meant to answer "who asked this session to do something".
 */
export { humanTextOf } from "@genesiscz/utils/claude/session.utils";

/**
 * Strip the wrappers the harness injects around a prompt. Without this the
 * "last message" column shows a system reminder or a tool result instead of
 * what the user typed.
 */
export function cleanUserText(raw: string): string {
    return cleanTranscriptText(raw, { slashFallback: false });
}

/** First slice. Grows up to TAIL_MAX_BYTES while the answer is still missing. */
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;

/**
 * A busy session's last 64 KiB can be nothing but tool results and subagent
 * traffic, which reports "—" for a pane that is plainly working. Grow the slice
 * until both answers are found or the file (or the cap) runs out — the same
 * doubling `extractTailUsage` uses for the usage TUI.
 */
async function readSessionTail(filePath: string): Promise<SessionTail> {
    try {
        const size = Number(Bun.file(filePath).size) || 0;
        let bytes = TAIL_BYTES;
        let tail: SessionTail = { lastUserMessage: null, lastActivityAt: null };

        for (;;) {
            tail = parseSessionTail(await readTailBytes(filePath, bytes));

            const complete = tail.lastActivityAt !== null && tail.lastUserMessage !== null;

            if (complete || size <= 0 || bytes >= size || bytes >= TAIL_MAX_BYTES) {
                return tail;
            }

            const next = Math.min(TAIL_MAX_BYTES, bytes * 2, size);

            if (next <= bytes) {
                return tail;
            }

            bytes = next;
        }
    } catch (error) {
        logger.debug({ error, filePath }, "[who] session tail read failed");
        return { lastUserMessage: null, lastActivityAt: null };
    }
}

/**
 * The real claude binary is a session; bun launchers are not. The gt-claude wrapper is an
 * SDK process, except when its last arg is `mcp`: that is the `tools claude mcp` stdio
 * server (the command takes no arguments), which any MCP host may spawn with no tty.
 */
export function classifyClaudeArgs(args: string): ClaudeProcessKind | null {
    const tokens = args.split(/\s+/);
    const base = (tokens[0] ?? "").split("/").pop() ?? "";

    if (base === "claude") {
        return "tui";
    }

    if (base === "gt-claude") {
        return tokens[tokens.length - 1] === "mcp" ? "mcp" : "sdk";
    }

    return null;
}

export function extractLaunchDetails(args: string): { resumeId: string | null; model: string | null } {
    const tokens = args.split(/\s+/);
    let resumeId: string | null = null;
    let model: string | null = null;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === "--resume" || token === "-r") {
            const next = tokens[i + 1];

            if (next && /^[\w-]+$/.test(next)) {
                resumeId = next;
            }
        } else if (token.startsWith("--resume=")) {
            resumeId = token.slice("--resume=".length) || null;
        } else if (token === "--model") {
            model = tokens[i + 1] ?? null;
        } else if (token.startsWith("--model=")) {
            model = token.slice("--model=".length) || null;
        }
    }

    return { resumeId, model };
}

/**
 * From a `ps -e` args+env line: the TOOLS_CLAUDE_ACCOUNT value, split into account vs proxy
 * target. One provider's door onto the shared reader, which Codex and Grok use through the
 * same function with their own alias.
 */
export function parseAccountEnv(envArgs: string): LiveAccount {
    return accountFromEnv(envArgs, "claude");
}

/**
 * A `tools claude mcp` server is never a session, whatever its tty says: Grok and Cursor
 * spawn it with no controlling tty, and it used to read as a dead headless Claude session.
 * An SDK child that shares a tty with a TUI session is that session's own launcher, not a
 * separate agent. Both bill the same account and add a row that reads like an unidentified
 * session, so they are hidden unless asked for. A headless SDK agent with no TUI on its tty
 * is a real, separately billable session and always shows.
 */
export function isHelperChild(
    proc: { kind: string; tty: string },
    all: ReadonlyArray<{ kind: string; tty: string }>
): boolean {
    if (proc.kind === "mcp") {
        return true;
    }

    if (proc.kind !== "sdk" || proc.tty === "??") {
        return false;
    }

    return all.some((other) => other.kind === "tui" && other.tty === proc.tty);
}

/** Claude's contribution to the shared `who`. */
export const CLAUDE_WHO_SOURCE: AgentWhoSource = {
    alias: "claude",
    classify: classifyClaudeArgs,
    isHelper: isHelperChild,
    resumeIdFromArgs: (args) => extractLaunchDetails(args).resumeId,
    async activeSessions(): Promise<AgentSessionFacts[]> {
        const activeIds = getActiveSessionIds();
        const listing = await getSessionListing({ excludeSubagents: true });

        // Every listed session, for its name and transcript: a session resumed by argv may be older than the
        // active window. Only the active ones take part in the cwd rung.
        return listing.sessions
            .filter((s): s is typeof s & { sessionId: string } => s.sessionId !== null)
            .map((s) => {
                const title = s.customTitle ?? s.summary ?? s.firstPrompt;
                return {
                    sessionId: s.sessionId,
                    cwd: s.cwd,
                    title: title ? title.replace(/\s+/g, " ").trim() : null,
                    filePath: s.filePath,
                    active: activeIds.has(s.sessionId),
                };
            });
    },
    tail: async (session) =>
        session.filePath ? readSessionTail(session.filePath) : { lastUserMessage: null, lastActivityAt: null },
};
