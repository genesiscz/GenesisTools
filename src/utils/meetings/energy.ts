import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

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

export function readCachedChannelEnergy(path: string, audioPath: string): ChannelEnergy | undefined {
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
    const cached = readCachedChannelEnergy(cachePath, audioPath);

    if (cached) {
        return cached;
    }

    if (!Bun.which("ffmpeg")) {
        log.info("ffmpeg is not installed; the energy check is skipped");
        return undefined;
    }

    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    const build = randomUUID();
    const leftRaw = join(dir, `${build}-L.raw`);
    const rightRaw = join(dir, `${build}-R.raw`);
    try {
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
            { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" }
        );
        const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

        if (proc.signalCode === "SIGKILL") {
            throw new Error(`ffmpeg energy processing terminated for ${audioPath} (deadline 300 s)`);
        }

        if (exitCode !== 0) {
            log.warn({ exitCode, stderr: stderr.slice(-400), audioPath }, "ffmpeg downmix failed; energy skipped");
            return undefined;
        }

        const energy = { left: rmsBlocks(readFileSync(leftRaw)), right: rmsBlocks(readFileSync(rightRaw)) };
        const joined = new Float32Array(energy.left.length * 2);
        joined.set(energy.left, 0);
        joined.set(energy.right.subarray(0, energy.left.length), energy.left.length);
        atomicWriteFileSync(cachePath, Buffer.from(joined.buffer));
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
    /** Descriptive share on the declared microphone side during its loud windows. Layout carries the verdict. */
    sourceMicShare?: number;
    /** Median left RMS share of the uncontested part of each counted tag. */
    micMedian?: number;
    systemMedian?: number;
    /** How many tagged segments were long and loud enough to count. */
    segments: { mic: number; system: number };
    /** Why the layout is unknown, or the audio evidence used in the absence of usable tags. */
    reason?: string;
}

/** A tagged segment shorter than this says too little about its channel. */
const CALIBRATION_MIN_SEC = 1.5;
/** The minimum independent observations per channel when using recorder tags. */
const CALIBRATION_MIN_SEGMENTS = 20;
export const DEFAULT_CHANNEL_MIN_SEPARATION = 0.3;

/** The middle value (the mean of the two middle ones for an even count); undefined for none. */
export function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

type TaggedSpan = { startSec: number; endSec: number; channel: string };

/** Each vote uses distinct audio blocks where only its source is tagged. Short tags still mask the other source. */
function uncontestedShares(energy: ChannelEnergy, segments: TaggedSpan[]) {
    const shares: Record<"mic" | "system", number[]> = { mic: [], system: [] };
    const mask = new Uint8Array(Math.min(energy.left.length, energy.right.length));
    const spans: Array<{ from: number; to: number; channel: keyof typeof shares; bit: number }> = [];
    for (const segment of segments) {
        if (segment.channel !== "mic" && segment.channel !== "system") {
            continue;
        }
        const from = Math.max(0, Math.floor(segment.startSec * ENERGY_BLOCKS_PER_SEC));
        const to = Math.min(mask.length, Math.ceil(segment.endSec * ENERGY_BLOCKS_PER_SEC));
        if (!(segment.startSec < segment.endSec && from < to)) {
            continue;
        }
        const bit = segment.channel === "mic" ? 1 : 2;
        for (let i = from; i < to; i++) {
            mask[i] = mask[i]! | bit;
        }
        if (segment.endSec - segment.startSec >= CALIBRATION_MIN_SEC) {
            spans.push({ from, to, channel: segment.channel, bit });
        }
    }
    // Earlier-ending votes leave the most audio available to subsequent tags, irrespective of input order.
    const usedThrough = { mic: 0, system: 0 };
    for (const { from, to, channel, bit } of spans.sort((a, b) => a.to - b.to || a.from - b.from)) {
        let left = 0,
            right = 0,
            blocks = 0;
        for (let i = Math.max(from, usedThrough[channel]); i < to; i++) {
            if (mask[i] === bit) {
                left += energy.left[i]!;
                right += energy.right[i]!;
                blocks++;
            }
        }
        if (blocks >= CALIBRATION_MIN_SEC * ENERGY_BLOCKS_PER_SEC && left + right >= QUIET * blocks) {
            shares[channel].push(left / (left + right));
            usedThrough[channel] = to;
        }
    }
    return shares;
}

/** Pick the loudest 15% independently on each channel, before observing either group's left share. */
function loudWindowShare(channel: Float32Array, energy: ChannelEnergy) {
    const sorted = channel.slice().sort();
    const loud = Math.max(QUIET, sorted[Math.floor(0.85 * sorted.length)] ?? QUIET);
    const shares = [];
    for (let i = 0; i < channel.length; i++) {
        if (channel[i]! >= loud) {
            shares.push(energy.left[i]! / (energy.left[i]! + energy.right[i]!));
        }
    }
    return {
        count: shares.length,
        share: shares.length >= CALIBRATION_MIN_SEC * ENERGY_BLOCKS_PER_SEC ? median(shares) : undefined,
    };
}

export interface ChannelCalibrationOptions {
    minSeparation?: number;
    sourceLayout?: Exclude<ChannelLayout, "unknown">;
    reportSourceShare?: boolean;
    /** Loud 100 ms windows each channel needs before the source layout counts as verified. Meetings keep the default; a live test passes fewer. */
    minSourceWindows?: number;
}

/** Tags establish the order in either direction. Without usable tags, separated audio can verify a source's order. */
export function calibrateChannels(
    energy: ChannelEnergy,
    segments: TaggedSpan[],
    {
        minSeparation = DEFAULT_CHANNEL_MIN_SEPARATION,
        sourceLayout,
        reportSourceShare,
        minSourceWindows,
    }: ChannelCalibrationOptions = {}
): ChannelCalibration {
    const shares = uncontestedShares(energy, segments);
    const counted = { mic: shares.mic.length, system: shares.system.length };
    const micMedian = median(shares.mic);
    const systemMedian = median(shares.system);
    const medians = {
        ...(micMedian === undefined ? {} : { micMedian: Math.round(micMedian * 1000) / 1000 }),
        ...(systemMedian === undefined ? {} : { systemMedian: Math.round(systemMedian * 1000) / 1000 }),
    };

    if (counted.mic < CALIBRATION_MIN_SEGMENTS || counted.system < CALIBRATION_MIN_SEGMENTS) {
        let sourceMicShare: number | undefined;
        if (sourceLayout) {
            const { share: left, count: leftCount } = loudWindowShare(energy.left, energy);
            const { share: right, count: rightCount } = loudWindowShare(energy.right, energy);
            const required = minSourceWindows ?? CALIBRATION_MIN_SEC * CALIBRATION_MIN_SEGMENTS * ENERGY_BLOCKS_PER_SEC;
            if (reportSourceShare) {
                sourceMicShare = sourceLayout === "left-mic" ? left : right === undefined ? undefined : 1 - right;
            }
            if (
                leftCount >= required &&
                rightCount >= required &&
                left !== undefined &&
                right !== undefined &&
                left > 0.5 &&
                right < 0.5 &&
                left - right >= minSeparation
            ) {
                return {
                    layout: sourceLayout,
                    ...(sourceMicShare !== undefined ? { sourceMicShare } : {}),
                    ...medians,
                    segments: counted,
                    reason: `source channel order verified by loud windows (median left shares ${left.toFixed(3)} and ${right.toFixed(3)})`,
                };
            }
        }
        return {
            layout: "unknown",
            ...(sourceMicShare !== undefined ? { sourceMicShare } : {}),
            ...medians,
            segments: counted,
            reason: `too few tagged segments (${counted.mic} mic, ${counted.system} call; ${CALIBRATION_MIN_SEGMENTS} of each needed)`,
        };
    }

    const difference = micMedian! - systemMedian!;
    if (difference !== 0 && Math.abs(difference) + Number.EPSILON >= minSeparation) {
        return { layout: difference > 0 ? "left-mic" : "right-mic", ...medians, segments: counted };
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

export interface VoiceRun {
    fromSec: number;
    toSec: number;
    /** Where the voice is: the user's microphone, the call, or both at once. */
    side: "mic" | "call" | "mixed";
}

const VOICE_WINDOW_SEC = 0.5;
const VOICE_MIN_RUN_SEC = 1;
const VOICE_SIDE_SHARE = 0.7;

/**
 * A span cut where the voice moves between the microphone and the call: half-second windows by their microphone
 * share, with a run shorter than a second folded into its neighbour. A quiet window keeps the side before it. Two
 * remote voices in a row are one run: the channels cannot tell them apart.
 */
export function voiceRuns(
    share: (fromSec: number, toSec: number) => number | undefined,
    fromSec: number,
    toSec: number
): VoiceRun[] {
    const windows: VoiceRun[] = [];
    const count = Math.ceil((toSec - fromSec) / VOICE_WINDOW_SEC);

    for (let index = 0; index < count; index += 1) {
        const start = fromSec + index * VOICE_WINDOW_SEC;
        const end = Math.min(toSec, start + VOICE_WINDOW_SEC);
        const mic = share(start, end);
        const last = windows.at(-1);
        const side: VoiceRun["side"] =
            mic === undefined
                ? (last?.side ?? "mixed")
                : mic >= VOICE_SIDE_SHARE
                  ? "mic"
                  : mic <= 1 - VOICE_SIDE_SHARE
                    ? "call"
                    : "mixed";

        if (last && last.side === side) {
            last.toSec = end;
        } else {
            windows.push({ fromSec: start, toSec: end, side });
        }
    }

    const runs: VoiceRun[] = [];

    for (const run of windows) {
        const last = runs.at(-1);

        if (last && (last.side === run.side || run.toSec - run.fromSec < VOICE_MIN_RUN_SEC)) {
            last.toSec = run.toSec;
            continue;
        }

        runs.push({ ...run });
    }

    const [first, second] = runs;

    if (first && second && first.toSec - first.fromSec < VOICE_MIN_RUN_SEC) {
        second.fromSec = first.fromSec;
        runs.shift();
    }

    return runs;
}

export interface SilentCallSpan {
    fromSec: number;
    toSec: number;
}

const SILENT_WINDOW_SEC = 60;
const SILENT_PROBE_SEC = 5;
/** A probe this sure of the microphone heard nothing on the call's channel. */
const SILENT_PROBE_SHARE = 0.99;
/** A window is silent on the call when this share of its voiced probes is, with at least `SILENT_MIN_PROBES` voiced. */
const SILENT_WINDOW_SHARE = 0.9;
const SILENT_MIN_PROBES = 3;
/** Shorter silent stretches happen when only the people in the room talk. */
const SILENT_MIN_SEC = 300;

/**
 * Stretches of 5 min or more where the call's channel stayed silent while the microphone heard speech: the call
 * played through the room's speakers (or another device), so the microphone carried the remote voices too and the
 * channel cannot tell the user apart (measured 2026-11-03: 27 min where the call channel stayed at its noise floor of
 * about 20 while the microphone peaked at 5,000). A window with almost no speech keeps the stretch going.
 */
export function silentCallSpans(
    share: (fromSec: number, toSec: number) => number | undefined,
    fromSec: number,
    toSec: number
): SilentCallSpan[] {
    const spans: SilentCallSpan[] = [];
    let open: SilentCallSpan | undefined;
    const close = () => {
        if (open && open.toSec - open.fromSec >= SILENT_MIN_SEC) {
            spans.push(open);
        }

        open = undefined;
    };

    for (let start = fromSec; start < toSec; start += SILENT_WINDOW_SEC) {
        const end = Math.min(toSec, start + SILENT_WINDOW_SEC);
        let voiced = 0;
        let silent = 0;

        for (let probe = start; probe < end; probe += SILENT_PROBE_SEC) {
            const mic = share(probe, Math.min(end, probe + SILENT_PROBE_SEC));

            if (mic === undefined) {
                continue;
            }

            voiced += 1;
            silent += mic >= SILENT_PROBE_SHARE ? 1 : 0;
        }

        if (voiced < SILENT_MIN_PROBES) {
            if (open) {
                open.toSec = end;
            }

            continue;
        }

        if (silent / voiced >= SILENT_WINDOW_SHARE) {
            open = open ? { ...open, toSec: end } : { fromSec: start, toSec: end };
            continue;
        }

        close();
    }

    close();

    return spans;
}
