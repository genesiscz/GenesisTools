import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPins } from "@app/claude/lib/cmux/pins";
import type { RestoreCandidate, SessionSnapshot, SnapshotEntry } from "@app/claude/lib/cmux/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

export function snapshotDir(): string {
    return join(new Storage("claude-code").getBaseDir(), "cmux-snapshots");
}

/** Filenames are user-supplied; keep them to one path segment of safe characters. */
export function isValidSnapshotName(name: string): boolean {
    return /^[\w.-]{1,64}$/.test(name);
}

export function snapshotPath(name: string): string {
    if (!isValidSnapshotName(name)) {
        throw new Error(`Invalid snapshot name "${name}" — use letters, digits, dot, dash or underscore.`);
    }

    return join(snapshotDir(), `${name}.json`);
}

export function toSnapshotEntries(candidates: RestoreCandidate[], workspaceIdBySession: Map<string, string | null>) {
    return candidates.map<SnapshotEntry>((candidate) => ({
        sessionId: candidate.sessionId,
        cwd: candidate.cwd,
        project: candidate.project,
        title: candidate.title,
        account: candidate.account,
        model: candidate.model,
        workspaceId: workspaceIdBySession.get(candidate.sessionId) ?? null,
    }));
}

export async function saveSnapshot(snapshot: SessionSnapshot): Promise<string> {
    const path = snapshotPath(snapshot.name);
    await mkdir(snapshotDir(), { recursive: true });
    await writeFile(path, `${SafeJSON.stringify(snapshot, null, 2)}\n`, "utf8");
    logger.debug({ path, entries: snapshot.entries.length }, "[claude-cmux] snapshot saved");

    return path;
}

export async function loadSnapshot(name: string): Promise<SessionSnapshot> {
    const path = snapshotPath(name);

    try {
        return SafeJSON.parse(await readFile(path, "utf8"), { strict: true }) as SessionSnapshot;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`No snapshot named "${name}".`);
        }

        throw err;
    }
}

export async function deleteSnapshot(name: string): Promise<void> {
    try {
        await unlink(snapshotPath(name));
    } catch (err) {
        // A typo deserves the same sentence `loadSnapshot` gives, not a Node stack trace.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`No snapshot named "${name}".`);
        }

        throw err;
    }
}

export interface SnapshotSummary {
    name: string;
    capturedAt: string;
    entries: number;
    projects: string[];
    bytes: number;
}

/** Saved snapshots, newest capture first. */
export async function listSnapshots(): Promise<SnapshotSummary[]> {
    let files: string[];

    try {
        files = await readdir(snapshotDir());
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn({ err }, "[claude-cmux] could not read the snapshot directory");
        }

        return [];
    }

    const summaries: SnapshotSummary[] = [];

    for (const file of files) {
        if (!file.endsWith(".json")) {
            continue;
        }

        const name = file.slice(0, -".json".length);

        try {
            const snapshot = await loadSnapshot(name);
            const info = await stat(join(snapshotDir(), file));
            summaries.push({
                name: snapshot.name || name,
                capturedAt: snapshot.capturedAt,
                entries: snapshot.entries.length,
                projects: [...new Set(snapshot.entries.map((e) => e.project))],
                bytes: info.size,
            });
        } catch (err) {
            logger.warn({ err, file }, "[claude-cmux] skipping an unreadable snapshot");
        }
    }

    return summaries.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

/**
 * Rebuild pickable candidates from a snapshot. A snapshot is a session LIST, so the
 * live metadata (last prompt, rate-limit death) is re-read from the pin journal and
 * the caller's candidate listing where available; anything missing falls back to what
 * was captured, which is enough to resume.
 */
export async function snapshotCandidates(
    snapshot: SessionSnapshot,
    live: RestoreCandidate[],
    opts: { readOnly?: boolean } = {}
): Promise<RestoreCandidate[]> {
    const liveById = new Map(live.map((candidate) => [candidate.sessionId, candidate]));
    const pins = await loadPins({ readOnly: opts.readOnly });

    return snapshot.entries.map((entry) => {
        const known = liveById.get(entry.sessionId);

        if (known) {
            return known;
        }

        const pin = pins.get(entry.sessionId);

        return {
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            project: entry.project,
            branch: null,
            title: entry.title,
            lastPrompt: null,
            limitStop: null,
            subdir: null,
            mtimeMs: Date.parse(snapshot.capturedAt) || 0,
            // `??` would fall through on a pin that says `null` (ran on the keychain),
            // resurrecting the account captured in the snapshot. A pin always wins whole.
            account: pin ? pin.account : entry.account,
            model: pin ? pin.model : entry.model,
            pinned: pin !== undefined || entry.account !== null,
        } satisfies RestoreCandidate;
    });
}

/** `2026-08-18-1930` — sortable, and unique enough for an unattended capture. */
export function defaultSnapshotName(now: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");

    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        `${pad(now.getHours())}${pad(now.getMinutes())}`,
    ].join("-");
}
