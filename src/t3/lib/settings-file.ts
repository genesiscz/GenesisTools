import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, isJsonObject } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { isOwnedInstanceId, type T3Instance } from "./instances";
import { detectIndentUnit, scanRoot, upsertMember } from "./json-splice";

const { log } = logger.scoped("t3:settings");

const INSTANCES_KEY = "providerInstances";
const LOCK_TIMEOUT_MS = 10_000;

/** T3 Code's server settings (`apps/server/src/serverSettings.ts` watches this file and reloads it). */
export function defaultSettingsPath(): string {
    return join(homedir(), ".t3", "userdata", "settings.json");
}

export function defaultBackupDir(): string {
    return toolDataDir("t3", "backups");
}

export interface SettingsSnapshot {
    /** The file that holds the bytes (a symlinked settings path resolved). */
    path: string;
    text: string;
    hash: string;
    data: Record<string, unknown>;
}

export class SettingsChangedError extends Error {
    constructor(path: string) {
        super(`${path} changed twice while tools t3 was writing it. Nothing was written; run the command again.`);
        this.name = "SettingsChangedError";
    }
}

function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Strict JSON only: T3 Code writes strict JSON, and the byte-preserving splice reads nothing else. */
export function parseSettingsText(text: string, path: string): Record<string, unknown> {
    let data: unknown;

    try {
        data = SafeJSON.parse(text, { strict: true });
    } catch (error) {
        throw new Error(`${path} is not strict JSON, so tools t3 will not edit it: ${String(error)}`);
    }

    if (!isJsonObject(data)) {
        throw new Error(`${path} does not hold a JSON object.`);
    }

    return data;
}

export function readSettings(settingsPath: string): SettingsSnapshot {
    if (!existsSync(settingsPath)) {
        throw new Error(`No T3 Code settings at ${settingsPath}. Start T3 Code once, or pass --settings <path>.`);
    }

    const path = realpathSync(settingsPath);
    const text = readFileSync(path, "utf8");
    log.debug({ settingsPath, path, bytes: text.length }, "settings read");

    return { path, text, hash: hashText(text), data: parseSettingsText(text, path) };
}

/** `providerInstances`, or an empty map when the file has none yet. */
export function providerInstances(data: Record<string, unknown>): Record<string, T3Instance> {
    const instances = data[INSTANCES_KEY];

    if (instances === undefined) {
        return {};
    }

    if (!isJsonObject(instances)) {
        throw new Error(`"${INSTANCES_KEY}" in T3 Code settings is not an object.`);
    }

    const result: Record<string, T3Instance> = {};

    for (const [id, value] of Object.entries(instances)) {
        if (isJsonObject(value) && typeof value.driver === "string") {
            result[id] = { ...value, driver: value.driver };
        }
    }

    return result;
}

/** One owned instance to write. `build` gets the instance as it is on disk now, so a re-merge sees fresh state. */
export interface InstanceUpsert {
    id: string;
    build(existing: T3Instance | undefined): T3Instance;
}

export interface UpsertPlan {
    text: string;
    /** Ids whose instance text changed. */
    changed: string[];
}

/** The new file text after every upsert. Bytes outside the changed instances stay identical. */
export function planUpserts(text: string, upserts: readonly InstanceUpsert[]): UpsertPlan {
    let next = text;
    const changed: string[] = [];
    const unit = detectIndentUnit(text);

    for (const upsert of upserts) {
        if (!isOwnedInstanceId(upsert.id)) {
            throw new Error(`Refusing to write instance "${upsert.id}": tools t3 owns only ids starting with "gt-".`);
        }

        const data = parseSettingsText(next, "settings");
        const existing = providerInstances(data)[upsert.id];
        const built = upsert.build(existing);

        if (existing !== undefined && Bun.deepEquals(existing, built, true)) {
            continue;
        }

        const root = scanRoot(next);
        const member = root.members.find((entry) => entry.key === INSTANCES_KEY);

        next = member
            ? upsertMember({ text: next, open: member.valueStart, depth: 1, key: upsert.id, value: built, unit })
            : upsertMember({
                  text: next,
                  open: root.open,
                  depth: 0,
                  key: INSTANCES_KEY,
                  value: { [upsert.id]: built },
                  unit,
              });
        changed.push(upsert.id);
    }

    return { text: next, changed };
}

export type UpsertStatus = "written" | "unchanged";

export interface UpsertResult {
    status: UpsertStatus;
    changed: string[];
    settingsPath: string;
    backupPath: string | null;
}

function backupStamp(now: Date): string {
    return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Writes owned instances into T3 Code's settings: merge only, under a lock, after a backup, atomically. The file is
 * re-read under the lock and its hash compared with the one the plan was built from. A change in between is
 * re-merged once; a second change refuses with `SettingsChangedError` and writes nothing.
 */
export async function upsertInstances(input: {
    settingsPath: string;
    backupDir: string;
    upserts: readonly InstanceUpsert[];
    now?: () => Date;
    /** Test seam: runs under the lock before each hash check, with the attempt number (0, then 1). */
    beforeCommit?: (attempt: number) => void;
}): Promise<UpsertResult> {
    let base = readSettings(input.settingsPath);
    let plan = planUpserts(base.text, input.upserts);
    const unchanged: UpsertResult = {
        status: "unchanged",
        changed: [],
        settingsPath: base.path,
        backupPath: null,
    };

    if (plan.changed.length === 0) {
        log.debug({ path: base.path, ids: input.upserts.map((upsert) => upsert.id) }, "settings already current");
        return unchanged;
    }

    return withFileLock(
        `${base.path}.gt-t3.lock`,
        async () => {
            for (let attempt = 0; ; attempt++) {
                input.beforeCommit?.(attempt);
                const current = readSettings(input.settingsPath);

                if (current.hash === base.hash) {
                    const now = input.now?.() ?? new Date();
                    const backupPath = join(input.backupDir, `settings-${backupStamp(now)}.json`);
                    atomicWriteFileSync(backupPath, current.text, { mode: 0o600 });
                    atomicWriteFileSync(current.path, plan.text);
                    log.debug({ path: current.path, backupPath, changed: plan.changed, attempt }, "settings written");

                    return { status: "written", changed: plan.changed, settingsPath: current.path, backupPath };
                }

                if (attempt >= 1) {
                    throw new SettingsChangedError(current.path);
                }

                log.warn({ path: current.path }, "settings changed since read; merging again");
                base = current;
                plan = planUpserts(current.text, input.upserts);

                if (plan.changed.length === 0) {
                    return unchanged;
                }
            }
        },
        LOCK_TIMEOUT_MS
    );
}
