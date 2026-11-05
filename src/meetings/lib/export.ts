import { createHash } from "node:crypto";
import {
    existsSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    type Stats,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExportIfEdited, MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { groupTurns } from "@genesiscz/utils/transcribe/render";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { playLinksFor } from "./link";
import { OpenedMeeting } from "./opened-meeting";
import { type CorrectedTranscript, correctTranscript } from "./transcript-corrections";
import { transcriptDocument } from "./transcript-document";

export interface TranscriptMarkdownOptions {
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    config: MeetingsConfig;
    withSuggested?: boolean;
    dictionary?: boolean;
    frontmatter: boolean;
    timestamps: boolean;
    playLinks: boolean;
}

/**
 * The meeting's transcript as markdown (json2md frontmatter and body, `transcriptDocument`), with the renames, the
 * confirmed items and the dictionary applied. `warning` says why play links were left out, when they were.
 */
export function transcriptMarkdown(options: TranscriptMarkdownOptions): {
    markdown: string;
    applied: CorrectedTranscript;
    warning?: string;
} {
    const { record } = options;
    const applied = correctTranscript({
        record,
        transcript: options.transcript,
        config: options.config,
        format: "md",
        ...(options.withSuggested !== undefined ? { withSuggested: options.withSuggested } : {}),
        ...(options.dictionary !== undefined ? { dictionary: options.dictionary } : {}),
    });
    // The links are written even while the router preset is off; the warning says how to make them open.
    const links = options.playLinks ? playLinksFor(record.id) : undefined;
    const markdown = transcriptDocument({
        record,
        turns: groupTurns(applied.entries),
        speakers: applied.speakers,
        unattributed: applied.unattributed,
        frontmatter: options.frontmatter,
        timestamps: options.timestamps || options.playLinks,
        ...(links ? { playLink: links.link } : {}),
    });

    return { markdown, applied, ...(links?.warning ? { warning: links.warning } : {}) };
}

/** What an export does: a new note, its own untouched note again, a note beside an edited one, or nothing. */
export type ExportAction = "create" | "replace" | "beside" | "refuse";

export interface ExportResult {
    meeting: string;
    project?: string;
    folder: string;
    path: string;
    bytes: number;
    /** A file of the same meeting was there and is replaced. */
    replaced: boolean;
    action: ExportAction;
    /** The edited note an export left as it was (`beside`), or would leave (a dry run). */
    kept?: string;
    written: boolean;
    warning?: string;
}

/** The folder a meeting's export goes to: `to` when given, else its project's `export.folder`. */
export function exportFolder(config: MeetingsConfig, record: MeetingRecord, to?: string): string | undefined {
    if (to) {
        return isAbsolute(to) ? to : resolve(to);
    }

    return record.project ? config.projects[record.project]?.export?.folder : undefined;
}

function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

interface ExportPlan {
    action: ExportAction;
    path: string;
    kept?: string;
}

/**
 * Decides where the note goes. The target must be a plain file in the folder (never a symlink, which would carry the
 * write outside it). A file this meeting's last export wrote and nobody changed is replaced; any other file is an
 * edited note, and `ifEdited` decides.
 */
function planExport(options: {
    folder: string;
    record: MeetingRecord;
    ifEdited: ExportIfEdited;
    now: Date;
}): ExportPlan {
    const { folder, record } = options;
    const name = `${record.id}.md`;

    if (basename(name) !== name || name.startsWith(".")) {
        throw new MeetingsConflictError("export-unsafe-path", `${record.id} is not a file name an export can write`);
    }

    const target = join(folder, name);
    let stat: Stats;

    try {
        stat = lstatSync(target);
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return { action: "create", path: target };
        }

        throw err;
    }

    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new MeetingsConflictError(
            "export-unsafe-path",
            `${target} is ${stat.isSymbolicLink() ? "a symlink" : "not a plain file"}; an export writes only plain files inside ${folder}. Move it away, or export with --to <another folder>`
        );
    }

    const known = record.exports?.find((entry) => entry.path === target);

    if (known && known.sha256 === sha256(readFileSync(target))) {
        return { action: "replace", path: target };
    }

    if (options.ifEdited === "replace") {
        return { action: "replace", path: target };
    }

    if (options.ifEdited === "refuse") {
        return { action: "refuse", path: target, kept: target };
    }

    return { action: "beside", path: besidePath(folder, record.id, options.now), kept: target };
}

