import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { nameKey } from "@genesiscz/utils/meetings/people";
import {
    JOIN_PART_FILE,
    JOIN_SOUND_MERGED,
    JOINED_RECORD_VERSION,
    JOURNAL_FILE,
    type JoinPart,
    joinedAway,
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    meetingRecordSchema,
    missingMeetingText,
    nextId,
} from "@genesiscz/utils/meetings/record";
import { type MeetingSeats, seatSpan, storedMeetingSeatsSchema } from "@genesiscz/utils/meetings/seats";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { type AssignInbox, decisionInbox } from "./assign-inbox";
import { probeAudio } from "./audio";
import { CallTimeline } from "./call-timeline";
import { journalEntrySchema } from "./decision-actions";
import { movedValue, type PartMove, toJoinedSec } from "./join-clock";
import {
    applyJoinSound,
    buildJoinedSourceFile,
    type JoinedSoundEncoder,
    type JoinSoundSummary,
    joinSoundSummary,
    planJoinSound,
    repairReadme,
} from "./join-sound";
import {
    cloneTree,
    DERIVED_FILES,
    GENERATED_TITLE,
    isClaimFile,
    mergedDictionary,
    mergedRecording,
    mergeRows,
    readRows,
} from "./merge";
import { readRecorderState } from "./recorder-shared";
import { localStamp } from "./shared";
import { preservedSourceAudio, syncSourceAudio } from "./source-audio";
import { meetingSource, sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-join");

/** The parts with each moved recording at its new path in the joined record's `source-audio/`. */
function withMovedRecordings(parts: readonly JoinPart[], moved: ReadonlyMap<string, string>): JoinPart[] {
    return parts.map((part) => {
        const path = moved.get(part.record);
        return path && part.audio ? { ...part, audio: { ...part.audio, path } } : part;
    });
}

/** The joined record that holds `id` as a recording it absorbed (the shared resolver, `joinedAway`). */
export function joinedInto(store: MeetingStore, id: string): { record: MeetingRecord; part: JoinPart } | undefined {
    return joinedAway(store, id);
}

/** The lines of an ndjson file as parsed values; a line that is not JSON throws with its place (nothing moved yet). */
function readNdjson(path: string): unknown[] {
    if (!existsSync(path)) {
        return [];
    }

    return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) => {
            if (line.trim() === "") {
                return [];
            }

            try {
                return [SafeJSON.parse(line, { strict: true })];
            } catch (error) {
                throw new Error(`${path}:${index + 1} is not a JSON line (${String(error)}); fix it and join again.`);
            }
        });
}

function atOf(value: unknown): string {
    return value && typeof value === "object" && "at" in value && typeof value.at === "string" ? value.at : "";
}

/** Lines of several parts in one file, in time order (`at`), each part's own order kept for one time. */
function writeNdjson(path: string, parts: unknown[][]): void {
    const all = parts.flatMap((lines, part) => lines.map((line, index) => ({ line, part, index })));

    if (all.length === 0) {
        return;
    }

    all.sort((a, b) =>
        atOf(a.line) < atOf(b.line) ? -1 : atOf(a.line) > atOf(b.line) ? 1 : a.part - b.part || a.index - b.index
    );
    writeFileSync(`${path}.join-tmp`, `${all.map(({ line }) => SafeJSON.stringify(line)).join("\n")}\n`, {
        mode: 0o600,
    });
    renameSync(`${path}.join-tmp`, path);
}

/** The ndjson files a record folder holds about its items: the decision journal, the answer log and the comments. */
const ITEM_LOGS = [JOURNAL_FILE, "questions.ndjson", "comments.ndjson"] as const;
/** What a part folder keeps after the join: its sound, its caches and the source's copy, on its own clock. */
const PART_KEEPS = new Set(["audio", "audio.jsonl", "evidence", "source-audio", "source-copy", "ocr-settings.json"]);

export interface JoinRequest {
    store: MeetingStore;
    /** Two records of one meeting, in any order. */
    ids: [string, string];
    dryRun?: boolean;
    backupRoot?: string;
    inbox?: AssignInbox;
    now?: Date;
    /** Puts the recordings into one file (tests pass a fake); ffmpeg by default. */
    encode?: JoinedSoundEncoder;
}

