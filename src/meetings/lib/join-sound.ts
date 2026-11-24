import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { logger } from "@genesiscz/utils/logger";
import {
    JOIN_PART_FILE,
    type JoinPart,
    type MeetingStore,
    type PreservedSourceAudio,
} from "@genesiscz/utils/meetings/record";
import { SOURCE_AUDIO_FOLDER } from "@genesiscz/utils/meetings/source-audio-paths";
import { isClaimFile } from "./merge";
import {
    AUDIO_FOLDER,
    AUDIO_INDEX,
    audioRowZeroMs,
    readAudioRows,
    readSoundClock,
    SOUND_CLOCK_FILE,
    type SoundClock,
    saveSoundClock,
} from "./sound";

/**
 * A joined record's sound in its own folder (`meetings join`, and `meetings join <id> --repair` for a join made before
 * 2026-11-25): the later recordings' recorder pieces, rows and level rows move into the kept folder, each recording's
 * measured clock stays its own, and the source recordings become pieces of one source file of the whole meeting (the time
 * between recordings silence). After this, every reader reads the joined record as a record of one recording: cuts and
 * plays take the recording that holds a span, readers of one whole file take the one file.
 */

const { log } = logger.scoped("meetings-join");

/** Caches the readers build from the record's one source file: built again from the joined file. */
const SOUND_CACHES = ["energy.bin", "echo.json", "voice-lines.json", "seat-voice-lines.json", "voice-frames.bin"];
const LEVELS_FILE = join("evidence", "levels.jsonl");

/** Puts the recordings into one file of the joined clock, each at its offset. Tests pass a fake; ffmpeg by default. */
export type JoinedSoundEncoder = (options: {
    inputs: ReadonlyArray<{ path: string; offsetMs: number }>;
    outPath: string;
}) => Promise<void>;

/** What moves, read before anything does: a later recording's sound, and the source recordings in time order. */
export interface JoinSoundPlan {
    keptFolder: string;
    sourceId?: string;
    /** The kept record's source meeting, which the one file is preserved under. */
    sourceMeetingId?: string;
    later: Array<{
        part: JoinPart;
        folder: string;
        /** Recorder files in its `audio/`. */
        files: string[];
        /** Its `audio.jsonl` lines as written (rows and sound-loss events alike). */
        rows: string[];
        levels: string[];
        clock?: SoundClock;
        /** The wall time its first recorder piece starts: from here on, its own measured clock applies. */
        from: string;
    }>;
    /** The preserved source recordings, each with where it lives after the move. */
    recordings: Array<{ part: JoinPart; audio: NonNullable<JoinPart["audio"]>; to: string }>;
}

/** The plan in numbers, for a dry run and the result. */
export interface JoinSoundSummary {
    /** Recorder files, `audio.jsonl` lines and level rows that move into the kept folder. */
    pieces: number;
    rows: number;
    levels: number;
    /** The source recordings the one file is put together from, at their offsets. */
    recordings: Array<{ record: string; offsetMs: number }>;
}

export function joinSoundSummary(plan: JoinSoundPlan): JoinSoundSummary {
    return {
        pieces: plan.later.reduce((sum, one) => sum + one.files.length, 0),
        rows: plan.later.reduce((sum, one) => sum + one.rows.length, 0),
        levels: plan.later.reduce((sum, one) => sum + one.levels.length, 0),
        recordings: plan.recordings.map((one) => ({ record: one.part.record, offsetMs: one.part.offsetMs })),
    };
}

function lines(path: string): string[] {
    return existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter((line) => line.trim())
        : [];
}

/** The file the record says, when it is there with the size the record saved; a moved or edited file is no piece. */
function present(audio: NonNullable<JoinPart["audio"]>): boolean {
    try {
        const file = lstatSync(audio.path);
        return file.isFile() && file.size === audio.bytes;
    } catch {
        return false;
    }
}

/**
 * Reads what a joined record's sound move needs, changing nothing. `parts` are the join's parts in time order, the
 * kept record's first; a part whose preserved recording is gone adds no piece (its time is silence in the one file).
 */