/** `<id>.export-2026-11-05T0812.md`, then `-2`, `-3` … while one exists. */
function besidePath(folder: string, id: string, now: Date): string {
    const stamp = now.toISOString().slice(0, 16).replace(":", "");

    for (let n = 1; ; n += 1) {
        const path = join(folder, `${id}.export-${stamp}${n === 1 ? "" : `-${n}`}.md`);

        if (!existsSync(path) && !isLink(path)) {
            return path;
        }
    }
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * Writes the note through a temporary file in the same folder. A new note is linked in, which fails when a file
 * appeared at its name meanwhile; a replaced one is renamed over its directory entry, which never follows a link.
 */
function writeNote(plan: ExportPlan, markdown: string): void {
    const tmp = join(dirname(plan.path), `.${basename(plan.path)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, markdown, { flag: "wx" });

    try {
        if (plan.action === "replace") {
            renameSync(tmp, plan.path);
            return;
        }

        try {
            linkSync(tmp, plan.path);
        } catch (err) {
            if (err instanceof Error && "code" in err && err.code === "EEXIST") {
                throw new MeetingsConflictError(
                    "export-edited",
                    `${plan.path} appeared while the export ran; nothing was written. Export again`
                );
            }

            throw err;
        }
    } finally {
        if (existsSync(tmp)) {
            unlinkSync(tmp);
        }
    }
}

/**
 * Writes the polished transcript (play links, dictionary, confirmed items) as `<folder>/<meeting id>.md`. The meeting
 * exported again replaces its own note while nobody edited it; an edited note is kept, and `ifEdited` (else the
 * config's `global.export.ifEdited`) says whether the new note goes beside it, nothing is written, or the edits go.
 * `dryRun` answers where it would go and how big it is, and writes nothing.
 */
export async function exportMeeting(options: {
    store: MeetingStore;
    record: MeetingRecord;
    config: MeetingsConfig;
    to?: string;
    dryRun?: boolean;
    ifEdited?: ExportIfEdited;
    transcript?: TranscriptEntry[];
}): Promise<ExportResult> {
    const { record, config, store } = options;
    const folder = exportFolder(config, record, options.to);

    if (!folder) {
        throw new Error(
            record.project
                ? `project ${record.project} has no export folder: give --to <folder>, or set projects.${record.project}.export.folder`
                : `${record.id} has no project: give --to <folder>, or set its project first`
        );
    }

    const transcript = options.transcript ?? (await OpenedMeeting.of(store, record).meeting()).transcript;
    const { markdown, warning } = transcriptMarkdown({
        record,
        transcript,
        config,
        frontmatter: true,
        timestamps: true,
        playLinks: true,
    });
    const ifEdited = options.ifEdited ?? config.global.export.ifEdited;
    const now = new Date();
    // The plan works on the folder's real path; the answer names the files under the folder as it was given.
    const shown = (path: string) => join(folder, basename(path));
    const result = (plan: ExportPlan, written: boolean): ExportResult => ({
        meeting: record.id,
        ...(record.project ? { project: record.project } : {}),
        folder,
        path: shown(plan.path),
        bytes: Buffer.byteLength(markdown),
        replaced: plan.action === "replace",
        action: plan.action,
        ...(plan.kept ? { kept: shown(plan.kept) } : {}),
        written,
        ...(warning ? { warning } : {}),
    });

    if (options.dryRun) {
        const real = existsSync(folder) ? realpathSync(folder) : folder;
        return result(planExport({ folder: real, record: store.read(record.id) ?? record, ifEdited, now }), false);
    }

    mkdirSync(folder, { recursive: true });
    const real = realpathSync(folder);
    let done: ExportResult | undefined;

    // Under the record's lock: two exports of one meeting cannot both decide on the same file.
    await store.update(record.id, { command: "export", change: `${record.id}.md in ${folder}` }, (current) => {
        const plan = planExport({ folder: real, record: current, ifEdited, now });

        if (plan.action === "refuse") {
            throw new MeetingsConflictError(
                "export-edited",
                `${plan.path} holds edits the last export did not write; nothing was written. Keep them and write the new note beside it: --if-edited beside; overwrite them: --if-edited replace`
            );
        }

        writeNote(plan, markdown);
        current.exports = [
            ...(current.exports ?? []).filter((entry) => entry.path !== plan.path),
            { path: plan.path, sha256: sha256(markdown), at: now.toISOString() },
        ];
        done = result(plan, true);
    });

    return done!;
}
