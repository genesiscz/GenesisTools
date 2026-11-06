import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cloneOrCopy } from "@genesiscz/utils/fs/clone";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    type MeetingContext,
    type MeetingRecord,
    type MeetingStore,
    nextId,
    type RecordingBlock,
} from "@genesiscz/utils/meetings/record";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { type AssignInbox, decisionInbox } from "./assign-inbox";
import { readRecorderState } from "./recorder-shared";
import { sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-merge");

/** The one field a merge sorts rows by: `ocr.jsonl` and `audio.jsonl` rows both carry their wall time. */
const rowTime = z.looseObject({ at: z.string().optional() });

/** The title `record start` gives a meeting without a calendar entry (`commands/record.ts`). */
const GENERATED_TITLE = /^Meeting \d{1,2}:\d{2}$/;

/** Files a merge moves from one meeting folder into the other, each with its rows. */
const ROW_FILES = ["ocr.jsonl", "audio.jsonl"] as const;
const MOVED_FOLDERS = ["frames", "audio"] as const;
/**
 * Files made from the frames (the editor project, the recorder's last state). They describe one record's frames only,
 * so the merged record would show a part of its recording; they go into the backup, and opening the editor or the next
 * recorder start makes them again.
 */
const DERIVED_FILES = ["recording.json", "recorder-last.json", "proxy.mp4", "proxy.transcript.json"] as const;

export interface MergeRequest {
    store: MeetingStore;
    /** The record that goes away: its frames, sound, rows, context and history move into `intoId`. */
    fromId: string;
    intoId: string;
    /** Say what would happen, change nothing. */
    dryRun?: boolean;
    /** Where the before-state goes; the GenesisTools backups folder by default. */
    backupRoot?: string;
    /** The decision inbox, for the open project question of the record that goes away. */
    inbox?: AssignInbox;
    now?: Date;
}

export interface MergeResult {
    from: string;
    into: string;
    dryRun: boolean;
    /** Where both records' folders were cloned before anything changed, and the restore steps. */
    backup?: string;
    moved: { frames: number; audio: number; rows: number; context: number; history: number };
    /** Derived files moved aside into the backup. */
    derived: string[];
    start: string;
    end?: string;
    /** The open inbox question of the record that went away, withdrawn. */
    withdrawn?: string;
}

/** Why two records cannot become one; each a sentence for the user. */
function refusal(from: MeetingRecord, into: MeetingRecord, store: MeetingStore): string | undefined {
    if (from.id === into.id) {
        return `${from.id} is the same record; name two.`;
    }

    const fromRef = sourceRefOf(from);
    const intoRef = sourceRefOf(into);

    if (
        fromRef &&
        intoRef &&
        (fromRef.sourceId !== intoRef.sourceId || fromRef.sourceMeetingId !== intoRef.sourceMeetingId)
    ) {
        return `${from.id} and ${into.id} hold different source meetings (${fromRef.sourceId}:${fromRef.sourceMeetingId}, ${intoRef.sourceId}:${intoRef.sourceMeetingId}); only records of one call merge.`;
    }

    if (from.items.length > 0) {
        return `${from.id} has ${from.items.length} items; decide or reject them there first, or merge the other way.`;
    }

    const recorder = readRecorderState(store);

    if (recorder.running && (recorder.state?.meetingId === from.id || recorder.state?.meetingId === into.id)) {
        return `${recorder.state?.meetingId} is being recorded now; stop the recording first.`;
    }

    for (const name of MOVED_FOLDERS) {
        const source = join(store.folder(from.id), name);

        if (!existsSync(source)) {
            continue;
        }

        const taken = readdirSync(source).filter((file) => existsSync(join(store.folder(into.id), name, file)));

        if (taken.length > 0) {
            return `${name}/${taken[0]} is in both records (${taken.length} names collide); nothing was moved.`;
        }
    }

    return undefined;
}

/** A clone of every file under `source` at `destination` (a copy where the volume cannot clone). */
function cloneTree(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true });

    for (const name of readdirSync(source)) {
        const from = join(source, name);
        const to = join(destination, name);
        const stat = lstatSync(from);

        if (stat.isDirectory()) {
            cloneTree(from, to);
        } else if (stat.isFile()) {
            cloneOrCopy({ source: from, destination: to, mode: stat.mode & 0o777, mayCopy: true });
        } else {
            log.warn({ path: from }, "not a file or folder; left out of the merge backup");
        }
    }
}

