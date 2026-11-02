import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("meetings-energy");

/** Samples per second of the downmix, and samples per energy block (100 ms). */
const RATE = 2000;
const BLOCK = 200;
/** Below this mean RMS on both channels together the line is near silence, and their ratio means nothing. */
const QUIET = 60;
export const ENERGY_BLOCKS_PER_SEC = RATE / BLOCK;

/**
 * RMS loudness per 100 ms of the left and right channel of a stereo recording. Which one is the user's microphone is
 * not assumed: `calibrateChannels` decides it per recording.
 */
export interface ChannelEnergy {
    left: Float32Array;
    right: Float32Array;
}

function rmsBlocks(raw: Buffer): Float32Array {
    const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
    const blocks = new Float32Array(Math.ceil(samples.length / BLOCK));

    for (let block = 0; block < blocks.length; block += 1) {
        const start = block * BLOCK;
        const end = Math.min(samples.length, start + BLOCK);
        let sum = 0;

        for (let index = start; index < end; index += 1) {
            sum += samples[index]! * samples[index]!;
        }

        blocks[block] = Math.sqrt(sum / Math.max(1, end - start));
    }

    return blocks;
}

function readCache(path: string, audioPath: string): ChannelEnergy | undefined {
    if (!existsSync(path) || statSync(path).mtimeMs < statSync(audioPath).mtimeMs) {
        return undefined;
    }

    const bytes = readFileSync(path);
    const all = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const half = all.length / 2;
    return { left: all.slice(0, half), right: all.slice(half) };
}

/**
 * The energy of both channels, cached in `cachePath` (rebuilt when the audio is newer). Needs ffmpeg; without it, or
 * on a mono file, returns undefined and logs why, and callers leave the energy terms out.
 */
export async function channelEnergy(audioPath: string, cachePath: string): Promise<ChannelEnergy | undefined> {
    const cached = readCache(cachePath, audioPath);

    if (cached) {
        return cached;
    }

    if (!Bun.which("ffmpeg")) {
        log.info("ffmpeg is not installed; the energy check is skipped");
        return undefined;
    }

    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    const leftRaw = join(dir, "L.raw");
    const rightRaw = join(dir, "R.raw");
    const proc = Bun.spawn(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            audioPath,
            "-filter_complex",
            "[0:a]channelsplit=channel_layout=stereo[L][R]",
            "-map",
            "[L]",
            "-ar",
            String(RATE),
            "-f",
            "s16le",
            leftRaw,
            "-map",
            "[R]",
            "-ar",
            String(RATE),
            "-f",
            "s16le",
            rightRaw,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" }
    );
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    try {
        if (exitCode !== 0) {
            log.warn({ exitCode, stderr: stderr.slice(-400), audioPath }, "ffmpeg downmix failed; energy skipped");
            return undefined;
        }

        const energy = { left: rmsBlocks(readFileSync(leftRaw)), right: rmsBlocks(readFileSync(rightRaw)) };
        const joined = new Float32Array(energy.left.length * 2);
        joined.set(energy.left, 0);
        joined.set(energy.right.subarray(0, energy.left.length), energy.left.length);
        writeFileSync(cachePath, Buffer.from(joined.buffer));
        log.debug({ cachePath, blocks: energy.left.length }, "energy cached");
        return energy;
    } finally {
        for (const raw of [leftRaw, rightRaw]) {
            if (existsSync(raw)) {
                unlinkSync(raw);
            }
        }
    }
}

/** The mean loudness of each channel over a time range, and the left channel's share of both (undefined when quiet). */
export function energyShare(
    energy: ChannelEnergy,
    fromSec: number,
    toSec: number
): { left: number; right: number; share?: number } {
    const from = Math.max(0, Math.floor(fromSec * ENERGY_BLOCKS_PER_SEC));
    const to = Math.max(from + 1, Math.min(energy.left.length, Math.ceil(toSec * ENERGY_BLOCKS_PER_SEC)));
    let left = 0;
    let right = 0;

    for (let block = from; block < to; block += 1) {
        left += energy.left[block] ?? 0;
        right += energy.right[block] ?? 0;
    }

    left /= to - from;
    right /= to - from;
    return { left, right, ...(left + right >= QUIET ? { share: left / (left + right) } : {}) };
}

