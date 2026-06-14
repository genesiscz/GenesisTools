import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage/storage";
import type { Mapping, RedactType, SessionRecord } from "./types";

const SESSIONS_SUBDIR = "sessions";
const TTL = "365 days";

function storage(): Storage {
    return new Storage("redact");
}

export interface BuildSessionArgs {
    mapping: Mapping;
    now: Date;
    types: readonly RedactType[];
}

export function buildSession({ mapping, now, types }: BuildSessionArgs): SessionRecord {
    return { createdAt: now.toISOString(), types, mapping };
}

function sessionRelPath(createdAt: string): string {
    const stamp = createdAt.replace(/[:.]/g, "-");
    return `${SESSIONS_SUBDIR}/${stamp}.json`;
}

export async function saveSession(record: SessionRecord): Promise<string> {
    const store = storage();
    const rel = sessionRelPath(record.createdAt);
    await store.putRawFile(rel, SafeJSON.stringify(record, null, 2), TTL);
    const abs = `${store.getCacheDir()}/${rel}`;
    logger.debug(`redact: saved session ${abs} (${Object.keys(record.mapping).length} placeholders)`);
    return abs;
}

export async function loadLatestSession(): Promise<SessionRecord | null> {
    const store = storage();
    const files = (await store.listCacheFiles(false)).filter((f) => f.startsWith(`${SESSIONS_SUBDIR}/`)).sort();
    const latest = files.at(-1);
    if (latest === undefined) {
        return null;
    }

    const content = await store.getRawFile(latest, TTL);
    if (content === null) {
        return null;
    }

    const record: SessionRecord = SafeJSON.parse(content);
    return record;
}

export async function loadMapFile(path: string): Promise<Mapping> {
    const content = await Bun.file(path).text();
    const parsed: unknown = SafeJSON.parse(content, { strict: true });
    const candidate: unknown =
        parsed !== null && typeof parsed === "object" && "mapping" in parsed
            ? (parsed as { mapping: unknown }).mapping
            : parsed;

    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Invalid mapping file: expected an object mapping placeholders to strings.");
    }

    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.some(([, value]) => typeof value !== "string")) {
        throw new Error("Invalid mapping file: all mapping values must be strings.");
    }

    return Object.fromEntries(entries) as Mapping;
}
