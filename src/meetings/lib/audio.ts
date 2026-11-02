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

/** Cuts `fromSec - padSec` to `toSec + padSec` of the recording into a WAV clip. Needs ffmpeg. */
export async function cutClip(options: {
    audioPath: string;
    fromSec: number;
    toSec: number;
    padSec: number;
    outPath: string;
}): Promise<void> {
    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is not installed (brew install ffmpeg); it cuts the clip to listen to.");
    }

    const startSec = Math.max(0, options.fromSec - options.padSec);
    const lengthSec = options.toSec + options.padSec - startSec;
    mkdirSync(dirname(options.outPath), { recursive: true });
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

/** Starts the clip; the caller kills the process when the listener moves on. */
export function playClip(player: ListenPlayer, path: string): Bun.Subprocess {
    const argv = CLIP_PLAYERS[player].argv(path);
    log.debug({ argv }, "clip playing");
    return Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}