export function planJoinSound(options: {
    store: MeetingStore;
    keptId: string;
    parts: readonly JoinPart[];
    source?: { sourceId: string; sourceMeetingId: string };
}): JoinSoundPlan {
    const { store, keptId, parts } = options;
    const keptFolder = store.folder(keptId);
    const taken = new Set(
        existsSync(join(keptFolder, AUDIO_FOLDER)) ? readdirSync(join(keptFolder, AUDIO_FOLDER)) : []
    );
    const later = parts
        .filter((part) => part.record !== keptId)
        .map((part) => {
            const folder = store.folder(part.record);
            const files = existsSync(join(folder, AUDIO_FOLDER)) ? readdirSync(join(folder, AUDIO_FOLDER)) : [];
            const collide = files.filter((name) => taken.has(name));

            if (collide.length > 0) {
                throw new Error(
                    `${AUDIO_FOLDER}/${collide[0]} is in both ${keptId} and ${part.record} (${collide.length} names collide); nothing was moved.`
                );
            }

            const first = readAudioRows(folder)
                .map((row) => audioRowZeroMs(row))
                .filter(Number.isFinite)
                .sort((a, b) => a - b)[0];
            const clock = readSoundClock(folder);
            return {
                part,
                folder,
                files,
                rows: lines(join(folder, AUDIO_INDEX)),
                levels: lines(join(folder, LEVELS_FILE)),
                ...(clock ? { clock } : {}),
                from: first === undefined ? part.zeroAt : new Date(first).toISOString(),
            };
        });
    const recordings = parts.flatMap((part) => {
        if (!part.audio) {
            return [];
        }

        if (!present(part.audio)) {
            log.warn(
                { part: part.record, path: part.audio.path },
                "join: a recording's preserved sound is not where its record says"
            );
            return [];
        }

        const to = join(keptFolder, SOURCE_AUDIO_FOLDER, basename(part.audio.path));
        return [{ part, audio: part.audio, to }];
    });
    return {
        keptFolder,
        ...(options.source
            ? { sourceId: options.source.sourceId, sourceMeetingId: options.source.sourceMeetingId }
            : {}),
        later,
        recordings,
    };
}

/** ffmpeg: each recording delayed to its offset and mixed (they never overlap), as stereo Opus at 64 kbit/s. */
const ffmpegEncoder: JoinedSoundEncoder = async ({ inputs, outPath }) => {
    if (!Bun.which("ffmpeg")) {
        throw new Error(
            "ffmpeg is not installed (brew install ffmpeg); the join puts the recordings' sound into one file with it."
        );
    }

    const placed = inputs.map(
        (one, index) =>
            `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=delays=${one.offsetMs}:all=1[a${index}]`
    );
    const mix =
        inputs.length === 1
            ? "[a0]anull[out]"
            : `${inputs.map((_, index) => `[a${index}]`).join("")}amix=inputs=${inputs.length}:duration=longest:normalize=0[out]`;
    const argv = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-nostats",
        ...inputs.flatMap((one) => ["-i", one.path]),
        "-filter_complex",
        [...placed, mix].join(";"),
        "-map",
        "[out]",
        "-c:a",
        "libopus",
        "-b:a",
        "64k",
        outPath,
    ];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    if (code !== 0) {
        throw new Error(
            `ffmpeg could not put the recordings' sound into one file (exit ${code}): ${stderr.trim().slice(0, 400)}`
        );
    }
};

/**
 * The one source file of the joined meeting, written into the kept folder's `source-audio/` under its own hash, before
 * anything moves: a failed encode leaves every folder as it was. Undefined when the record keeps no source recording, or
 * its one recording already starts at second 0 (that recording is the file).
 */
export async function buildJoinedSourceFile(
    plan: JoinSoundPlan,
    options: { encode?: JoinedSoundEncoder; now?: Date } = {}
): Promise<Omit<PreservedSourceAudio, "sourceMeetingId" | "pieces"> | undefined> {
    const recordings = plan.recordings;

    if (recordings.length === 0 || (recordings.length === 1 && recordings[0]!.part.offsetMs === 0)) {
        return undefined;
    }

    const folder = join(plan.keptFolder, SOURCE_AUDIO_FOLDER);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const pending = join(folder, `.joined-${randomUUID()}.ogg`);
    await (options.encode ?? ffmpegEncoder)({
        inputs: recordings.map((one) => ({ path: one.audio.path, offsetMs: one.part.offsetMs })),
        outPath: pending,
    });
    const sha256 = await sha256FileAsync(pending);
    const path = join(folder, `${sha256}.ogg`);
    renameSync(pending, path);
    chmodSync(path, 0o600);
    return { path, sha256, bytes: statSync(path).size, savedAt: (options.now ?? new Date()).toISOString() };
}

