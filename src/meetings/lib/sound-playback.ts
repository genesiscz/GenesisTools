import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LISTEN_PLAYERS, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { momentCacheDir, trimMomentCache } from "./moment";
import type { OpenedMeeting } from "./opened-meeting";
import { PLAYERS, type PlaybackPlan, pickPlayer, type SeekingPlayer } from "./players";
import type { SoundSlice, TrackKind } from "./sound";

const { log } = logger.scoped("meetings-playback");

/** A slice with the meeting it is from and the meeting second it starts at, which name its cut in the clip cache. */
export type MeetingSlice = SoundSlice & { meeting: string; fromSec: number };

/** What a player opens for a slice: the file and the second it starts at. */
export interface SliceOpening {
    audioPath: string;
    startSec: number;
    /** `audioPath` is a WAV cut from the slice into the clip cache; it exists once `cutSlice` ran. */
    cut: boolean;
}

/** A `tools meetings play` plan for a slice: what it opens, in which seeking player, with which command line. */
export type SlicePlaybackPlan = PlaybackPlan & SliceOpening;

/**
 * What a player opens for a slice. An open-ended play of a file with one channel opens the recording itself at the
 * slice's second, so the player shows the real file and can seek in it. One channel of a stereo source, or a bounded
 * interval, is a WAV cut into the clip cache. No player reads a pipe: the VLC app took `/dev/stdin` for an empty item
 * named "stdin" and played nothing.
 */
export function sliceOpening(options: { slice: MeetingSlice; openEnded: boolean }): SliceOpening {
    const { slice } = options;

    if (options.openEnded && slice.channel === undefined) {
        return { audioPath: slice.path, startSec: slice.fileFromSec, cut: false };
    }

    return { audioPath: sliceCachePath(slice), startSec: 0, cut: true };
}

/** The plan `tools meetings play` starts: `sliceOpening` in a player that opens a file at a second. */
export function slicePlaybackPlan(options: {
    slice: MeetingSlice;
    openEnded: boolean;
    player: SeekingPlayer;
}): SlicePlaybackPlan {
    const opening = sliceOpening(options);
    return {
        ...opening,
        player: options.player.id,
        argv: options.player.fromArgv(opening.audioPath, opening.startSec),
    };
}

/** Starts a plan: its WAV is cut first when it is a cut, then the player runs detached, so it plays on after `play`. */
export async function startPlaybackPlan(options: { plan: SlicePlaybackPlan; slice: SoundSlice }): Promise<number> {
    const { plan } = options;

    if (plan.cut) {
        await cutSlice({ slice: options.slice, path: plan.audioPath });
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
function sliceCachePath(slice: MeetingSlice): string {
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
        ])
    ).toString(36);
    const name = `${formatClock(slice.fromSec)}-${slice.track}`.replace(/[^\p{L}\p{N}]+/gu, "-");
    return join(momentCacheDir(slice.meeting), `${name}-${key}.wav`);
}

/**
 * Cuts a slice to the WAV `path` at the recording's own rate, one channel when the slice names one. A cut made before
 * is used again (its time is touched, so the cache keeps it longest); a new one is written beside it and renamed over
 * it, so a player never opens it half written.
 */
export async function cutSlice(options: { slice: SoundSlice; path: string }): Promise<void> {
    const { slice, path } = options;

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
        "-ss",
        String(slice.fileFromSec),
        "-i",
        slice.path,
        "-t",
        String(slice.fileToSec - slice.fileFromSec),
        ...(slice.channel === undefined ? [] : ["-af", `pan=mono|c0=c${slice.channel}`]),
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

export async function playbackSlice(options: {
    opened: OpenedMeeting;
    atSec: number;
    fromSec: number;
    toSec?: number;
    track?: TrackKind;
}): Promise<SoundSlice> {
    const { opened, atSec, fromSec, track } = options;
    const sound = await opened.sound();
    let seat: "mic" | "call" | undefined = track ? sound.tracks.find((one) => one.kind === track)?.seat : undefined;
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
    const preferred = sound.slice({
        seat,
        fromSec: atSec,
        toSec: atSec + 0.001,
        purpose: "listen",
        ...(track ? { track } : {}),
    });
    const end =
        options.toSec ??
        sound.tracks
            .find((one) => one.kind === preferred?.track)
            ?.pieces.find(
                (piece) =>
                    piece.path === preferred?.path &&
                    piece.zeroSec <= atSec &&
                    atSec < piece.zeroSec + piece.durationSec
            )?.durationSec;
    const zero =
        sound.tracks
            .find((one) => one.kind === preferred?.track)
            ?.pieces.find((piece) => piece.path === preferred?.path)?.zeroSec ?? 0;
    const slice =
        end !== undefined && Number.isFinite(end)
            ? sound.slice({
                  seat,
                  fromSec,
                  toSec: options.toSec ?? end + zero,
                  purpose: "listen",
                  ...(track ? { track } : {}),
              })
            : undefined;
    if (!slice) {
        throw new Error("No audible track covers this interval; choose a shorter interval or another --track.");
    }
    return slice;
}