/** `YYYY-MM-DD-HHMM` in local time, for a backup folder's name. */
function localStamp(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function earliest(times: Array<string | undefined>): string | undefined {
    return times.filter((time): time is string => Boolean(time)).sort()[0];
}

function latest(times: Array<string | undefined>): string | undefined {
    return times
        .filter((time): time is string => Boolean(time))
        .sort()
        .at(-1);
}

/** One recording block for the frames of both records: spans and displays of both, counts summed. */
export function mergedRecording(
    into: RecordingBlock | undefined,
    from: RecordingBlock | undefined
): RecordingBlock | undefined {
    if (!into || !from) {
        return into ?? from;
    }

    const later =
        Date.parse(into.stoppedAt ?? into.startedAt ?? "") >= Date.parse(from.stoppedAt ?? from.startedAt ?? "")
            ? into
            : from;
    const displays = new Map<number, { id: number; name: string; frames: number }>();

    for (const display of [...(from.displays ?? []), ...(into.displays ?? [])]) {
        const known = displays.get(display.id);
        displays.set(display.id, { id: display.id, name: display.name, frames: (known?.frames ?? 0) + display.frames });
    }

    const byTime = <T extends { from: string }>(spans: T[]) =>
        spans.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
    const startedAt = earliest([into.startedAt, from.startedAt]);
    const stoppedAt = latest([into.stoppedAt, from.stoppedAt]);
    const clock = into.clock ?? from.clock;
    const markers = [...(from.markers ?? []), ...(into.markers ?? [])].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at)
    );
    const warning = later.warning;
    return {
        ...from,
        ...into,
        ...(startedAt ? { startedAt } : {}),
        ...(stoppedAt ? { stoppedAt } : {}),
        status: later.status,
        stopReason: later.stopReason,
        ...(warning ? { warning } : { warning: undefined }),
        displays: [...displays.values()].sort((a, b) => a.id - b.id),
        frames: (into.frames ?? 0) + (from.frames ?? 0),
        bytes: (into.bytes ?? 0) + (from.bytes ?? 0),
        spans: byTime([...(from.spans ?? []), ...(into.spans ?? [])]),
        displaySpans: byTime([...(from.displaySpans ?? []), ...(into.displaySpans ?? [])]),
        ...(clock ? { clock } : {}),
        ...(markers.length > 0 ? { markers } : {}),
    };
}

/** The rows of both files in time order (`at`), so `screen` and the timeline read one recording. */
function mergeRows(intoFile: string, fromFile: string): number {
    if (!existsSync(fromFile)) {
        return 0;
    }

    const rows = (path: string) =>
        existsSync(path)
            ? readFileSync(path, "utf8")
                  .split("\n")
                  .filter((line) => line.trim() !== "")
            : [];
    const added = rows(fromFile);
    const all = [...rows(intoFile), ...added].map((line, index) => ({
        line,
        index,
        at: Date.parse(rowTime.safeParse(SafeJSON.parse(line, { strict: true })).data?.at ?? ""),
    }));
    all.sort((a, b) => a.at - b.at || a.index - b.index);
    writeFileSync(`${intoFile}.merge-tmp`, `${all.map((row) => row.line).join("\n")}\n`);
    renameSync(`${intoFile}.merge-tmp`, intoFile);
    return added.length;
}

function backupReadme(options: { from: MeetingRecord; into: MeetingRecord; root: string; folder: string }): string {
    const { from, into, root, folder } = options;
    return [
        `# Merge of ${from.id} into ${into.id}`,
        "",
        `Written by \`tools meetings merge\` at ${localStamp(new Date())} (local time).`,
        "",
        `- \`before/${from.id}/\` and \`before/${into.id}/\`: clones of both meeting folders before the merge.`,
        `- \`moved/${from.id}/\`: what was left of ${from.id} after its frames, sound and rows moved.`,
        `- \`derived/\`: the editor and recorder files of ${into.id}, made again on the next editor open.`,
        "",
        "Restore (both records as they were):",
        "",
        "```sh",
        `tools rm ${join(root, into.id)} ${join(root, from.id)}`,
        `cp -cR ${join(folder, "before", into.id)} ${join(root, into.id)}`,
        `cp -cR ${join(folder, "before", from.id)} ${join(root, from.id)}`,
        "```",
        "",
        `After a finished merge the second path of \`tools rm\` is gone already, and \`tools rm\` says so.`,
        "",
    ].join("\n");
}

/**
 * Makes two records of one call one record: `fromId` goes into `intoId`. Both folders are cloned into a backup first;
 * then the frames, sound and their rows move, the recording blocks, context, labels, participants and history merge,
 * the start becomes the earlier one, the derived editor files move aside, the record that went away moves into the
 * backup, and its open project question in the inbox is withdrawn. Nothing is deleted.
 */
