import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingsConfigStore, projectNameSchema } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type AssignInbox, decisionInbox } from "./assign-inbox";
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

/** A folder step (waiting or asked) that would pair a folder with the project once it is answered. */
function folderStepNames(record: MeetingRecord, project: string): boolean {
    return record.assign?.folder?.project === project;
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

    for (const record of store.list().filter((one) => one.project === from || folderStepNames(one, from))) {
        let projectChanged = false;
        await store.updateIf(record.id, { command: "projects rename", change: `project ${from} → ${to}` }, (next) => {
            if (next.project !== from && !folderStepNames(next, from)) {
                return false;
            }

            if (next.project === from) {
                next.project = to;
                projectChanged = true;
            }

            if (next.assign?.folder?.project === from) {
                next.assign.folder.project = to;
            }
            return true;
        });

        if (projectChanged) {
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

/** The folder removal backups go to, unless a caller names its own. */
function backupFolder(root?: string): string {
    return root ?? genesisToolsDir("backups", "meetings");
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
    /** Where a waiting folder question is withdrawn; the decision inbox unless a test passes its own. */
    inbox?: Pick<AssignInbox, "cancel">;
}): Promise<ProjectRemoval> {
    const { config, store, name } = options;
    const inbox = options.inbox ?? decisionInbox;
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
    const folder = backupFolder(options.backupRoot);
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
            // `meetings`: the ones that had it, so `restoreProject` can give it back to those still without one.
            text: `${SafeJSON.stringify(
                {
                    project: name,
                    block: removed ?? {},
                    sources: pairings,
                    meetings: using.map((record) => record.id),
                },
                null,
                4
            )}\n`,
        });

        if (isObject(raw.projects)) {
            delete raw.projects[name];
        }
    });

    const unassigned: string[] = [];

    for (const record of store.list().filter((one) => one.project === name || folderStepNames(one, name))) {
        let withdrawn: string | undefined;
        let projectChanged = false;
        await store.updateIf(record.id, { command: "projects remove", change: `project ${name} removed` }, (next) => {
            if (next.project !== name && !folderStepNames(next, name)) {
                return false;
            }

            if (next.project === name) {
                next.project = undefined;
                projectChanged = true;
            }

            if (next.assign?.folder?.project === name) {
                withdrawn = next.assign.folder.formId;
                delete next.assign.folder;
            }
            return true;
        });

        // The posted folder question names a project that is gone, and its answer would do nothing: withdraw it.
        if (withdrawn) {
            const formId = withdrawn;
            await inbox.cancel(formId).catch((err: unknown) => {
                log.warn({ err, meeting: record.id, formId }, "the folder question could not be withdrawn");
            });
        }

        if (projectChanged) {
            unassigned.push(record.id);
        }
    }

    log.debug({ name, unassigned: unassigned.length, backup }, "project removed");
    return { name, unassigned, backup };
}

/** A removal backup as `removeProject` writes it; one written before `meetings` existed restores no meeting. */
const projectBackupSchema = z.object({
    project: z.string().min(1),
    block: z.record(z.string(), z.unknown()),
    sources: z.record(z.string(), z.unknown()).default({}),
    meetings: z.array(z.string()).default([]),
});

export interface ProjectRestore {
    name: string;
    /** The meetings that have the project again: those it was removed from that still have none. */
    meetings: string[];
    /** The sources whose folder pairing came back; a source whose pairing was made again keeps the newer one. */
    sources: string[];
}

/**
 * The Undo of `removeProject`: the block from its backup comes back, with the source pairings and the project of the
 * meetings it left without one. Refused when a project of that name exists again; a meeting given another project
 * since keeps it. Only a backup in the removal backups folder is read.
 */
export async function restoreProject(options: {
    config: MeetingsConfigStore;
    store: MeetingStore;
    backup: string;
    backupRoot?: string;
}): Promise<ProjectRestore> {
    const { config, store } = options;
    const folder = backupFolder(options.backupRoot);
    const path = existsSync(options.backup) ? realpathSync(options.backup) : options.backup;
    const inside = existsSync(folder) ? relative(realpathSync(folder), path) : "..";

    if (!existsSync(path) || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`${options.backup} is not a project removal backup in ${folder}`);
    }

    const saved = projectBackupSchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
    const name = projectNameSchema.parse(saved.project);
    const sources: string[] = [];

    await config.update((raw) => {
        const projects = isObject(raw.projects) ? raw.projects : {};

        if (projects[name] !== undefined) {
            throw new Error(`A project ${name} exists again; rename it or remove it first to restore the removed one.`);
        }

        projects[name] = saved.block;
        raw.projects = projects;

        for (const [source, pairing] of Object.entries(saved.sources)) {
            const block = isObject(raw.sources) ? raw.sources[source] : undefined;

            if (!isObject(block)) {
                log.debug({ source, name }, "the source is not configured any more; its pairing stays in the backup");
                continue;
            }

            const match = isObject(block.match) ? block.match : {};

            if (match[name] === undefined) {
                match[name] = pairing;
                block.match = match;
                sources.push(source);
            }
        }
    });

    const meetings: string[] = [];

    for (const id of saved.meetings.filter((one) => store.read(one))) {
        const changed = await store.updateIf(
            id,
            { command: "projects restore", change: `project ${name} restored` },
            (next) => {
                if (next.project !== undefined) {
                    return false;
                }

                next.project = name;
                return true;
            }
        );

        if (changed) {
            meetings.push(id);
        }
    }

    log.debug({ name, meetings: meetings.length, sources: sources.length, backup: path }, "project restored");
    return { name, meetings, sources };
}
