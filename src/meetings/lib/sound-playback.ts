import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LISTEN_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { segmentsEndSec } from "./audio";
import { momentCacheDir, trimMomentCache } from "./moment";
import type { OpenedMeeting } from "./opened-meeting";
import {
    channelFilter,
    PLAYERS,
    type PlaybackPlan,
    type PlayerList,
    pastTheEnd,
    pickPlayer,
    type SeekingPlayer,
} from "./players";
import { type MeetingSound, type Seat, type SoundSlice, soundRun, type TrackKind } from "./sound";
import { sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-playback");

/** A slice with the meeting it is from and the meeting second it starts at, which name its cut in the clip cache. */
export type MeetingSlice = SoundSlice & { meeting: string; fromSec: number };

/** One file a play goes through: the file seconds it plays, and the one channel heard (both when absent). */
export type PlayPart = Pick<SoundSlice, "path" | "channel" | "fileFromSec" | "fileToSec">;

/** What a player opens for a slice: the first file and the second it starts at, and every part it plays. */
export interface SliceOpening {
    audioPath: string;
    startSec: number;
    /** `audioPath` is a WAV cut into the clip cache from the first `cutParts` parts; it exists once `cutSlice` ran. */
    cut: boolean;
    /** With `cut`: how many of the first `parts` the WAV holds, joined (a range over two pieces holds both). */
    cutParts?: number;
    /** What plays, in order: a range is one part; a play from a time goes on through the track's later pieces. */
    parts: PlayPart[];
    /** The list the player reads the parts from (ffplay's concat list), written into the clip cache at the start. */
    list?: PlayerList;
}

/** A `tools meetings play` plan for a slice: what it opens, in which seeking player, with which command line. */
export type SlicePlaybackPlan = PlaybackPlan & SliceOpening;

/**
 * A player that hears both channels (VLC) plays this much of one channel as a WAV cut, then the recording itself, both
 * channels, on from there. The whole rest of a 60 min stereo source took 2.4 s and 288 MB to cut before it played.
 */
export const CHANNEL_CUT_SEC = 60;

/**
 * The plan `tools meetings play` starts. A play from a time opens the recording itself at the slice's second, so the
 * player shows the real file and can seek in it, and goes on through the track's later pieces (`next`) in the
 * player's own list: VLC takes them as a playlist, ffplay as a concat list in the clip cache. One channel of a stereo
 * source plays in place in ffplay (`-af pan`); VLC plays `CHANNEL_CUT_SEC` of it as a WAV cut into the clip cache,
 * then the recording on. A range is a WAV cut. No player reads a pipe: the VLC app took `/dev/stdin` for an empty
 * item named "stdin" and played nothing.
 */
export function slicePlaybackPlan(options: {
    slice: MeetingSlice;
    next?: readonly SoundSlice[];
    openEnded: boolean;
    player: SeekingPlayer;
}): SlicePlaybackPlan {
    const { slice, player } = options;

    if (!options.openEnded) {
        // A range is one WAV: a range over a piece boundary joins the pieces it covers.
        const parts = [slice, ...(options.next ?? [])].map(playPart);
        const audioPath = sliceCachePath(slice, parts.slice(1));
        return {
            audioPath,
            startSec: 0,
            cut: true,
            cutParts: parts.length,
            parts,
            player: player.id,
            argv: player.fromArgv(audioPath, 0),
        };
    }

    const run = [slice, ...(options.next ?? [])].map(playPart);
    const listPath = join(momentCacheDir(slice.meeting), `run-${slice.track}.ffconcat`);

    if (slice.channel === undefined || player.pans) {
        const opening = player.runOpening({
            items: run.map((part) => ({ path: part.path, fromSec: part.fileFromSec })),
            ...(slice.channel === undefined ? {} : { channel: slice.channel }),
            listPath,
        });
        return {
            audioPath: slice.path,
            startSec: slice.fileFromSec,
            cut: false,
            parts: run,
            ...(opening.list ? { list: opening.list } : {}),
            player: player.id,
            argv: opening.argv,
        };
    }

    // The player hears both channels: a bounded cut of the asked one first, then the recording itself from its end.
    const cutToSec = Math.min(slice.fileToSec, slice.fileFromSec + CHANNEL_CUT_SEC);
    const audioPath = sliceCachePath({ ...slice, fileToSec: cutToSec });
    const [, ...later] = run;
    const parts: PlayPart[] = [
        { ...playPart(slice), fileToSec: cutToSec },
        ...(cutToSec < slice.fileToSec
            ? [{ path: slice.path, fileFromSec: cutToSec, fileToSec: slice.fileToSec }]
            : []),
        ...later.map(({ channel: _channel, ...part }) => part),
    ];
    const opening = player.runOpening({
        items: parts.map((part, index) =>
            index === 0 ? { path: audioPath, fromSec: 0 } : { path: part.path, fromSec: part.fileFromSec }
        ),
        listPath,
    });
    return {
        audioPath,
        startSec: 0,
        cut: true,
        cutParts: 1,
        parts,
        ...(opening.list ? { list: opening.list } : {}),
        player: player.id,
        argv: opening.argv,
    };
}

function playPart(slice: PlayPart): PlayPart {
    return {
        path: slice.path,
        ...(slice.channel !== undefined ? { channel: slice.channel } : {}),
        fileFromSec: slice.fileFromSec,
        fileToSec: slice.fileToSec,
    };
}

/**
 * Starts a plan: its WAV is cut and its list written first, then the player runs detached, so it plays on after
 * `play`. A list is renamed into place, so a player never reads it half written.
 */
export async function startPlaybackPlan(plan: SlicePlaybackPlan): Promise<number> {
    const [first, ...rest] = plan.parts.slice(0, plan.cutParts ?? 1);

    if (plan.cut && first) {
        await cutSlice({ slice: first, next: rest, path: plan.audioPath });
    }

    if (plan.list) {
        mkdirSync(dirname(plan.list.path), { recursive: true });
        const partial = join(dirname(plan.list.path), `.${basename(plan.list.path)}-${randomUUID()}`);
        await Bun.write(partial, plan.list.text);
        renameSync(partial, plan.list.path);
    }

    const child = Bun.spawn(plan.argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    child.unref();
    log.debug({ argv: plan.argv, pid: child.pid }, "player started");
    return child.pid;
}

/**
 * Where a cut slice goes: `<clip cache>/<meeting>/<time>-<track>-<key>.wav`, the key from the recording (its path, time
 * and size), the channel and the file seconds, so the same slice of the same recording is cut once.
 */
function sliceCachePath(slice: MeetingSlice, next: readonly PlayPart[] = []): string {
    const { mtimeMs, size } = statSync(slice.path);
    const key = Bun.hash(
        SafeJSON.stringify([
            "slice-v1",
            slice.path,
            mtimeMs,
            size,
            slice.channel ?? null,
            slice.fileFromSec,
            slice.fileToSec,
            // A cut that joins later pieces names them; a cut of one file keeps its earlier key.
            ...(next.length > 0 ? [next.map((part) => [part.path, part.fileFromSec, part.fileToSec])] : []),
        ])
    ).toString(36);
    const name = `${formatClock(slice.fromSec)}-${slice.track}`.replace(/[^\p{L}\p{N}]+/gu, "-");
    return join(momentCacheDir(slice.meeting), `${name}-${key}.wav`);
}

/**
 * Cuts a slice to the WAV `path` at the recording's own rate, one channel when the slice names one; `next` parts (the
 * later pieces of a range) are joined after it. A cut made before is used again (its time is touched, so the cache
 * keeps it longest); a new one is written beside it and renamed over it, so a player never opens it half written.
 */
export async function cutSlice(options: { slice: PlayPart; next?: readonly PlayPart[]; path: string }): Promise<void> {
    const { slice, path } = options;
    const parts = [slice, ...(options.next ?? [])];

    if (existsSync(path)) {
        const now = new Date();
        utimesSync(path, now, now);
        log.debug({ path }, "sound slice from the cache");
        return;
    }

    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is not installed (brew install ffmpeg); it cuts the sound to play.");
    }

    const partial = join(dirname(path), `.${basename(path, ".wav")}-${randomUUID()}.wav`);
    mkdirSync(dirname(path), { recursive: true });
    const argv = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-y",
        ...(parts.length === 1
            ? [
                  "-ss",
                  String(slice.fileFromSec),
                  "-i",
                  slice.path,
                  "-t",
                  String(slice.fileToSec - slice.fileFromSec),
                  ...(slice.channel === undefined ? [] : ["-af", channelFilter(slice.channel)]),
              ]
            : [
                  ...parts.flatMap((part) => [
                      "-ss",
                      String(part.fileFromSec),
                      "-t",
                      String(part.fileToSec - part.fileFromSec),
                      "-i",
                      part.path,
                  ]),
                  "-filter_complex",
                  `${parts
                      .map(
                          (part, index) =>
                              `[${index}:a]${part.channel === undefined ? "anull" : channelFilter(part.channel)}[a${index}]`
                      )
                      .join(
                          ";"
                      )};${parts.map((_, index) => `[a${index}]`).join("")}concat=n=${parts.length}:v=0:a=1[out]`,
                  "-map",
                  "[out]",
              ]),
        "-c:a",
        "pcm_s16le",
        partial,
    ];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 600_000 });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    log.debug({ argv, code }, "sound slice cut");

    if (code !== 0) {
        if (existsSync(partial)) {
            unlinkSync(partial);
        }

        throw new Error(`ffmpeg could not cut the sound (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    }

    renameSync(partial, path);
    trimMomentCache({ keep: path });
}

/** Cuts a slice into the clip cache and plays it once, to its end, in the Moment player (`playback.listen.player`). */
export async function playSoundSlice(options: {
    slice: MeetingSlice;
    player?: string;
}): Promise<{ pid: number; player: (typeof LISTEN_PLAYERS)[number] }> {
    const listen = (await new MeetingsConfigStore().read()).global.playback.listen;
    const requested = options.player === undefined ? undefined : LISTEN_PLAYERS.find((id) => id === options.player);
    if (options.player !== undefined && !requested) {
        throw new Error(`--player needs ${LISTEN_PLAYERS.join(", ")}.`);
    }
    const player = requested ? PLAYERS[requested] : pickPlayer(listen.player, LISTEN_PLAYERS);
    if (!player?.available()) {
        throw new Error("No Moment player available (afplay, VLC, ffplay).");
    }
    const path = sliceCachePath(options.slice);
    await cutSlice({ slice: options.slice, path });
    const argv = player.clipArgv(path);
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 3_600_000 });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    log.debug({ argv, code }, "sound slice played");

    if (code !== 0) {
        throw new Error(`Sound playback failed (exit ${code}): ${stderr.trim()}`);
    }
    return { pid: child.pid, player: player.id };
}

/**
 * The end of the last speech the source keeps (its speech segments), which bounds a play. A native recording takes it
 * from the source too: the recorder's pieces hold sound, not speech, and run on as long as the recorder did. Undefined
 * when the meeting has no source or the source keeps no segments; a source that cannot be read is logged and sets no
 * bound, so a recorder track still plays.
 */
async function lastSpeechSec(opened: OpenedMeeting): Promise<number | undefined> {
    if (!sourceRefOf(opened.record)) {
        return undefined;
    }

    try {
        return segmentsEndSec((await opened.evidence())?.segments ?? []);
    } catch (error) {
        log.debug({ error, meeting: opened.record.id }, "source evidence unreadable; no speech end");
        return undefined;
    }
}

/**
 * The seat heard at `atSec`, and the slice of the track that plays it there: `track`, else the seat's best one. A time
 * more than `PAST_END_GRACE_SEC` after the last speech is refused first.
 */
async function listenAt(options: {
    opened: OpenedMeeting;
    atSec: number;
    track?: TrackKind;
}): Promise<{ sound: MeetingSound; seat: Seat; at?: SoundSlice }> {
    const { opened, atSec, track } = options;
    const late = pastTheEnd(atSec, await lastSpeechSec(opened));

    if (late) {
        throw new Error(late);
    }

    const sound = await opened.sound();
    let seat: Seat | undefined = track ? sound.tracks.find((one) => one.kind === track)?.seat : undefined;
    if (!seat && !track) {
        // Find the one line spoken at atSec first (its end comes from the next line), then measure only that line.
        const entries = (await opened.meeting()).transcript;
        const transcript = new TranscriptLines(entries);
        const at = entries.findIndex((_, index) => {
            const span = transcript.span(index);
            return span !== undefined && span.fromSec <= atSec && atSec < span.toSec;
        });
        const startSec = entries[at]?.startSec;
        const line =
            startSec === undefined
                ? undefined
                : lineEvidence(
                      entries,
                      (await opened.evidence()) ?? { segments: [], speaking: [] },
                      undefined,
                      (await opened.energy()).share,
                      { window: { fromSec: startSec, toSec: startSec } }
                  ).find((one) => one.index === at);
        const share = line?.micShare ?? line?.energyMic;
        seat = share === undefined || share === 0.5 ? undefined : share > 0.5 ? "mic" : "call";
    }
    if (!seat) {
        throw new Error("No known seat at this time; choose --track with a track listed by show.");
    }
    const at = sound.slice({
        seat,
        fromSec: atSec,
        toSec: atSec + 0.001,
        purpose: "listen",
        ...(track ? { track } : {}),
    });
    return { sound, seat, ...(at ? { at } : {}) };
}

/**
 * A range: the best track of the seat heard at `atSec` (or `track`) from `fromSec` to `toSec`, in one file when one
 * piece holds it. A range over a piece boundary of a recorder track is the pieces it covers (`soundRun`), cut joined;
 * a muted or lost span in it plays as the silence the file holds.
 */
export async function playbackRange(options: {
    opened: OpenedMeeting;
    atSec: number;
    fromSec: number;
    toSec: number;
    track?: TrackKind;
}): Promise<[SoundSlice, ...SoundSlice[]]> {
    const { sound, seat, at } = await listenAt(options);
    const slice = sound.slice({
        seat,
        fromSec: options.fromSec,
        toSec: options.toSec,
        purpose: "listen",
        ...(options.track ? { track: options.track } : {}),
    });

    if (slice) {
        return [slice];
    }

    const track = sound.tracks.find((one) => one.kind === at?.track);
    const [first, ...next] = track ? soundRun(track, { fromSec: options.fromSec, toSec: options.toSec }) : [];

    if (!first || next.length === 0) {
        throw new Error("No audible track covers this interval; choose a shorter interval or another --track.");
    }

    return [first, ...next];
}

/**
 * A play from `atSec` on: the track heard there (`track`, else the best one of the line's seat), from `fromSec`
 * through its later pieces to its end (`soundRun`), so a native recording plays on past its 60 s piece.
 */
export async function playbackRun(options: {
    opened: OpenedMeeting;
    atSec: number;
    fromSec: number;
    track?: TrackKind;
}): Promise<[SoundSlice, ...SoundSlice[]]> {
    const { sound, at } = await listenAt(options);
    const track = sound.tracks.find((one) => one.kind === at?.track);
    const [first, ...next] = track ? soundRun(track, { fromSec: options.fromSec }) : [];
    if (!first) {
        throw new Error("No audible track covers this time; choose another --track with a track listed by show.");
    }
    return [first, ...next];
}
