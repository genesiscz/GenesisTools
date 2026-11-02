import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import type { LISTEN_PLAYERS } from "@genesiscz/utils/meetings/config";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { meetingSource } from "./sources";

const { log } = logger.scoped("meetings-audio");

const VLC = "/Applications/VLC.app/Contents/MacOS/VLC";

/** The recording of the first linked source that keeps one on this Mac. Throws a message ready to print. */
export async function meetingAudioPath(record: MeetingRecord): Promise<string> {
    const [sourceId, block] =
        Object.entries(record.sources).find(([, value]) => typeof value.meetingId === "string") ?? [];

    if (!sourceId || typeof block?.meetingId !== "string") {
        throw new Error(`${record.id} has no linked source with audio.`);
    }

    const evidence = await (await meetingSource(sourceId)).evidence(block.meetingId);

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
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    log.debug({ argv, code }, "clip cut");

    if (code !== 0) {
        throw new Error(`ffmpeg could not cut the clip (exit ${code}): ${stderr.trim().slice(0, 300)}`);
    }
}

type ListenPlayer = (typeof LISTEN_PLAYERS)[number];

/** How each player is found and started on a clip, from its start to its end. */
const CLIP_PLAYERS: Record<ListenPlayer, { available: () => boolean; argv: (path: string) => string[] }> = {
    afplay: {
        available: () => existsSync("/usr/bin/afplay"),
        argv: (path) => ["/usr/bin/afplay", path],
    },
    vlc: {
        available: () => existsSync(VLC),
        argv: (path) => [VLC, "--play-and-exit", path],
    },
    ffplay: {
        available: () => Bun.which("ffplay") !== null,
        argv: (path) => ["ffplay", "-nodisp", "-autoexit", "-loglevel", "error", path],
    },
};

/** The configured player when it is there, else the first one that is. */
export function clipPlayer(preferred: ListenPlayer, all: readonly ListenPlayer[]): ListenPlayer | undefined {
    return [preferred, ...all.filter((name) => name !== preferred)].find((name) => CLIP_PLAYERS[name].available());
}

/** A clip that plays now or after a delay; `stop` cancels it before it starts, or ends it while it plays. */
export interface PlayingClip {
    stop(): void;
}

/** Starts the clip after `delayMs`, so a question on screen is read before the audio starts. */
export function playClip(player: ListenPlayer, path: string, delayMs = 0): PlayingClip {
    const argv = CLIP_PLAYERS[player].argv(path);
    let proc: Bun.Subprocess | undefined;
    const start = (): void => {
        log.debug({ argv }, "clip playing");
        proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    };
    const timer = delayMs > 0 ? setTimeout(start, delayMs) : undefined;

    if (!timer) {
        start();
    }

    return {
        stop: () => {
            clearTimeout(timer);
            proc?.kill();
        },
    };
}
