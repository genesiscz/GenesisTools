import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { atomicWriteFileSync } from "@app/utils/storage/storage";
import { assertSafePathSegment } from "./paths";
import type { SessionPaths } from "./types";

const log = logger.child({ component: "agents:cursor" });

/**
 * Per-agent delivery cursor sidecar — `slots/<agent_id>.cursor` (JSON {"seq":N}).
 *
 * Lives separately from the derived registry because it's *runtime state* of an
 * active login (advances on every drain); deriving it from the feed would
 * require persisting a "cursor_advanced" event per drain — that defeats the
 * point of feed-as-truth.
 *
 * Missing/unreadable cursor → seq 0 (start of feed). Cursor reset is just
 * `rm <agent_id>.cursor`.
 */

interface CursorPayload {
    seq: number;
}

function cursorPath(paths: SessionPaths, agentId: string): string {
    assertSafePathSegment(agentId, "agentId");
    return join(paths.slotsDir, `${agentId}.cursor`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function readCursor(paths: SessionPaths, agentId: string): number {
    const path = cursorPath(paths, agentId);

    if (!existsSync(path)) {
        return 0;
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"));

        if (!isPlainObject(parsed)) {
            return 0;
        }

        const seq = parsed.seq;
        return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
    } catch (err) {
        log.warn({ err, path, agentId }, "unreadable cursor file; replaying from seq 0");
        return 0;
    }
}

export function writeCursor(paths: SessionPaths, agentId: string, seq: number): void {
    const payload: CursorPayload = { seq };
    atomicWriteFileSync(cursorPath(paths, agentId), SafeJSON.stringify(payload, { strict: true }));
}
