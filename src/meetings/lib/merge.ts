import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
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
import type { DictionaryLevel } from "@genesiscz/utils/transcribe/dictionary";
import { z } from "zod";
import { type AssignInbox, decisionInbox } from "./assign-inbox";
import { CallTimeline } from "./call-timeline";
import { readRecorderState } from "./recorder-shared";
import { localStamp } from "./shared";
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
    /** The open inbox question of the record that went away, withdrawn (in a dry run: to be withdrawn if still open). */
    withdrawn?: string;
    /** The record's question that the inbox no longer held open (answered, cancelled, or in another inbox), so nothing was withdrawn. */
    notOpen?: string;
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

    if (from.attendance && !into.attendance && attendanceShift(from, into) === undefined) {
        return `${from.id} keeps attendance on its own recording clock, and ${into.id}'s source would put it at other seconds; store the attendance on ${into.id} first (${toolCommand("meetings", "attendance", into.id, "--from", from.attendance.from)}), then merge.`;
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

/**
 * A clone of every file under `source` at `destination` (a copy where the volume cannot clone). Meeting folders hold
 * screen captures and transcripts, so every folder is owner-only (0700) and every file keeps its owner bits only.
 */
function cloneTree(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true, mode: 0o700 });

    for (const name of readdirSync(source)) {
        const from = join(source, name);
        const to = join(destination, name);
        const stat = lstatSync(from);

        if (stat.isDirectory()) {
            cloneTree(from, to);
        } else if (stat.isFile()) {
            cloneOrCopy({ source: from, destination: to, mode: stat.mode & 0o700, mayCopy: true });
        } else {
            log.warn({ path: from }, "not a file or folder; left out of the merge backup");
        }
    }
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

/**
 * The meeting's dictionary level after a merge: the entries of both, `into`'s winning for one value, and `into`'s
 * settings over `from`'s.
 */
export function mergedDictionary(
    into: DictionaryLevel | undefined,
    from: DictionaryLevel | undefined
): DictionaryLevel | undefined {
    if (!into || !from) {
        return into ?? from;
    }

    const abbrExpansion = into.abbrExpansion ?? from.abbrExpansion;
    const fuzzy = into.fuzzy || from.fuzzy ? { ...from.fuzzy, ...into.fuzzy } : undefined;
    const entries = new Map([...from.entries, ...into.entries].map((entry) => [entry.value, entry]));
    return {
        ...(abbrExpansion ? { abbrExpansion } : {}),
        ...(fuzzy ? { fuzzy } : {}),
        entries: [...entries.values()],
    };
}

/**
 * How many seconds `from`'s stored attendance moves on the merged record's transcript clock. 0 when `from` is linked:
 * the merged record keeps that source meeting (`refusal` refuses two different ones), and with it the source's clock.
 * The difference of the two stored clocks when neither is linked. Undefined when only `into` is linked: that source's
 * clock is known only by asking the source, so the seconds cannot be placed here.
 */
export function attendanceShift(from: MeetingRecord, into: MeetingRecord): number | undefined {
    if (sourceRefOf(from)) {
        return 0;
    }

    if (sourceRefOf(into)) {
        return undefined;
    }

    const merged = CallTimeline.stored({
        ...into,
        start: earliest([from.start, into.start]) ?? into.start,
        recording: mergedRecording(into.recording, from.recording),
    });
    return merged.secAt(CallTimeline.stored(from).zeroMs);
}

/** One line of a row file with the wall time it carries (`at`; NaN when it has none). */
interface Row {
    line: string;
    at: number;
}

/**
 * Every row of one row file, parsed. A recorder cut short can leave a half-written last line, so a line that is not
 * JSON throws with the file and its line number: the merge reads both files before it moves anything, and a refusal
 * then leaves both records as they were.
 */
function readRows(path: string): Row[] {
    if (!existsSync(path)) {
        return [];
    }

    const rows: Row[] = [];

    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
        if (line.trim() === "") {
            continue;
        }

        let parsed: unknown;

        try {
            parsed = SafeJSON.parse(line, { strict: true });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
                `${path}:${index + 1} is not a JSON row (${reason}); fix or remove that line and merge again.`
            );
        }

        rows.push({ line, at: Date.parse(rowTime.safeParse(parsed).data?.at ?? "") });
    }

    return rows;
}

