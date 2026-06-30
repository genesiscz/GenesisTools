import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { withFileLock } from "@app/utils/storage";
import { atomicWriteFileSync } from "@app/utils/storage/storage";
import type { SessionPaths } from "./types";

const META_LOCK_TIMEOUT_MS = 10_000;

export interface SessionMeta {
    debug: boolean;
}

function metaPath(paths: SessionPaths): string {
    return join(paths.sessionDir, "session-meta.json");
}

export function readSessionMeta(paths: SessionPaths): SessionMeta {
    const path = metaPath(paths);

    if (!existsSync(path)) {
        return { debug: false };
    }

    const parsed = SafeJSON.parse(readFileSync(path, "utf8"));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { debug: false };
    }

    return { debug: Boolean((parsed as Record<string, unknown>).debug) };
}

export async function updateSessionMeta(paths: SessionPaths, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const path = metaPath(paths);
    return withFileLock(
        `${path}.lock`,
        async () => {
            const current = readSessionMeta(paths);
            const next: SessionMeta = { ...current, ...patch };
            atomicWriteFileSync(path, SafeJSON.stringify(next, { strict: true }));
            return next;
        },
        META_LOCK_TIMEOUT_MS
    );
}
