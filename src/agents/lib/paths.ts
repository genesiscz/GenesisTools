import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_SESSION_ID_LENGTH, type SessionIdProblem, sessionIdProblem } from "@genesiscz/utils/agents/session-id";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { FriendlyError } from "./errors";
import type { SessionPaths } from "./types";

/** The hint each refusal prints. The test itself is the shared one every session-id file guard uses. */
const SEGMENT_HINTS = {
    "not-a-string": (label: string) => [`${label} is not text`, `${label} must be a string.`],
    empty: (label: string) => [
        `${label} "" is not a valid path segment`,
        `${label} must not contain "/", "\\", or be "." / "..".`,
    ],
    path: (label: string, value: string) => [
        `${label} "${value}" is not a valid path segment`,
        `${label} must not contain "/", "\\", or be "." / "..".`,
    ],
    "control-character": (label: string) => [
        `${label} contains a control character`,
        `${label} must be plain text. This usually means captured terminal output (escape codes or a newline) was passed instead of an id.`,
    ],
    "too-long": (label: string, value: string) => [
        `${label} is ${value.length} characters long`,
        `${label} must be at most ${MAX_SESSION_ID_LENGTH} characters. This usually means a whole command output was passed instead of an id.`,
    ],
    whitespace: (label: string, value: string) => [
        `${label} "${value}" has leading or trailing whitespace`,
        `${label} must not start or end with whitespace.`,
    ],
} satisfies Record<SessionIdProblem, (label: string, value: string) => [string, string]>;

/**
 * Reject path-traversal/absolute-escape segments before they're joined into a
 * filesystem path. Used for session ids and agent ids (owner/cursor keys) —
 * both can come from explicit user input (--session, --agent-id,
 * $CLAUDE_CODE_SESSION_ID) and get joined into paths under agentsRoot().
 */
export function assertSafePathSegment(value: string, label: string): string {
    const problem = sessionIdProblem(value);

    if (problem === null) {
        return value;
    }

    const [message, hint] = SEGMENT_HINTS[problem](label, value);
    throw new FriendlyError(message, hint);
}

export function agentsRoot(): string {
    return toolDataDir("agents");
}

export function sessionPaths(session: string): SessionPaths {
    assertSafePathSegment(session, "session");
    const sessionDir = join(agentsRoot(), session);
    return {
        session,
        sessionDir,
        feedPath: join(sessionDir, "feed.jsonl"),
        slotsDir: join(sessionDir, "slots"),
    };
}

export function ensureSessionDir(paths: SessionPaths): void {
    if (!existsSync(paths.sessionDir)) {
        mkdirSync(paths.sessionDir, { recursive: true });
    }

    if (!existsSync(paths.slotsDir)) {
        mkdirSync(paths.slotsDir, { recursive: true });
    }
}
