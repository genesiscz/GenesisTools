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

/** RMS loudness per 100 ms of the left (the user's microphone) and right (the call) channel of a stereo recording. */
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
