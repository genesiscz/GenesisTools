import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { FriendlyError } from "./errors";
import type { SessionPaths } from "./types";

const UNSAFE_SEGMENT_RE = /[/\\]|^\.\.?$/;
// Escape codes, newlines, tabs. Captured terminal output passed as --session
// created real directories under agentsRoot() whose names carry ANSI colour
// codes and line breaks: unlistable, untypeable, and awkward to clean up.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
/** A session id is a UUID (36 chars) and an agent id is shorter. */
const MAX_SEGMENT_LENGTH = 128;

/**
 * Reject path-traversal/absolute-escape segments before they're joined into a
 * filesystem path. Used for session ids and agent ids (owner/cursor keys) —
 * both can come from explicit user input (--session, --agent-id,
 * $CLAUDE_CODE_SESSION_ID) and get joined into paths under agentsRoot().
 */
export function assertSafePathSegment(value: string, label: string): string {
    if (!value || UNSAFE_SEGMENT_RE.test(value)) {
        throw new FriendlyError(
            `${label} "${value}" is not a valid path segment`,
            `${label} must not contain "/", "\\", or be "." / "..".`
        );
    }

    if (CONTROL_CHAR_RE.test(value)) {
        throw new FriendlyError(
            `${label} contains a control character`,
            `${label} must be plain text. This usually means captured terminal output (escape codes or a newline) was passed instead of an id.`
        );
    }

    if (value.length > MAX_SEGMENT_LENGTH) {
        throw new FriendlyError(
            `${label} is ${value.length} characters long`,
            `${label} must be at most ${MAX_SEGMENT_LENGTH} characters. This usually means a whole command output was passed instead of an id.`
        );
    }

    if (value !== value.trim()) {
        throw new FriendlyError(
            `${label} "${value}" has leading or trailing whitespace`,
            `${label} must not start or end with whitespace.`
        );
    }

    return value;
}

export function agentsRoot(): string {
    return join(env.tools.getHome(), ".genesis-tools", "agents");
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
