import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfigStore, projectNameSchema } from "@genesiscz/utils/meetings/config";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

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
    const current = await config.read();

    if (!current.projects[from]) {
        throw new Error(`No project ${from}. The known ones: ${Object.keys(current.projects).join(", ") || "none"}`);
    }

    if (current.projects[to]) {
        throw new Error(`A project ${to} exists already; pick another name, or move its meetings and remove it first.`);
    }

    await config.update((raw) => {
        if (isObject(raw.projects)) {
            raw.projects[to] = raw.projects[from] ?? {};
            delete raw.projects[from];
        }

        for (const match of sourceMatches(raw)) {
            if (match[from] !== undefined) {
                match[to] = match[from];
                delete match[from];
            }
        }
    });

    const meetings: string[] = [];

    for (const record of store.list().filter((one) => one.project === from)) {
        await store.update(record.id, { command: "projects rename", change: `project ${from} → ${to}` }, (next) => {
            next.project = to;
        });
        meetings.push(record.id);
    }

    log.debug({ from, to, meetings: meetings.length }, "project renamed");
    return { from, to, meetings };
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
        throw new Error(
            `${using.length === 1 ? "1 meeting has" : `${using.length} meetings have`} the project ${name}: ${using.map((record) => record.id).join(", ")}. ` +
                "Rename it instead, or remove it with --unassign to leave them without a project."
        );
    }

    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const folder = options.backupRoot ?? genesisToolsDir("backups", "meetings");
    const backup = join(folder, `${stamp}-project-${name}.json`);
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

        mkdirSync(folder, { recursive: true });
        writeFileSync(
            backup,
            `${SafeJSON.stringify({ project: name, block: removed ?? {}, sources: pairings }, null, 4)}\n`
        );

        if (isObject(raw.projects)) {
            delete raw.projects[name];
        }
    });

    const unassigned: string[] = [];

    for (const record of using) {
        await store.update(record.id, { command: "projects remove", change: `project ${name} removed` }, (next) => {
            next.project = undefined;
        });
        unassigned.push(record.id);
    }

    log.debug({ name, unassigned: unassigned.length, backup }, "project removed");
    return { name, unassigned, backup };
}