export interface JoinedPartPlan {
    record: string;
    title: string;
    source: string;
    /** The part's second 0 on the joined clock, in milliseconds. */
    offsetMs: number;
    lines: number;
    items: number;
    /** Its items took new ids after the other part's (the part with more items keeps its ids). */
    renumbered: boolean;
    /** The part's end on the joined clock (its last line or its sound, whichever is later). */
    endSec: number;
}

export interface JoinResult {
    /** The record that holds the meeting now: the earliest recording's, whose clock stays as it was. */
    into: string;
    dryRun: boolean;
    parts: JoinedPartPlan[];
    gaps: Array<{ fromSec: number; toSec: number; from: string; to: string }>;
    /** Seconds the move rounded to the microsecond because they held more digits; 0 for millisecond data. */
    rounded: number;
    /** The later recordings' sound that moves into the joined record's folder (`join-sound.ts`). */
    sound: JoinSoundSummary;
    backup?: string;
    withdrawn?: string;
}

interface LoadedPart {
    record: MeetingRecord;
    sourceId: string;
    sourceMeetingId: string;
    zeroMs: number;
    lines: number;
    labels: Set<string>;
    endOwnSec: number;
}

async function loadPart(record: MeetingRecord): Promise<LoadedPart> {
    const ref = sourceRefOf(record);

    if (!ref) {
        throw new Error(`${record.id} links no source meeting, so its clock is unknown; link it first.`);
    }

    const source = await meetingSource(ref.sourceId);
    const [meeting, clock] = await Promise.all([
        source.load(ref.sourceMeetingId),
        CallTimeline.sourceClock({ source, sourceMeetingId: ref.sourceMeetingId }),
    ]);

    if (!clock) {
        throw new Error(
            `${record.id}: the source keeps no recording clock, so its lines cannot be placed to the millisecond.`
        );
    }

    const zeroMs = Date.parse(clock.startedAt);
    const lines = new TranscriptLines(meeting.transcript);
    const lastLine = lines.entries.reduce((end, _entry, index) => Math.max(end, lines.end(index) ?? 0), 0);
    const audio = preservedSourceAudio(record);
    const soundSec = audio
        ? await probeAudio(audio.path).then(
              (probe) => probe.durationSec,
              () => 0
          )
        : 0;
    return {
        record,
        sourceId: ref.sourceId,
        sourceMeetingId: ref.sourceMeetingId,
        zeroMs,
        lines: meeting.transcript.length,
        labels: new Set([...meeting.transcript.map((entry) => entry.speaker), ...Object.keys(record.speakers.labels)]),
        endOwnSec: Math.max(lastLine, Number.isFinite(soundSec) ? soundSec : 0),
    };
}

/** Why these records cannot be joined; each a sentence for the user. */
function joinRefusal(parts: LoadedPart[], store: MeetingStore): string | undefined {
    const [first, second] = parts as [LoadedPart, LoadedPart];

    if (first.record.id === second.record.id) {
        return `${first.record.id} is the same record; name two.`;
    }

    for (const part of parts) {
        if (part.record.join) {
            return `${part.record.id} is joined already; a third recording cannot be added yet.`;
        }
    }

    if (first.sourceId !== second.sourceId) {
        return `${first.record.id} comes from ${first.sourceId} and ${second.record.id} from ${second.sourceId}; only recordings of one source join.`;
    }

    if (first.sourceMeetingId === second.sourceMeetingId) {
        return `${first.record.id} and ${second.record.id} hold the same source meeting; merge them instead: ${toolCommand("meetings", "merge", second.record.id, "--into", first.record.id)}`;
    }

    const overlap = (second.zeroMs - first.zeroMs) / 1000 < first.endOwnSec;

    if (overlap) {
        return `${second.record.id} starts before ${first.record.id} ends; two recordings of the same time do not join.`;
    }

    const named = (part: LoadedPart) => new Set(part.record.participants.map((person) => nameKey(person.name)));
    const shared = [...first.labels].filter(
        (label) => second.labels.has(label) && !(named(first).has(nameKey(label)) && named(second).has(nameKey(label)))
    );

    if (shared.length > 0) {
        return `The speaker label "${shared[0]}" is in both recordings (${shared.length} shared) and may name two people; rename it in one of them first.`;
    }

    const recorder = readRecorderState(store);

    if (recorder.running && parts.some((part) => recorder.state?.meetingId === part.record.id)) {
        return `${recorder.state?.meetingId} is being recorded now; stop the recording first.`;
    }

    const frames = (id: string) =>
        existsSync(join(store.folder(id), "frames")) ? readdirSync(join(store.folder(id), "frames")) : [];
    const taken = new Set(frames(first.record.id));
    const collide = frames(second.record.id).filter((name) => taken.has(name));

    if (collide.length > 0) {
        return `frames/${collide[0]} is in both records (${collide.length} names collide); nothing was moved.`;
    }

    return undefined;
}