export async function mergeMeetings(request: MergeRequest): Promise<MergeResult> {
    const { store } = request;
    const from = store.resolve(request.fromId);
    const into = store.resolve(request.intoId);

    if (!from || !into) {
        throw new Error(`No meeting "${!from ? request.fromId : request.intoId}".`);
    }

    const refused = refusal(from, into, store);

    if (refused) {
        throw new Error(refused);
    }

    const fromFolder = store.folder(from.id);
    const intoFolder = store.folder(into.id);
    const count = (name: string) =>
        existsSync(join(fromFolder, name)) ? readdirSync(join(fromFolder, name)).length : 0;
    const rowCount = ROW_FILES.reduce((total, name) => {
        const path = join(fromFolder, name);
        return (
            total +
            (existsSync(path)
                ? readFileSync(path, "utf8")
                      .split("\n")
                      .filter((line) => line.trim()).length
                : 0)
        );
    }, 0);
    const start = earliest([from.start, into.start]) ?? into.start;
    const end = latest([from.end, into.end]);
    const derived = DERIVED_FILES.filter((name) => existsSync(join(intoFolder, name)));
    const pending = from.assign?.ask?.outcome === "pending" ? from.assign.ask.formId : undefined;
    const result: MergeResult = {
        from: from.id,
        into: into.id,
        dryRun: Boolean(request.dryRun),
        moved: {
            frames: count("frames"),
            audio: count("audio"),
            rows: rowCount,
            context: from.context.length,
            history: from.history.length,
        },
        derived: [...derived],
        start,
        ...(end ? { end } : {}),
        ...(pending ? { withdrawn: pending } : {}),
    };

    if (request.dryRun) {
        return result;
    }

    const backup = join(
        request.backupRoot ?? genesisToolsDir("backups", "meetings"),
        `${localStamp(request.now ?? new Date())}-merge-${from.id}`
    );

    if (existsSync(backup)) {
        throw new Error(`The backup folder ${backup} exists already; wait a minute and run the merge again.`);
    }

    for (const folder of ["before", "moved", "moved-rows", "derived"]) {
        mkdirSync(join(backup, folder), { recursive: true });
    }

    cloneTree(fromFolder, join(backup, "before", from.id));
    cloneTree(intoFolder, join(backup, "before", into.id));
    writeFileSync(join(backup, "README.md"), backupReadme({ from, into, root: store.root, folder: backup }));
    log.debug({ from: from.id, into: into.id, backup }, "merge: both folders cloned");

    for (const name of MOVED_FOLDERS) {
        const source = join(fromFolder, name);

        if (!existsSync(source)) {
            continue;
        }

        mkdirSync(join(intoFolder, name), { recursive: true });

        for (const file of readdirSync(source)) {
            renameSync(join(source, file), join(intoFolder, name, file));
        }
    }

    for (const name of ROW_FILES) {
        mergeRows(join(intoFolder, name), join(fromFolder, name));
        const moved = join(fromFolder, name);

        if (existsSync(moved)) {
            renameSync(moved, join(backup, "moved-rows", name));
        }
    }

    for (const name of derived) {
        renameSync(join(intoFolder, name), join(backup, "derived", name));
    }

    const fromHistory = from.history.map((entry) => ({ ...entry, change: `[${from.id}] ${entry.change}` }));
    const record = await store.update(
        into.id,
        {
            command: "merge",
            change: `merged ${from.id}: ${result.moved.frames} frames, ${result.moved.rows} rows; backup ${backup}`,
        },
        (current) => {
            current.start = start;

            if (end) {
                current.end = end;
            }

            // A record made when a screen recording started is named "Meeting 14:29"; the call's own title wins.
            if (GENERATED_TITLE.test(current.title) && from.title.trim() && !GENERATED_TITLE.test(from.title)) {
                current.title = from.title;
            }

            current.project ??= from.project;
            current.labels = [...new Set([...current.labels, ...from.labels])];
            current.calendar ??= from.calendar;
            current.platform ??= from.platform;

            for (const [sourceId, block] of Object.entries(from.sources)) {
                current.sources[sourceId] ??= block;
            }

            for (const person of from.participants) {
                const known = current.participants.find((existing) => existing.name === person.name);

                if (known) {
                    known.from = [...new Set([...known.from, ...person.from])];
                    known.self ||= person.self;
                } else {
                    current.participants.push(person);
                }
            }

            for (const context of from.context) {
                const added: MeetingContext = { ...context, id: nextId("c", current.context) };
                current.context.push(added);
            }

            current.speakers.labels = { ...from.speakers.labels, ...current.speakers.labels };
            current.recording = mergedRecording(current.recording, from.recording);
            current.history = [...current.history, ...fromHistory].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        }
    );

    renameSync(fromFolder, join(backup, "moved", from.id));
    appendFileSync(
        join(backup, "README.md"),
        `\nMerged: ${record.id} now holds ${record.recording?.frames ?? 0} frames.\n`
    );

    if (pending) {
        await (request.inbox ?? decisionInbox).cancel(pending).catch((err: unknown) => {
            log.warn(
                { err, formId: pending },
                "merge: the project question of the merged record could not be withdrawn"
            );
            result.withdrawn = undefined;
        });
    }

    log.debug({ from: from.id, into: into.id, frames: result.moved.frames, rows: result.moved.rows }, "merge done");
    return { ...result, backup };
}
