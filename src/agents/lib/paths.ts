import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { FriendlyError } from "./errors";
import type { SessionPaths } from "./types";

const UNSAFE_SEGMENT_RE = /[/\\]|^\.\.?$/;

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