/** The rows of both files in time order (`at`), so `screen` and the timeline read one recording. */
function mergeRows(intoFile: string, rows: { into: Row[]; from: Row[] }): void {
    if (rows.from.length === 0) {
        return;
    }

    const all = [...rows.into, ...rows.from].map((row, index) => ({ ...row, index }));
    all.sort((a, b) => a.at - b.at || a.index - b.index);
    writeFileSync(`${intoFile}.merge-tmp`, `${all.map((row) => row.line).join("\n")}\n`);
    renameSync(`${intoFile}.merge-tmp`, intoFile);
}

function backupReadme(options: { from: MeetingRecord; into: MeetingRecord; root: string; folder: string }): string {
    const { from, into, root, folder } = options;
    return [
        `# Merge of ${from.id} into ${into.id}`,
        "",
        `Written by \`${toolCommand("meetings merge")}\` at ${localStamp(new Date())} (local time).`,
        "",
        `- \`before/${from.id}/\` and \`before/${into.id}/\`: clones of both meeting folders before the merge.`,
        `- \`moved/${from.id}/\`: what was left of ${from.id} after its frames, sound and rows moved.`,
        `- \`derived/\`: the editor and recorder files of ${into.id}, made again on the next editor open.`,
        "",
        "Restore (both records as they were):",
        "",
        "```sh",
        toolCommand("rm", join(root, into.id), join(root, from.id)),
        `cp -cR ${join(folder, "before", into.id)} ${join(root, into.id)}`,
        `cp -cR ${join(folder, "before", from.id)} ${join(root, from.id)}`,
        "```",
        "",
        `After a finished merge the second path of \`${toolCommand("rm")}\` is gone already, and \`${toolCommand("rm")}\` says so.`,
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
    const rows = new Map(
        ROW_FILES.map((name) => [
            name,
            { into: readRows(join(intoFolder, name)), from: readRows(join(fromFolder, name)) },
        ])
    );
    const rowCount = [...rows.values()].reduce((total, file) => total + file.from.length, 0);
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

    // The backup holds both meeting folders, so it is owner-only like the store (0700), whatever the umask.
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    chmodSync(backup, 0o700);

    for (const folder of ["before", "moved", "moved-rows", "derived"]) {
        mkdirSync(join(backup, folder), { mode: 0o700 });
    }

    cloneTree(fromFolder, join(backup, "before", from.id));
    cloneTree(intoFolder, join(backup, "before", into.id));
    writeFileSync(join(backup, "README.md"), backupReadme({ from, into, root: store.root, folder: backup }), {
        mode: 0o600,
    });
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
        mergeRows(join(intoFolder, name), rows.get(name) ?? { into: [], from: [] });
        const moved = join(fromFolder, name);

        if (existsSync(moved)) {
            renameSync(moved, join(backup, "moved-rows", name));
        }
    }

    for (const name of derived) {
        renameSync(join(intoFolder, name), join(backup, "derived", name));
    }

    const fromHistory = from.history.map((entry) => ({ ...entry, change: `[${from.id}] ${entry.change}` }));
    const shift = attendanceShift(from, into);
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
            // The word corrections typed on either record keep working; `into`'s win for one word.
            const dictionary = mergedDictionary(current.dictionary, from.dictionary);

            if (dictionary) {
                current.dictionary = dictionary;
            }

            // Stored attendance and its sections come along when `into` has none, moved onto the merged clock
            // (`refusal` already refused the case where they cannot be placed). `into`'s own attendance wins.
            if (from.attendance && !current.attendance && shift !== undefined) {
                const by = shift;
                current.attendance = {
                    ...from.attendance,
                    people: from.attendance.people.map((stay) => ({
                        ...stay,
                        fromSec: stay.fromSec + by,
                        toSec: stay.toSec + by,
                    })),
                };
                current.sections = from.sections?.map((part) => ({
                    ...part,
                    fromSec: part.fromSec + by,
                    toSec: part.toSec + by,
                }));
            }
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
        const withdrawn = await (request.inbox ?? decisionInbox).cancel(pending).catch((err: unknown) => {
            log.warn(
                { err, formId: pending },
                "merge: the project question of the merged record could not be withdrawn"
            );
            return false;
        });

        // A cancel that found no open form withdrew nothing, so the result must not say it did.
        if (!withdrawn) {
            result.withdrawn = undefined;
            result.notOpen = pending;
        }
    }

    log.debug({ from: from.id, into: into.id, frames: result.moved.frames, rows: result.moved.rows }, "merge done");
    return { ...result, backup };
}
