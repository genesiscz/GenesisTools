import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONTAINER_CLOCK_FILTER } from "@genesiscz/utils/audio/converter";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { DEFAULT_TONE_SOUND, type LISTEN_PLAYERS } from "@genesiscz/utils/meetings/config";
import { MeetingsStateError } from "@genesiscz/utils/meetings/conflict";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { z } from "zod";
import { PLAYERS, pickPlayer } from "./players";
import { withPreservedSourceAudio } from "./source-audio";
import { meetingSource, sourceRefOf } from "./sources";
import type { ToneSound } from "./tone-sound";

const { log } = logger.scoped("meetings-audio");

/** A meeting's recording and the end of its last speech, both from the source's evidence. */
export interface MeetingAudio {
    audioPath: string;
    /** The end of the last speech segment on the transcript clock; undefined when the source keeps no segments. */
    lastSpeechSec?: number;
}

/** The recording of the first linked source that keeps one on this Mac. Throws a message ready to print. */
export async function meetingAudioPath(record: MeetingRecord): Promise<string> {
    return (await meetingAudio(record)).audioPath;
}

/** `meetingAudioPath` with the end of the last speech, which `play` needs to refuse a time past the end. */
export async function meetingAudio(record: MeetingRecord): Promise<MeetingAudio> {
    const ref = sourceRefOf(record);

    if (!ref) {
        throw new MeetingsStateError("no-transcript-source", `${record.id} has no linked source with audio.`);
    }

    const evidence = withPreservedSourceAudio(
        record,
        await (await meetingSource(ref.sourceId)).evidence(ref.sourceMeetingId)
    );

    if (!evidence?.audioPath) {
        throw new Error(`The source keeps no audio for ${record.id} on this Mac.`);
    }

    const lastSpeechSec = evidence.segments.reduce<number | undefined>(
        (last, segment) => (last === undefined || segment.endSec > last ? segment.endSec : last),
        undefined
    );
    return { audioPath: evidence.audioPath, ...(lastSpeechSec === undefined ? {} : { lastSpeechSec }) };
}

/** What one clip holds: the heard stretch, the audio around it, and where its tone sounds (a time in the recording). */
export interface ClipPlan {
    fromSec: number;
    toSec: number;
    /** Audio before the heard stretch, and after it unless `padAfterSec` says otherwise. */
    padSec: number;
    /** Audio after the heard stretch, when it differs from `padSec` (`playback.listen.padAfterSec`). */
    padAfterSec?: number;
    toneAtSec?: number;
    /** The tone's sound (`playback.listen.tone.sound`); the shipped sound when absent. */
    toneSound?: ToneSound;
}

/** What a recording holds, from ffprobe: its audio streams (tracks), their most channels, and its length. */
export interface AudioProbe {
    tracks: number;
    channels: number;
    durationSec: number;
}

const probeSchema = z.object({
    streams: z.array(z.object({ codec_type: z.string().optional(), channels: z.number().optional() })).default([]),
    format: z.object({ duration: z.union([z.string(), z.number()]).optional() }).optional(),
});

/** The audio streams and length, bounded to 10 seconds and 64 KiB per pipe. Needs ffprobe; throws a printable error. */
export async function probeAudio(path: string, options: { signal?: AbortSignal } = {}): Promise<AudioProbe> {
    options.signal?.throwIfAborted();
    if (!Bun.which("ffprobe")) {
        throw new Error("ffprobe is not installed (brew install ffmpeg); it reads the recording's tracks.");
    }

    const argv = ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,channels:format=duration"];
    const {
        status: code,
        stdout,
        stderr,
        error,
    } = await boundedCommand({
        command: [...argv, "-of", "json", path],
        timeoutMs: 10_000,
        maxBufferBytes: 65_536,
        signal: options.signal,
    });
    options.signal?.throwIfAborted();
    log.debug({ path, code }, "recording probed");

    if (error?.code === "ETIMEDOUT") {
        throw new Error(`ffprobe timed out after 10 seconds while reading ${path}`, { cause: error });
    }
    if (error?.code === "ENOBUFS") {
        throw new Error(`ffprobe output exceeded 64 KiB while reading ${path}`, { cause: error });
    }
    if (error || code !== 0) {
        throw new Error(
            `ffprobe could not read ${path} (exit ${code}): ${error?.message ?? stderr.trim().slice(0, 300)}`,
            { cause: error }
        );
    }

    const probe = probeSchema.parse(SafeJSON.parse(stdout, { strict: true }));
    const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
    return {
        tracks: audio.length,
        channels: Math.max(0, ...audio.map((stream) => stream.channels ?? 0)),
        durationSec: Number(probe.format?.duration ?? 0) || 0,
    };
}

/** How a cut tells its caller how far it is, and how the caller stops it. */
export interface CutControl {
    /** Aborting kills ffmpeg; the cut throws an `AbortError`. */
    signal?: AbortSignal;
    /** 0 to 1 of the clip written so far, a few times a second. */
    onProgress?: (fraction: number) => void;
    /** The recording's audio streams; more than one are mixed into the clip (a recording with one track per side). */
    tracks?: number;
}

/** The ffmpeg input of a tone: its sound file, or a sine made on the spot; both `sound.sec` long. */
function toneInput(sound: ToneSound): string[] {
    return sound.file
        ? ["-t", String(sound.sec), "-i", sound.file]
        : ["-f", "lavfi", "-t", String(sound.sec), "-i", `sine=frequency=${sound.hz}`];
}