function idNumber(id: string): number {
    return Number(/\d+$/.exec(id)?.[0] ?? 0);
}

/** Renumbers `ids` after the highest of `kept`, in order, for one prefix. */
function renumber(
    prefix: "i" | "a",
    kept: Array<{ id: string }>,
    moved: Array<{ id: string }>,
    map: Map<string, string>
): void {
    let next = kept.reduce((max, one) => Math.max(max, idNumber(one.id)), 0);

    for (const one of moved) {
        next++;
        map.set(one.id, `${prefix}${next}`);
    }
}

/** Both parts' seats on the joined clock: a seat that covered a whole part covers that part's stretch. */
function joinedSeats(
    parts: Array<{ seats?: MeetingSeats; fromSec: number; toSec?: number; move: PartMove }>
): MeetingSeats | undefined {
    const withSeats = parts.filter((part) => part.seats);

    if (withSeats.length === 0) {
        return undefined;
    }

    const plainInAll = (side: "room" | "remote", name: string) =>
        parts.every((part) =>
            (part.seats?.[side] ?? []).some((row) =>
                typeof row === "string"
                    ? nameKey(row) === nameKey(name)
                    : nameKey(row.name) === nameKey(name) &&
                      row.fromSec === undefined &&
                      row.toSec === undefined &&
                      !("label" in row && row.label)
            )
        );
    const seats: MeetingSeats = { room: [], remote: [] };

    for (const side of ["room", "remote"] as const) {
        const plain = new Set<string>();

        for (const part of parts) {
            for (const row of part.seats?.[side] ?? []) {
                const span = seatSpan(row);
                const whole =
                    span.fromSec === undefined && span.toSec === undefined && !("label" in span && span.label);

                if (whole && plainInAll(side, span.name)) {
                    if (!plain.has(nameKey(span.name))) {
                        plain.add(nameKey(span.name));
                        (seats[side] as unknown[]).push(side === "room" ? span.name : { name: span.name });
                    }
                    continue;
                }

                const moved = movedValue(row, part.move);
                const rowSpan = typeof moved === "string" ? { name: moved } : moved;
                (seats[side] as unknown[]).push({
                    ...rowSpan,
                    fromSec: rowSpan.fromSec ?? part.fromSec,
                    ...(rowSpan.toSec !== undefined
                        ? { toSec: rowSpan.toSec }
                        : part.toSec !== undefined
                          ? { toSec: part.toSec }
                          : {}),
                });
            }
        }
    }

    const microphones = new Map(
        withSeats.flatMap((part) => part.seats?.microphones ?? []).map((group) => [group.id, group])
    );

    if (microphones.size > 0) {
        seats.microphones = [...microphones.values()];
    }

    const parsed = storedMeetingSeatsSchema.safeParse(seats);

    if (!parsed.success) {
        throw new Error(
            `The seats of the two recordings do not fit one meeting (${parsed.error.issues[0]?.message}); edit the seats of one first.`
        );
    }

    return parsed.data;
}

