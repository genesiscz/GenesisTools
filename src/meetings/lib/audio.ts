import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { LISTEN_PLAYERS } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { PLAYERS, pickPlayer } from "./players";
import { meetingSource, sourceRefOf } from "./sources";

const { log } = logger.scoped("meetings-audio");

/** The recording of the first linked source that keeps one on this Mac. Throws a message ready to print. */
export async function meetingAudioPath(record: MeetingRecord): Promise<string> {
    const ref = sourceRefOf(record);

    if (!ref) {
        throw new Error(`${record.id} has no linked source with audio.`);
    }

    const evidence = await (await meetingSource(ref.sourceId)).evidence(ref.sourceMeetingId);

    if (!evidence?.audioPath) {
        throw new Error(`The source keeps no audio for ${record.id} on this Mac.`);
    }

    return evidence.audioPath;
}

/** The tone `cutClip` mixes in before the asked spot, so the listener knows which words the question is about. */
const TONE = { hz: 880, sec: 0.15, volume: 0.6 };

/**
 * Cuts `fromSec - padSec` to `toSec + padSec` of the recording into a WAV clip. Needs ffmpeg. With `toneAtSec` (a
 * time in the recording) a short tone sounds at that moment of the clip.
 */
export async function cutClip(options: {
    audioPath: string;
    fromSec: number;
    toSec: number;
    padSec: number;
    outPath: string;
    toneAtSec?: number;
}): Promise<void> {
    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is not installed (brew install ffmpeg); it cuts the clip to listen to.");
    }

    const startSec = Math.max(0, options.fromSec - options.padSec);
    const lengthSec = options.toSec + options.padSec - startSec;
    mkdirSync(dirname(options.outPath), { recursive: true });
    const toneMs =
        options.toneAtSec === undefined ? undefined : Math.round(Math.max(0, options.toneAtSec - startSec) * 1000);
    const tone =
        toneMs === undefined
            ? []
            : [
                  "-f",
                  "lavfi",
                  "-t",
                  String(TONE.sec),
                  "-i",
                  `sine=frequency=${TONE.hz}`,
                  "-filter_complex",
                  `[1:a]volume=${TONE.volume},adelay=delays=${toneMs}:all=1[tone];[0:a][tone]amix=inputs=2:duration=first:normalize=0[out]`,
                  "-map",
                  "[out]",
              ];
    const argv = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-ss",
        String(startSec),
        "-t",
        String(lengthSec),
        "-i",
        options.audioPath,
        ...tone,
        "-c:a",
        "pcm_s16le",
        options.outPath,
    ];
    const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 60_000,
        killSignal: "SIGKILL",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    log.debug({ argv, code }, "clip cut");

    if (code !== 0) {
        throw new Error(
            `ffmpeg could not cut clip ${options.outPath} (exit ${code}, signal ${proc.signalCode ?? "none"}; deadline 60 s): ${stderr.trim().slice(0, 300)}`
        );
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