function moveInto(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    renameSync(from, to);
}

/**
 * Moves the plan's sound into the kept folder: recorder files, rows and level rows; one sound clock with an entry per
 * later recording (`SoundClock.later`); the source recordings into `source-audio/`. The kept folder's caches of its old
 * one file go to `<backup>/derived/<kept>/`, and what is left of a later folder (its caches, its source copy) to
 * `<backup>/moved/<part>/`; a later folder keeps only its `joined-into.json`. Returns the record's source sound (the one
 * file with its pieces) and the parts with their recordings' new paths.
 */
export function applyJoinSound(
    plan: JoinSoundPlan,
    options: { backup: string; keptId: string; joined?: Omit<PreservedSourceAudio, "sourceMeetingId" | "pieces"> }
): { audio?: PreservedSourceAudio; moved: Map<string, string> } {
    const { keptFolder } = plan;
    const keptClock = readSoundClock(keptFolder);

    for (const one of plan.later) {
        for (const name of one.files) {
            moveInto(join(one.folder, AUDIO_FOLDER, name), join(keptFolder, AUDIO_FOLDER, name));
        }

        if (one.rows.length > 0) {
            appendFileSync(join(keptFolder, AUDIO_INDEX), `${one.rows.join("\n")}\n`);
        }

        if (one.levels.length > 0) {
            mkdirSync(dirname(join(keptFolder, LEVELS_FILE)), { recursive: true, mode: 0o700 });
            appendFileSync(join(keptFolder, LEVELS_FILE), `${one.levels.join("\n")}\n`, { mode: 0o600 });
        }
    }

    const derived = join(options.backup, "derived", options.keptId);

    for (const name of [...SOUND_CACHES, basename(SOUND_CLOCK_FILE)]) {
        const path = join(keptFolder, "evidence", name);

        if (existsSync(path)) {
            moveInto(path, join(derived, "evidence", name));
        }
    }

    if (keptClock || plan.later.some((one) => one.clock)) {
        saveSoundClock(keptFolder, {
            version: 1,
            sources: keptClock?.sources ?? {},
            later: [
                ...(keptClock?.later ?? []),
                ...plan.later.map((one) => ({ from: one.from, sources: one.clock?.sources ?? {} })),
            ],
        });
    }

    const moved = new Map<string, string>();

    for (const one of plan.recordings) {
        if (one.audio.path !== one.to) {
            moveInto(one.audio.path, one.to);
        }

        moved.set(one.part.record, one.to);
    }

    for (const one of plan.later) {
        for (const name of readdirSync(one.folder)) {
            if (name === JOIN_PART_FILE || isClaimFile(name)) {
                continue;
            }

            const target = join(options.backup, "moved", one.part.record, name);
            moveInto(join(one.folder, name), existsSync(target) ? `${target}.${randomUUID().slice(0, 8)}` : target);
        }
    }

    const pieces = plan.recordings.map((one) => ({
        ...one.audio,
        path: one.to,
        offsetMs: one.part.offsetMs,
        ...(one.part.channels ? { layout: one.part.channels.layout } : {}),
    }));
    const first = pieces[0];
    const audio: PreservedSourceAudio | undefined = options.joined
        ? { sourceMeetingId: plan.sourceMeetingId ?? first!.sourceMeetingId, ...options.joined, pieces }
        : first
          ? {
                sourceMeetingId: first.sourceMeetingId,
                path: first.path,
                sha256: first.sha256,
                bytes: first.bytes,
                savedAt: first.savedAt,
            }
          : undefined;
    log.info(
        { kept: options.keptId, ...joinSoundSummary(plan), joined: options.joined?.path },
        "join: the later recordings' sound moved into the joined record's folder"
    );
    return { ...(audio ? { audio } : {}), moved };
}

/** A README for a repair's backup: what it holds and how to put the folders back. */
export function repairReadme(options: { ids: string[]; root: string; at: Date }): string {
    return [
        `# Backup before \`meetings join --repair\` (${options.at.toISOString()})`,
        "",
        "`before/<id>/` holds each folder as it was. `derived/` holds the caches the repair replaced; `moved/` what it",
        "moved out of a later recording's folder. To undo the repair, put each `before/<id>` back over the store folder:",
        "",
        ...options.ids.map((id) => `    rsync -a --delete before/${id}/ ${join(options.root, id)}/`),
        "",
    ].join("\n");
}