/**
 * Cuts `fromSec - padSec` to `toSec + padAfterSec` (padSec when absent) of the recording into a WAV clip. Needs ffmpeg. With `toneAtSec` (a
 * time in the recording) a short tone sounds at that moment of the clip, so the listener knows which words the
 * question is about. A recording with several audio streams is mixed into one, so no side of the call is lost.
 */
export async function cutClip(options: ClipPlan & CutControl & { audioPath: string; outPath: string }): Promise<void> {
    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is not installed (brew install ffmpeg); it cuts the clip to listen to.");
    }

    const startSec = Math.max(0, options.fromSec - options.padSec);
    const lengthSec = options.toSec + (options.padAfterSec ?? options.padSec) - startSec;
    mkdirSync(dirname(options.outPath), { recursive: true });
    const toneMs =
        options.toneAtSec === undefined ? undefined : Math.round(Math.max(0, options.toneAtSec - startSec) * 1000);
    const sound = options.toneSound ?? DEFAULT_TONE_SOUND;
    const tracks = options.tracks ?? 1;
    // Preserve each track's timestamp gaps before mixing; padding only the mixed result
    // loses the offset between tracks. After input seeking, zero is the clip's start.
    const clockedTracks = Array.from(
        { length: tracks },
        (_, index) => `[0:a:${index}]${CONTAINER_CLOCK_FILTER}[a${index}]`
    ).join(";");
    const inputs = Array.from({ length: tracks }, (_, index) => `[a${index}]`).join("");
    const speech = `${clockedTracks};${inputs}${
        tracks > 1 ? `amix=inputs=${tracks}:duration=longest:normalize=0` : "anull"
    }`;
    const graph =
        toneMs === undefined
            ? ["-filter_complex", `${speech}[out]`, "-map", "[out]"]
            : [
                  ...toneInput(sound),
                  "-filter_complex",
                  `${speech}[speech];[1:a]volume=${sound.volume},adelay=delays=${toneMs}:all=1[tone];[speech][tone]amix=inputs=2:duration=first:normalize=0[out]`,
                  "-map",
                  "[out]",
              ];
    const argv = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-ss",
        String(startSec),
        "-t",
        String(lengthSec),
        "-i",
        options.audioPath,
        ...graph,
        "-c:a",
        "pcm_s16le",
        options.outPath,
    ];
    const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
        killSignal: "SIGKILL",
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const progress = readProgress(proc.stdout, (outSec) => options.onProgress?.(Math.min(1, outSec / lengthSec)));
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), progress]);
    log.debug({ argv, code }, "clip cut");

    if (options.signal?.aborted) {
        throw new DOMException(`the cut of ${options.outPath} was cancelled`, "AbortError");
    }

    if (code !== 0) {
        throw new Error(
            `ffmpeg could not cut clip ${options.outPath} (exit ${code}, signal ${proc.signalCode ?? "none"}; deadline 60 s): ${stderr.trim().slice(0, 300)}`
        );
    }
}

/** Follows ffmpeg's `-progress` lines and reports each `out_time_us` in seconds; a process with no stdout reports none. */
async function readProgress(stream: unknown, report: (outSec: number) => void): Promise<void> {
    if (!(stream instanceof ReadableStream)) {
        return;
    }

    const decoder = new TextDecoder();
    let pending = "";

    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines) {
            const match = /^out_time_us=(\d+)$/.exec(line.trim());

            if (match) {
                report(Number(match[1]) / 1_000_000);
            }
        }
    }
}

/** The tone alone as a WAV, for a sound picker's Play button (`tone.preview`). Needs ffmpeg. */
export async function cutTone(sound: ToneSound, outPath: string): Promise<void> {
    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is not installed (brew install ffmpeg); it makes the tone.");
    }

    mkdirSync(dirname(outPath), { recursive: true });
    const argv = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        ...toneInput(sound),
        "-af",
        `volume=${sound.volume}`,
        "-c:a",
        "pcm_s16le",
        outPath,
    ];
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000 });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    log.debug({ argv, code }, "tone made");

    if (code !== 0) {
        throw new Error(`ffmpeg could not make the tone (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    }
}

type ListenPlayer = (typeof LISTEN_PLAYERS)[number];

/** The configured player when it is there, else the first one that is. */
export function clipPlayer(preferred: ListenPlayer, all: readonly ListenPlayer[]): ListenPlayer | undefined {
    return pickPlayer(preferred, all)?.id;
}

/** A clip that plays now or after a delay; `stop` cancels it before it starts, or ends it while it plays. */
export interface PlayingClip {
    stop(): void;
}

/**
 * Starts the clip after `delayMs`, so a question on screen is read before the audio starts. With `repeatGapMs`, the
 * clip plays again after that pause each time it ends, until `stop`.
 */
export function playClip(
    player: ListenPlayer,
    path: string,
    options: { delayMs?: number; repeatGapMs?: number } = {}
): PlayingClip {
    const argv = PLAYERS[player].clipArgv(path);
    const { delayMs = 0, repeatGapMs } = options;
    let proc: Bun.Subprocess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const start = (): void => {
        log.debug({ argv }, "clip playing");
        const current = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        proc = current;

        if (repeatGapMs === undefined) {
            return;
        }

        void current.exited.then((code) => {
            // A player that fails would fail again: repeat only a clip that played to its end.
            if (!stopped && proc === current && code === 0) {
                timer = setTimeout(start, repeatGapMs);
            }
        });
    };

    if (delayMs > 0) {
        timer = setTimeout(start, delayMs);
    } else {
        start();
    }

    return {
        stop: () => {
            stopped = true;
            clearTimeout(timer);
            proc?.kill();
        },
    };
}