function backupReadme(options: { ids: string[]; root: string; folder: string; at: Date }): string {
    const { ids, root, folder } = options;
    return [
        `# Join of ${ids.join(" and ")}`,
        "",
        `Written by \`${toolCommand("meetings join")}\` at ${localStamp(options.at)} (local time).`,
        "",
        ...ids.map((id) => `- \`before/${id}/\`: a clone of ${id}'s folder before the join.`),
        "- `moved/<id>/`: the files of the later recording that left its folder (its record, journal, rows).",
        "- `derived/<id>/`: the editor and recorder files of each record, made again on the next editor open.",
        "- The voice library is not changed by a join.",
        "",
        "Restore (both records as they were, byte for byte):",
        "",
        "```sh",
        toolCommand("rm", ...ids.map((id) => join(root, id))),
        ...ids.map((id) => `cp -cR ${join(folder, "before", id)} ${join(root, id)}`),
        "```",
        "",
    ].join("\n");
}

/**
 * Joins two records of one meeting that its source recorded as two (Wispr Flow split it): one record, the earliest
 * recording's id and clock, the later recording's lines and items on that clock at their own wall time, and the gap
 * between them kept empty. Both folders are cloned into a backup first; the later recording's sound and caches stay
 * in its folder (a part folder now), so every cut of its sound is the same file at the same second.
 */
export async function joinMeetings(request: JoinRequest): Promise<JoinResult> {
    const { store } = request;
    const records = request.ids.map((ref) => {
        const record = store.resolve(ref);

        if (!record) {
            throw new Error(missingMeetingText(store, ref));
        }

        return record;
    });

    if (request.dryRun) {
        return joinLocked({ request, records, update: store.update.bind(store) });
    }

    // Each recording's source sound is kept in its folder first, so the join moves files it owns.
    for (const record of records) {
        const ref = sourceRefOf(record);

        if (ref && !preservedSourceAudio(record)) {
            await syncSourceAudio({
                store,
                record,
                source: await meetingSource(ref.sourceId),
                sourceMeetingId: ref.sourceMeetingId,
            }).catch((error: unknown) =>
                log.warn({ error, meeting: record.id }, "join: the source sound could not be kept")
            );
        }
    }

    return store.withRecords({
        ids: records.map((record) => record.id),
        fn: async (current, update) =>
            joinLocked({
                request,
                records: records.map((record) => {
                    const fresh = current.get(record.id);

                    if (!fresh) {
                        throw new Error("A meeting disappeared before the join acquired its locks.");
                    }

                    return fresh;
                }),
                update,
            }),
    });
}

