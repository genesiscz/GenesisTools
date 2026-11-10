import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfigStore, projectNameSchema } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { localStamp } from "./shared";

const { log } = logger.scoped("meetings-projects");

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The `sources.<id>.match` blocks of the raw config, each keyed by project. */
function sourceMatches(raw: Record<string, unknown>): Array<Record<string, unknown>> {
    return isObject(raw.sources)
        ? Object.values(raw.sources).flatMap((source) =>
              isObject(source) && isObject(source.match) ? [source.match] : []
          )
        : [];
}

export interface ProjectRename {
    from: string;
    to: string;
    /** The meetings whose project changed with it. */
    meetings: string[];
}

/**
 * Renames a project everywhere it is named: its block (dictionary, labels, match rules, export folder), its source
 * folder pairings, and the project of every meeting that has it. Refused when the new name is taken.
 */
export async function renameProject(options: {
    config: MeetingsConfigStore;
    store: MeetingStore;
    from: string;
    to: string;
}): Promise<ProjectRename> {
    const { config, store, from, to } = options;
    projectNameSchema.parse(to);

    // Both names are checked inside the config lock: another process may add `to` or rename `from` while this waits.
    await config.update((raw) => {
        const projects = isObject(raw.projects) ? raw.projects : {};

        if (projects[from] === undefined) {
            throw new Error(`No project ${from}. The known ones: ${Object.keys(projects).join(", ") || "none"}`);
        }

        if (projects[to] !== undefined) {
            throw new Error(
                `A project ${to} exists already; pick another name, or move its meetings and remove it first.`
            );
        }

        projects[to] = projects[from];
        delete projects[from];

        for (const match of sourceMatches(raw)) {
            if (match[from] !== undefined) {
                match[to] = match[from];
                delete match[from];
            }
        }
    });

    const meetings: string[] = [];

    // The list is a snapshot: a meeting moved to another project since keeps that project, and is not reported.
    for (const record of store.list().filter((one) => one.project === from)) {
        const renamed = await store.updateIf(
            record.id,
            { command: "projects rename", change: `project ${from} → ${to}` },
            (next) => {
                if (next.project !== from) {
                    return false;
                }

                next.project = to;
                return true;
            }
        );

        if (renamed) {
            meetings.push(record.id);
        }
    }

    log.debug({ from, to, meetings: meetings.length }, "project renamed");
    return { from, to, meetings };
}

/**
 * Writes a removal backup under a name no earlier backup has (`<base>.json`, then `<base>-2.json`, ...): the stamp has
 * minutes only, and a project removed twice in one minute must keep both removed blocks. Exclusive creation (`wx`)
 * refuses a name another process took meanwhile.
 */
function writeBackup(options: { folder: string; base: string; text: string }): string {
    mkdirSync(options.folder, { recursive: true });

    for (let n = 1; ; n += 1) {
        const path = join(options.folder, `${options.base}${n === 1 ? "" : `-${n}`}.json`);

        if (existsSync(path)) {
            continue;
        }

        try {
            writeFileSync(path, options.text, { flag: "wx" });
            return path;
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }

            log.debug({ path }, "backup name taken meanwhile; the next one is tried");
        }
    }
}

export interface ProjectRemoval {
    name: string;
    /** The meetings that had it and now have no project (`unassign`). */
    unassigned: string[];
    /** The removed block and its source pairings, as JSON, so nothing of it is lost. */
    backup: string;
}

/**
 * Removes a known project: its block and its source folder pairings, kept in a backup file first. A project that
 * meetings use is refused with their ids unless `unassign`, which leaves those meetings without a project.
 */
export async function removeProject(options: {
    config: MeetingsConfigStore;
    store: MeetingStore;
    name: string;
    unassign?: boolean;
    backupRoot?: string;
    now?: Date;
}): Promise<ProjectRemoval> {
    const { config, store, name } = options;
    const current = await config.read();

    if (!current.projects[name]) {
        throw new Error(`No project ${name}. The known ones: ${Object.keys(current.projects).join(", ") || "none"}`);
    }

    const using = store.list().filter((record) => record.project === name);

    if (using.length > 0 && !options.unassign) {
        throw new MeetingsConflictError(
            "project-in-use",
            `${using.length === 1 ? "1 meeting has" : `${using.length} meetings have`} the project ${name}: ${using.map((record) => record.id).join(", ")}. ` +
                "Rename it instead, or remove it with --unassign to leave them without a project."
        );
    }

    const stamp = localStamp(options.now ?? new Date());
    const folder = options.backupRoot ?? genesisToolsDir("backups", "meetings");
    let backup = "";
    let removed: unknown;
    const pairings: Record<string, unknown> = {};

    await config.update((raw) => {
        removed = isObject(raw.projects) ? raw.projects[name] : undefined;

        for (const [source, block] of Object.entries(isObject(raw.sources) ? raw.sources : {})) {
            if (isObject(block) && isObject(block.match) && block.match[name] !== undefined) {
                pairings[source] = block.match[name];
                delete block.match[name];
            }
        }

        backup = writeBackup({
            folder,
            base: `${stamp}-project-${name}`,
            text: `${SafeJSON.stringify({ project: name, block: removed ?? {}, sources: pairings }, null, 4)}\n`,
        });

        if (isObject(raw.projects)) {
            delete raw.projects[name];
        }
    });

    const unassigned: string[] = [];

    // `using` is a snapshot taken before the config lock: a meeting moved to another project since keeps it.
    for (const record of using) {
        const cleared = await store.updateIf(
            record.id,
            { command: "projects remove", change: `project ${name} removed` },
            (next) => {
                if (next.project !== name) {
                    return false;
                }

                next.project = undefined;
                return true;
            }
        );

        if (cleared) {
            unassigned.push(record.id);
        }
    }

    log.debug({ name, unassigned: unassigned.length, backup }, "project removed");
    return { name, unassigned, backup };
}
