import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import type { WidgetRoster } from "./roster-index";
import { realWidgetSources, type WidgetSources } from "./snapshot";
import { widgetRoot } from "./storage";

/**
 * The resident watch rewrites the cache after every roster run that changed it, and an unchanged one at least every
 * 55 s, so an older file means its writer stopped or hangs.
 */
export const WIDGET_ROSTER_CACHE_MAX_AGE_MS = 90_000;

/**
 * How often the watch rewrites a roster that did not change, so a reader can still tell a live writer from a stopped
 * one: the safety refresh reads the roster every 30 s, so an unchanged roster is written every second read, well
 * inside `WIDGET_ROSTER_CACHE_MAX_AGE_MS`. A changed roster is written at once.
 */
export const WIDGET_ROSTER_CACHE_HEARTBEAT_MS = 55_000;

/** What a roster shows, without the time it was read: two reads that found the same sessions and agents are equal. */
export function widgetRosterFingerprint(roster: WidgetRoster): string {
    const agents = { ...roster.agents, generatedAt: "" };
    return Bun.hash(SafeJSON.stringify({ rows: roster.rows, agents }, { strict: true })).toString(36);
}

/**
 * How old a cache the watch still shows at start-up, before its own first read lands (2 s cold at load 75, ~10 s
 * under heavy load). Older than this, the list would mislead more than the "Connecting" placeholder does.
 */
export const WIDGET_ROSTER_WARM_START_MAX_AGE_MS = 24 * 3_600_000;

interface WidgetRosterCacheFile extends WidgetRoster {
    version: 1;
    pid: number;
    writtenAt: number;
}

export function widgetRosterCachePath(root?: string): string {
    return join(widgetRoot(root), "roster-cache.json");
}

function isRosterCache(value: unknown): value is WidgetRosterCacheFile {
    if (!value || typeof value !== "object") {
        return false;
    }

    const file: Partial<Record<keyof WidgetRosterCacheFile, unknown>> = value;
    const agents = file.agents;
    return (
        file.version === 1 &&
        typeof file.pid === "number" &&
        typeof file.writtenAt === "number" &&
        Array.isArray(file.rows) &&
        !!agents &&
        typeof agents === "object" &&
        "parents" in agents &&
        Array.isArray(agents.parents) &&
        "orphans" in agents &&
        Array.isArray(agents.orphans)
    );
}

/** The pid comes from the cache file, so it goes through the shared classifier (EPERM counts as alive there too). */
function processAlive(pid: number): boolean {
    return classifyPid(pid).status !== "dead";
}

/** Written by the resident watch after each completed roster run: the roster it shows, for one-shot readers. */
export async function writeWidgetRosterCache({
    root,
    roster,
    now = Date.now(),
}: {
    root?: string;
    roster: WidgetRoster;
    now?: number;
}): Promise<void> {
    const path = widgetRosterCachePath(root);
    const file: WidgetRosterCacheFile = { version: 1, pid: process.pid, writtenAt: now, ...roster };
    // An earlier write's failure was already reported to its own caller; this one goes ahead either way.
    const write = (pendingRosterWrites.get(path) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => replaceRosterCache(path, file));
    pendingRosterWrites.set(path, write);

    try {
        await write;
    } finally {
        if (pendingRosterWrites.get(path) === write) {
            pendingRosterWrites.delete(path);
        }
    }
}

/**
 * Writes to one cache file run one at a time, in the order they were asked for: an older roster must never replace
 * a newer one. Every roster run asks for a write, often before the last finished.
 */
const pendingRosterWrites = new Map<string, Promise<void>>();

function replaceRosterCache(path: string, file: WidgetRosterCacheFile): void {
    atomicWriteFileSync(path, SafeJSON.stringify(file, { strict: true }));
}

/** The watch's roster when its writer is alive and wrote it recently; undefined sends the caller to the index. */
export async function readWidgetRosterCache({
    root,
    now = Date.now(),
    maxAgeMs = WIDGET_ROSTER_CACHE_MAX_AGE_MS,
    alive = processAlive,
}: {
    root?: string;
    now?: number;
    maxAgeMs?: number;
    alive?: (pid: number) => boolean;
} = {}): Promise<WidgetRoster | undefined> {
    const path = widgetRosterCachePath(root);
    const file = Bun.file(path);
    if (!(await file.exists())) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(await file.text(), { strict: true });
        if (!isRosterCache(parsed)) {
            logger.debug({ path }, "Widget roster cache has an unknown shape; reading the index");
            return undefined;
        }

        const age = now - parsed.writtenAt;
        if (age < 0 || age > maxAgeMs || !alive(parsed.pid)) {
            logger.debug({ path, age, pid: parsed.pid }, "Widget roster cache is stale; reading the index");
            return undefined;
        }

        return { rows: parsed.rows, agents: parsed.agents };
    } catch (error) {
        logger.debug({ error, path }, "Widget roster cache unreadable; reading the index");
        return undefined;
    }
}

/**
 * The roster the previous watch of this state root last showed, for the first snapshot of a new watch. Its writer is
 * not asked to be alive: the new watch holds the root's lock, so the writer is that previous watch, now gone.
 */
export function readWarmStartRoster(root?: string): Promise<WidgetRoster | undefined> {
    return readWidgetRosterCache({ root, maxAgeMs: WIDGET_ROSTER_WARM_START_MAX_AGE_MS, alive: () => true });
}

/**
 * The sources a one-shot snapshot reads: the running watch's roster when it has a fresh one, so the settings page
 * does not rebuild the agents tree cold (1.8 s of CPU), and the index otherwise. Everything else is read fresh.
 */
export async function oneShotWidgetSources(root?: string): Promise<WidgetSources> {
    const roster = await readWidgetRosterCache({ root });
    if (!roster) {
        return realWidgetSources;
    }

    return { ...realWidgetSources, sessions: async () => roster.rows, agents: async () => roster.agents };
}