async function joinLocked({
    request,
    records,
    update,
}: {
    request: JoinRequest;
    records: MeetingRecord[];
    update: MeetingStore["update"];
}): Promise<JoinResult> {
    const { store } = request;
    const loaded = (await Promise.all(records.map(loadPart))).sort((a, b) => a.zeroMs - b.zeroMs);
    const refused = joinRefusal(loaded, store);

    if (refused) {
        throw new Error(refused);
    }

    const [kept, later] = loaded as [LoadedPart, LoadedPart];
    const zeroMs = kept.zeroMs;
    const offsets = loaded.map((part) => part.zeroMs - zeroMs);
    // The part with the most items keeps its ids (and its question numbers, so its items come first).
    const keepsIds = kept.record.items.length >= later.record.items.length ? kept : later;
    const renumbered = keepsIds === kept ? later : kept;
    const ids = new Map<string, string>();
    renumber("i", keepsIds.record.items, renumbered.record.items, ids);
    renumber("a", keepsIds.record.speakers.assignments ?? [], renumbered.record.speakers.assignments ?? [], ids);
    const questions = (part: LoadedPart) => part.record.items.filter((item) => item.kind === "question").length;
    const rounded = { count: 0 };
    const moves = new Map<LoadedPart, PartMove>(
        loaded.map((part, index) => [
            part,
            {
                offsetMs: offsets[index]!,
                ids: part === renumbered ? ids : new Map(),
                questionBase: part === renumbered ? questions(keepsIds) : 0,
                meeting: { from: part.record.id, to: kept.record.id },
                rounded,
            },
        ])
    );
    const endSec = (part: LoadedPart, index: number) => toJoinedSec(part.endOwnSec, offsets[index]!);
    const plans: JoinedPartPlan[] = loaded.map((part, index) => ({
        record: part.record.id,
        title: part.record.title,
        source: `${part.sourceId}:${part.sourceMeetingId}`,
        offsetMs: offsets[index]!,
        lines: part.lines,
        items: part.record.items.length,
        renumbered: part === renumbered && part.record.items.length > 0,
        endSec: endSec(part, index),
    }));
    // The moved values, computed before anything is written: a value that cannot move refuses the join untouched.
    const moved = loaded.map((part) => {
        const move = moves.get(part)!;
        return {
            part,
            move,
            items: part.record.items.map((item) => movedValue(item, move)),
            logs: Object.fromEntries(
                ITEM_LOGS.map((name) => [
                    name,
                    readNdjson(join(store.folder(part.record.id), name)).map((line) => movedValue(line, move)),
                ])
            ) as Record<(typeof ITEM_LOGS)[number], unknown[]>,
        };
    });

    for (const one of moved) {
        for (const [index, entry] of one.logs[JOURNAL_FILE].entries()) {
            const parsed = journalEntrySchema.safeParse(entry);

            if (!parsed.success) {
                throw new Error(
                    `${one.part.record.id}'s decision journal line ${index + 1} does not read after the move (${parsed.error.issues[0]?.message}); nothing was changed.`
                );
            }
        }
    }

    const seats = joinedSeats(
        loaded.map((part, index) => ({
            seats: part.record.seats,
            fromSec: offsets[index]! / 1000,
            ...(loaded[index + 1] ? { toSec: endSec(part, index) } : {}),
            move: moves.get(part)!,
        }))
    );
    const gaps = loaded.slice(1).map((after, index) => ({
        fromSec: endSec(loaded[index]!, index),
        toSec: offsets[index + 1]! / 1000,
        from: loaded[index]!.record.id,
        to: after.record.id,
    }));
    const pending = later.record.assign?.ask?.outcome === "pending" ? later.record.assign.ask.formId : undefined;
    const parts: JoinPart[] = loaded.map((part, index) => {
        const preserved = preservedSourceAudio(part.record);
        const audio = preserved && {
            sourceMeetingId: preserved.sourceMeetingId,
            path: preserved.path,
            sha256: preserved.sha256,
            bytes: preserved.bytes,
            savedAt: preserved.savedAt,
        };
        const channels = part.record.evidence?.channels;
        return {
            record: part.record.id,
            title: part.record.title,
            sourceId: part.sourceId,
            sourceMeetingId: part.sourceMeetingId,
            zeroAt: new Date(part.zeroMs).toISOString(),
            offsetMs: offsets[index]!,
            endSec: endSec(part, index),
            ...(audio ? { audio } : {}),
            ...(channels ? { channels } : {}),
            ...(part.record.seats ? { seats: part.record.seats } : {}),
        };
    });
    const keptSource = sourceRefOf(kept.record);
    const sound = planJoinSound({
        store,
        keptId: kept.record.id,
        parts,
        ...(keptSource ? { source: keptSource } : {}),
    });
    const result: JoinResult = {
        into: kept.record.id,
        dryRun: Boolean(request.dryRun),
        parts: plans,
        gaps,
        rounded: rounded.count,
        sound: joinSoundSummary(sound),
        ...(pending ? { withdrawn: pending } : {}),
    };

    if (request.dryRun) {
        return result;
    }

    const at = request.now ?? new Date();
    // The one source file is written before anything moves: a failed encode leaves both records as they were.
    const joinedFile = await buildJoinedSourceFile(sound, {
        ...(request.encode ? { encode: request.encode } : {}),
        now: at,
    });
    const backup = join(
        request.backupRoot ?? genesisToolsDir("backups", "meetings"),
        `${localStamp(at)}-join-${kept.record.id}`
    );

    if (existsSync(backup)) {
        throw new Error(`The backup folder ${backup} exists already; wait a minute and run the join again.`);
    }

    mkdirSync(backup, { recursive: true, mode: 0o700 });
    chmodSync(backup, 0o700);

    for (const folder of ["before", "moved", "derived"]) {
        mkdirSync(join(backup, folder), { mode: 0o700 });
    }

    for (const part of loaded) {
        cloneTree(store.folder(part.record.id), join(backup, "before", part.record.id));
    }

    const ids2 = loaded.map((part) => part.record.id);
    writeFileSync(join(backup, "README.md"), backupReadme({ ids: ids2, root: store.root, folder: backup, at }), {
        mode: 0o600,
    });
    log.debug({ parts: ids2, backup }, "join: both folders cloned");
    const keptFolder = store.folder(kept.record.id);
    const laterFolder = store.folder(later.record.id);

    // Frames and their rows are wall-time: the later recording's join the kept folder, as `merge` moves them.
    if (existsSync(join(laterFolder, "frames"))) {
        mkdirSync(join(keptFolder, "frames"), { recursive: true });

        for (const name of readdirSync(join(laterFolder, "frames"))) {
            renameSync(join(laterFolder, "frames", name), join(keptFolder, "frames", name));
        }
    }

    const movedFolder = join(backup, "moved", later.record.id);
    mkdirSync(movedFolder, { mode: 0o700 });

    for (const name of ["frames.jsonl", "ocr.jsonl"]) {
        mergeRows(join(keptFolder, name), {
            into: readRows(join(keptFolder, name)),
            from: readRows(join(laterFolder, name)),
        });
    }

    for (const part of loaded) {
        const derived = join(backup, "derived", part.record.id);
        mkdirSync(derived, { mode: 0o700 });

        for (const name of DERIVED_FILES) {
            const path = join(store.folder(part.record.id), name);

            if (existsSync(path)) {
                renameSync(path, join(derived, name));
            }
        }
    }

    for (const name of ITEM_LOGS) {
        const byPart = moved.map((one) => one.logs[name]);
        const laterPath = join(laterFolder, name);

        if (existsSync(laterPath)) {
            renameSync(laterPath, join(movedFolder, name));
        }

        if (byPart.some((lines) => lines.length > 0)) {
            writeNdjson(join(keptFolder, name), byPart);
        }
    }

    // What is left of the later record that is not its sound or caches leaves its folder; the folder stays a part folder.
    for (const name of readdirSync(laterFolder)) {
        if (!PART_KEEPS.has(name) && !isClaimFile(name) && name !== "frames") {
            renameSync(join(laterFolder, name), join(movedFolder, name));
        }
    }

    if (existsSync(join(laterFolder, "frames")) && readdirSync(join(laterFolder, "frames")).length === 0) {
        renameSync(join(laterFolder, "frames"), join(movedFolder, "frames"));
    }

    writeFileSync(
        join(laterFolder, JOIN_PART_FILE),
        `${SafeJSON.stringify({ joinedInto: kept.record.id, at: at.toISOString(), backup }, null, 2)}\n`,
        { mode: 0o600 }
    );
    const soundMoved = applyJoinSound(sound, {
        backup,
        keptId: kept.record.id,
        ...(joinedFile ? { joined: joinedFile } : {}),
    });
    const joinedParts = withMovedRecordings(parts, soundMoved.moved);
    const movedOf = (part: LoadedPart) => moved.find((one) => one.part === part)!;
    const laterMove = moves.get(later)!;
    const keptMove = moves.get(kept)!;
    const history = later.record.history.map((entry) => ({ ...entry, change: `[${later.record.id}] ${entry.change}` }));
    await update(
        kept.record.id,
        {
            command: "join",
            change: `joined ${later.record.id} at ${formatClock(offsets[1]! / 1000)}: ${later.lines} lines, ${later.record.items.length} items; backup ${backup}`,
        },
        (current) => {
            current.version = JOINED_RECORD_VERSION;
            current.join = { version: JOIN_SOUND_MERGED, at: at.toISOString(), backup, parts: joinedParts };

            if (soundMoved.audio && sound.sourceId) {
                current.audio = { sources: { ...current.audio?.sources, [sound.sourceId]: soundMoved.audio } };
            }
            const end = [current.end, later.record.end]
                .filter((one): one is string => Boolean(one))
                .sort()
                .at(-1);

            if (end) {
                current.end = end;
            }

            if (
                GENERATED_TITLE.test(current.title) &&
                later.record.title.trim() &&
                !GENERATED_TITLE.test(later.record.title)
            ) {
                current.title = later.record.title;
            }

            current.project ??= later.record.project;
            current.labels = [...new Set([...current.labels, ...later.record.labels])];
            current.calendar ??= later.record.calendar;
            current.platform ??= later.record.platform;
            const itemsOf = (part: LoadedPart) => movedOf(part).items as MeetingItem[];
            current.items = [...itemsOf(keepsIds), ...itemsOf(renumbered)];
            const assignments = [
                ...movedValue(kept.record.speakers.assignments ?? [], keptMove),
                ...movedValue(later.record.speakers.assignments ?? [], laterMove),
            ];
            current.speakers = {
                labels: { ...later.record.speakers.labels, ...kept.record.speakers.labels },
                ...(assignments.length > 0 ? { assignments } : {}),
            };

            for (const person of movedValue(later.record.participants, laterMove)) {
                const known = current.participants.find((existing) => nameKey(existing.name) === nameKey(person.name));

                if (!known) {
                    current.participants.push(person);
                    continue;
                }

                known.from = [...new Set([...known.from, ...person.from])];
                known.self ||= person.self;

                if (person.stays?.length) {
                    known.stays = [...(known.stays ?? []), ...person.stays];
                }
            }

            for (const context of later.record.context) {
                current.context.push({ ...context, id: nextId("c", current.context) });
            }

            const dictionary = mergedDictionary(current.dictionary, later.record.dictionary);

            if (dictionary) {
                current.dictionary = dictionary;
            }

            if (seats) {
                current.seats = seats;
            } else {
                current.seats = undefined;
            }

            const indicator = [
                ...(current.evidence?.indicator ?? []),
                ...movedValue(later.record.evidence?.indicator ?? [], laterMove),
            ].sort((a, b) => a.tSec - b.tSec);

            if (indicator.length > 0) {
                current.evidence = { ...current.evidence, indicator };
            }

            if (later.record.attendance) {
                const movedAttendance = movedValue(later.record.attendance, laterMove);
                current.attendance = current.attendance
                    ? { ...current.attendance, people: [...current.attendance.people, ...movedAttendance.people] }
                    : movedAttendance;
                current.sections = [...(current.sections ?? []), ...movedValue(later.record.sections ?? [], laterMove)];
            }

            const spotChecks = [
                ...movedValue(kept.record.review?.listen?.spotChecks ?? [], keptMove),
                ...movedValue(later.record.review?.listen?.spotChecks ?? [], laterMove),
            ];

            if (spotChecks.length > 0) {
                current.review = { ...current.review, listen: { ...current.review?.listen, spotChecks } };
            }

            current.exports = [...(current.exports ?? []), ...(later.record.exports ?? [])];

            if (current.exports.length === 0) {
                current.exports = undefined;
            }

            current.recording = mergedRecording(current.recording, later.record.recording);
            current.history = [...current.history, ...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
            // The kept record's journal, answers and comments were moved too when its ids were renumbered.
            meetingRecordSchema.parse(current);
        }
    );

    if (pending) {
        const withdrawn = await (request.inbox ?? decisionInbox).cancel(pending).catch((err: unknown) => {
            log.warn({ err, formId: pending }, "join: the project question of the later record could not be withdrawn");
            return false;
        });

        if (!withdrawn) {
            result.withdrawn = undefined;
        }
    }

    log.info({ into: kept.record.id, parts: ids2, backup, rounded: rounded.count }, "join done");
    return { ...result, backup };
}

export interface JoinRepairRequest {
    store: MeetingStore;
    /** The joined record: an id, a unique prefix or last. */
    ref: string;
    dryRun?: boolean;
    backupRoot?: string;
    now?: Date;
    /** Puts the recordings into one file (tests pass a fake); ffmpeg by default. */
    encode?: JoinedSoundEncoder;
}

export interface JoinRepairResult {
    meeting: string;
    dryRun: boolean;
    /** False when there was nothing to move: the record's sound is in its own folder already. */
    repaired: boolean;
    reason?: string;
    sound?: JoinSoundSummary;
    /** The one source file of the whole meeting the readers of one file read. */
    joinedFile?: string;
    backup?: string;
}

/**
 * A record joined before 2026-11-25 kept its later recording's sound in that recording's folder; this moves it into the
 * joined record's folder, as `join` does now (`join-sound.ts`), after cloning every folder it touches into a backup.
 * Runs once: a second run finds the sound moved and changes nothing.
 */
export async function repairJoin(request: JoinRepairRequest): Promise<JoinRepairResult> {
    const { store } = request;
    const dryRun = Boolean(request.dryRun);
    const found = store.resolve(request.ref);

    if (!found) {
        throw new Error(`No meeting "${request.ref}".`);
    }

    if (!found.join) {
        throw new Error(`${found.id} is not a joined meeting; there is nothing to repair.`);
    }

    const planOf = (record: MeetingRecord) => {
        const source = sourceRefOf(record);
        return planJoinSound({
            store,
            keptId: record.id,
            parts: record.join?.parts ?? [],
            ...(source ? { source } : {}),
        });
    };
    const done = (record: MeetingRecord): JoinRepairResult | undefined =>
        record.join && record.join.version >= JOIN_SOUND_MERGED
            ? { meeting: record.id, dryRun, repaired: false, reason: "its sound is in its own folder already" }
            : undefined;

    if (done(found)) {
        return done(found)!;
    }

    if (dryRun) {
        return { meeting: found.id, dryRun, repaired: false, sound: joinSoundSummary(planOf(found)) };
    }

    return store.withRecords({
        ids: [found.id],
        fn: async (current, update) => {
            const record = current.get(found.id);

            if (!record?.join) {
                throw new Error(`${found.id} changed before the repair acquired its lock; run it again.`);
            }

            if (done(record)) {
                return done(record)!;
            }

            const plan = planOf(record);
            const at = request.now ?? new Date();
            const backup = join(
                request.backupRoot ?? genesisToolsDir("backups", "meetings"),
                `${localStamp(at)}-join-repair-${record.id}`
            );

            if (existsSync(backup)) {
                throw new Error(`The backup folder ${backup} exists already; wait a minute and run the repair again.`);
            }

            const ids = [record.id, ...record.join.parts.map((part) => part.record).filter((id) => id !== record.id)];
            mkdirSync(backup, { recursive: true, mode: 0o700 });
            chmodSync(backup, 0o700);

            for (const folder of ["before", "moved", "derived"]) {
                mkdirSync(join(backup, folder), { mode: 0o700 });
            }

            for (const id of ids) {
                cloneTree(store.folder(id), join(backup, "before", id));
            }

            writeFileSync(join(backup, "README.md"), repairReadme({ ids, root: store.root, at }), { mode: 0o600 });
            const joinedFile = await buildJoinedSourceFile(plan, {
                ...(request.encode ? { encode: request.encode } : {}),
                now: at,
            });
            const moved = applyJoinSound(plan, {
                backup,
                keptId: record.id,
                ...(joinedFile ? { joined: joinedFile } : {}),
            });
            const sound = joinSoundSummary(plan);
            await update(
                record.id,
                {
                    command: "join",
                    change: `repair: the later recordings' sound moved into this folder (${sound.pieces} recorder files, ${sound.recordings.length} source recordings); backup ${backup}`,
                },
                (next) => {
                    if (!next.join) {
                        return;
                    }

                    next.join = {
                        ...next.join,
                        version: JOIN_SOUND_MERGED,
                        parts: withMovedRecordings(next.join.parts, moved.moved),
                    };

                    if (moved.audio && plan.sourceId) {
                        next.audio = { sources: { ...next.audio?.sources, [plan.sourceId]: moved.audio } };
                    }
                }
            );
            return {
                meeting: record.id,
                dryRun,
                repaired: true,
                sound,
                ...(joinedFile ? { joinedFile: joinedFile.path } : {}),
                backup,
            };
        },
    });
}