/** Which channel holds the user's microphone, as one recording's tagged segments show it. */
export const CHANNEL_LAYOUTS = ["left-mic", "right-mic", "unknown"] as const;
export type ChannelLayout = (typeof CHANNEL_LAYOUTS)[number];

export interface ChannelCalibration {
    layout: ChannelLayout;
    /** The median left share over segments the recorder tagged as the microphone, and as the call. */
    micMedian?: number;
    systemMedian?: number;
    /** How many tagged segments were long and loud enough to count. */
    segments: { mic: number; system: number };
    /** Why the layout is unknown, ready to print. */
    reason?: string;
}

/** A tagged segment shorter than this says too little about its channel. */
const CALIBRATION_MIN_SEC = 1.5;
/** Fewer counted segments than this per tag, and the layout stays unknown. */
const CALIBRATION_MIN_SEGMENTS = 20;
/** The microphone's side holds at least this median share of its own segments, and at most `1 - SIDE` of the call's. */
const CALIBRATION_SIDE = 0.8;

function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Decides which channel is the microphone from the segments the recorder tagged "mic" and "system" (Wispr's live
 * segments). Measured on one Wispr recording: mic segments had a median left share of 0.964, call segments 0.004, so
 * left was the microphone there; another recorder, FaceTime or a system setting may differ, so nothing is assumed.
 * A mono recording (both channels alike) and a recorder with no tags come out "unknown".
 */
export function calibrateChannels(
    energy: ChannelEnergy,
    segments: Array<{ startSec: number; endSec: number; channel: string }>
): ChannelCalibration {
    const shares: Record<"mic" | "system", number[]> = { mic: [], system: [] };

    for (const segment of segments) {
        if (segment.endSec - segment.startSec < CALIBRATION_MIN_SEC) {
            continue;
        }

        if (segment.channel !== "mic" && segment.channel !== "system") {
            continue;
        }

        const { share } = energyShare(energy, segment.startSec, segment.endSec);

        if (share !== undefined) {
            shares[segment.channel].push(share);
        }
    }

    const counted = { mic: shares.mic.length, system: shares.system.length };
    const micMedian = median(shares.mic);
    const systemMedian = median(shares.system);
    const medians = {
        ...(micMedian === undefined ? {} : { micMedian: Math.round(micMedian * 1000) / 1000 }),
        ...(systemMedian === undefined ? {} : { systemMedian: Math.round(systemMedian * 1000) / 1000 }),
    };

    if (counted.mic < CALIBRATION_MIN_SEGMENTS || counted.system < CALIBRATION_MIN_SEGMENTS) {
        return {
            layout: "unknown",
            ...medians,
            segments: counted,
            reason: `too few tagged segments (${counted.mic} mic, ${counted.system} call; ${CALIBRATION_MIN_SEGMENTS} of each needed)`,
        };
    }

    if (micMedian! >= CALIBRATION_SIDE && systemMedian! <= 1 - CALIBRATION_SIDE) {
        return { layout: "left-mic", ...medians, segments: counted };
    }

    if (micMedian! <= 1 - CALIBRATION_SIDE && systemMedian! >= CALIBRATION_SIDE) {
        return { layout: "right-mic", ...medians, segments: counted };
    }

    return {
        layout: "unknown",
        ...medians,
        segments: counted,
        reason: `the channels do not separate the voices (mic median ${medians.micMedian}, call median ${medians.systemMedian})`,
    };
}

/** The microphone channel's share of the energy over a range, by the calibrated layout; undefined when unknown or quiet. */
export function micShare(
    energy: ChannelEnergy,
    layout: ChannelLayout,
    fromSec: number,
    toSec: number
): number | undefined {
    if (layout === "unknown") {
        return undefined;
    }

    const { share } = energyShare(energy, fromSec, toSec);

    if (share === undefined) {
        return undefined;
    }

    return layout === "left-mic" ? share : 1 - share;
}
