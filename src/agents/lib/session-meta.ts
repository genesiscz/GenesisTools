import { join } from "node:path";
import { isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { type JsonDocument, jsonDocument } from "@genesiscz/utils/storage/locked-document";
import type { SessionPaths } from "./types";

const META_LOCK_TIMEOUT_MS = 10_000;

export interface SessionMeta {
    debug: boolean;
}

/** `session-meta.json`: a file that does not parse throws; any other shape reads as the defaults. */
function metaDocument(paths: SessionPaths): JsonDocument<SessionMeta> {
    return jsonDocument<SessionMeta>({
        path: join(paths.sessionDir, "session-meta.json"),
        lockTimeoutMs: META_LOCK_TIMEOUT_MS,
        empty: () => ({ debug: false }),
        decode: (parsed) => ({ debug: isJsonObject(parsed) ? Boolean(parsed.debug) : false }),
        onUnreadable: "refuse",
        writes: "always",
        unreadableError: (problem) => (problem.cause instanceof Error ? problem.cause : problem),
    });
}

export function readSessionMeta(paths: SessionPaths): SessionMeta {
    return metaDocument(paths).read();
}

export async function updateSessionMeta(paths: SessionPaths, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    return metaDocument(paths).update((current) => {
        const next: SessionMeta = { ...current, ...patch };
        return { write: next, result: next };
    });
}
