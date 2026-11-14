import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { CONTAINER_CLOCK_FILTER } from "../audio/converter";
import type { ChannelLayout } from "./energy";
import type { VoiceMatch } from "./voice";

const { log } = logger.scoped("meetings-echo");

/** The longest recording echo collection reads: eight hours, one block per second. */
const ECHO_MAX_SEC = 8 * 60 * 60;

export const echoMetricSchema = z.object({
    correlation: z.number().min(-1).max(1),
    echoOfCall: z.number().min(0).max(1),
    lagMs: z.number(),
    gain: z.number(),
    rawMicRms: z.number().nonnegative(),
    callRms: z.number().nonnegative(),
    cleanMicRms: z.number().nonnegative(),
    rawMicShare: z.number().min(0).max(1).optional(),
    cleanMicShare: z.number().min(0).max(1).optional(),
    quality: z.enum(["linear-estimate", "quiet", "insufficient"]),
});
export type EchoMetric = z.infer<typeof echoMetricSchema>;
export interface AcousticShare {
    (fromSec: number, toSec: number): number | undefined;
    raw?: (fromSec: number, toSec: number) => number | undefined;
    acoustic?: (fromSec: number, toSec: number) => EchoMetric | undefined;
    voice?: (fromSec: number, toSec: number) => VoiceMatch | undefined;
}
/** How many samples one lag of the coarse echo search averages. */
const COARSE_STEP = 4;

/** The signal averaged over runs of `step` samples: a box low-pass, then every `step`th value. */
function boxAverage(signal: Float32Array, step: number): Float32Array {
    const out = new Float32Array(Math.floor(signal.length / step));
    for (let i = 0; i < out.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
            sum += signal[i * step + j]!;
        }
        out[i] = sum / step;
    }
    return out;
}

/** The correlation coefficient of `a` against `b` delayed by `lag`, over the samples `margin` away from both ends. */
function normalizedCorrelation(options: { a: Float32Array; b: Float32Array; lag: number; margin: number }): number {
    const { a, b, lag, margin } = options;
    let aa = 0,
        bb = 0,
        ab = 0;
    for (let i = margin; i < Math.min(a.length, b.length) - margin; i++) {
        const x = a[i]!,
            y = b[i - lag]!;
        aa += x * x;
        bb += y * y;
        ab += x * y;
    }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Positive lag means playback precedes microphone arrival. This linear residual is an estimate, not separated speech. */
export function correlateEcho(options: {
    mic: Float32Array;
    call: Float32Array;
    rate: number;
    maxLagMs?: number;
}): EchoMetric {
    const { mic, call, rate } = options;
    const limit = Math.min(Math.floor((rate * (options.maxLagMs ?? 250)) / 1000), Math.floor(mic.length / 4));
    const evaluate = (lag: number, stride: number) => {
        let mm = 0,
            cc = 0,
            mc = 0,
            count = 0;
        for (let i = limit; i < Math.min(mic.length, call.length) - limit; i += stride) {
            const m = mic[i]!,
                c = call[i - lag]!;
            mm += m * m;
            cc += c * c;
            mc += m * c;
            count++;
        }
        return { correlation: mm > 0 && cc > 0 ? mc / Math.sqrt(mm * cc) : 0, mm, cc, mc, count };
    };
    // The coarse pass tries every lag of a copy averaged over COARSE_STEP samples. The average low-passes both
    // signals, so a delay between two coarse lags still peaks at the nearer one, and the fine pass around it finds
    // the exact sample. Trying every fourth lag of the raw signals missed a broadband delay off that grid.
    const micLow = boxAverage(mic, COARSE_STEP),
        callLow = boxAverage(call, COARSE_STEP),
        coarseLimit = Math.floor(limit / COARSE_STEP);
    let coarse = 0,
        coarseBest = 0;
    for (let lag = -coarseLimit; lag <= coarseLimit; lag++) {
        const value = Math.abs(normalizedCorrelation({ a: micLow, b: callLow, lag, margin: coarseLimit }));
        if (value > coarseBest) {
            coarseBest = value;
            coarse = lag * COARSE_STEP;
        }
    }
    let bestLag = coarse,
        best = evaluate(coarse, 1);
    for (let lag = Math.max(-limit, coarse - COARSE_STEP); lag <= Math.min(limit, coarse + COARSE_STEP); lag++) {
        const v = evaluate(lag, 1);
        if (Math.abs(v.correlation) > Math.abs(best.correlation)) {
            best = v;
            bestLag = lag;
        }
    }
    const rawMicRms = Math.sqrt(best.mm / Math.max(1, best.count));
    const callRms = Math.sqrt(best.cc / Math.max(1, best.count));
    const correlation = Math.max(-1, Math.min(1, best.correlation));
    const cleanMicRms = rawMicRms * Math.sqrt(Math.max(0, 1 - correlation * correlation));
    const quality = best.count < rate / 4 ? "insufficient" : rawMicRms + callRms < 0.002 ? "quiet" : "linear-estimate";
    return {
        correlation,
        echoOfCall: correlation ** 2,
        lagMs: (bestLag * 1000) / rate,
        gain: best.cc > 0 ? best.mc / best.cc : 0,
        rawMicRms,
        callRms,
        cleanMicRms,
        quality,
        ...(quality === "linear-estimate"
            ? { rawMicShare: rawMicRms / (rawMicRms + callRms), cleanMicShare: cleanMicRms / (cleanMicRms + callRms) }
            : {}),
    };
}
const cacheSchema = z.object({
    version: z.literal(2),
    source: z.string(),
    layout: z.enum(["left-mic", "right-mic"]),
    blocks: z.array(echoMetricSchema),
});
export type EchoCache = z.infer<typeof cacheSchema>;
function sourceKey(audioPath: string): string {
    const stat = statSync(audioPath);
    return SafeJSON.stringify([audioPath, stat.size, stat.mtimeMs]);
}
export async function readEchoCache(options: {
    audioPath: string;
    cachePath: string;
    layout: ChannelLayout;
}): Promise<EchoCache | undefined> {
    if (!existsSync(options.cachePath)) {
        return undefined;
    }
    let stored: unknown;
    try {
        stored = await Bun.file(options.cachePath).json();
    } catch (error) {
        // A torn or hand-damaged cache is a miss: readers fall back to raw energy and collection writes it again.
        log.debug({ error, cachePath: options.cachePath }, "echo cache does not read; treated as missing");
        return undefined;
    }
    const parsed = cacheSchema.safeParse(stored);
    return parsed.success &&
        parsed.data.source === sourceKey(options.audioPath) &&
        parsed.data.layout === options.layout
        ? parsed.data
        : undefined;
}
/** Explicit collection only. Temporary PCM is read in bounded one-second windows. */
export async function collectEcho(options: {
    audioPath: string;
    cachePath: string;
    layout: ChannelLayout;
    /** The longest recording read, in seconds; eight hours unless a caller narrows it. */
    maxSec?: number;
}): Promise<EchoCache | undefined> {
    const maxSec = options.maxSec ?? ECHO_MAX_SEC;
    const bound = `Echo collection exceeds the audio bound of ${maxSec} seconds (eight hours unless narrowed)`;
    if (options.layout === "unknown") {
        return undefined;
    }
    const cached = await readEchoCache(options);
    if (cached) {
        return cached;
    }
    const source = sourceKey(options.audioPath);
    const probe = Bun.spawn(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=channels:format=duration",
            "-of",
            "json",
            options.audioPath,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000 }
    );
    const [metadata, probeError, probeCode] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
    ]);
    if (probeCode !== 0) {
        throw new Error(`Echo channel probe failed (${probeCode}): ${probeError.slice(-500)}`);
    }
    const parsedProbe = z
        .object({
            streams: z.array(z.object({ channels: z.number() })),
            format: z.object({ duration: z.union([z.string(), z.number()]).optional() }).optional(),
        })
        .parse(SafeJSON.parse(metadata));
    if (parsedProbe.streams[0]?.channels !== 2) {
        return undefined;
    }
    // The bound is checked before anything is decoded, so an oversized recording never fills the temporary folder.
    if (Number(parsedProbe.format?.duration ?? 0) > maxSec) {
        throw new Error(bound);
    }
    mkdirSync(dirname(options.cachePath), { recursive: true });
    const pcm = join(dirname(options.cachePath), `echo-${randomUUID()}.s16`);
    try {
        const proc = Bun.spawn(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                options.audioPath,
                "-map",
                "0:a:0",
                // The same clock as the energy and the transcript: a delayed start or a gap is padded, not closed.
                "-af",
                CONTAINER_CLOCK_FILTER,
                "-ac",
                "2",
                "-ar",
                "2000",
                // A duration the probe could not read is still bounded: one second past the bound is decoded at
                // most, and the block count below refuses it.
                "-t",
                String(maxSec + 1),
                "-f",
                "s16le",
                pcm,
            ],
            { stdout: "ignore", stderr: "pipe", timeout: 300_000 }
        );
        const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
        if (code !== 0) {
            throw new Error(`Echo decode failed (${code}): ${error.slice(-500)}`);
        }
        const fd = openSync(pcm, "r"),
            blocks: EchoMetric[] = [];
        try {
            const window = Buffer.alloc(8000);
            for (;;) {
                const read = readSync(fd, window, 0, window.length, null);
                if (read === 0) {
                    break;
                }
                if (blocks.length >= maxSec) {
                    throw new Error(bound);
                }
                const n = Math.floor(read / 4),
                    mic = new Float32Array(n),
                    call = new Float32Array(n);
                const channel = options.layout === "left-mic" ? 0 : 1;
                for (let i = 0; i < n; i++) {
                    mic[i] = window.readInt16LE(i * 4 + channel * 2) / 32768;
                    call[i] = window.readInt16LE(i * 4 + (1 - channel) * 2) / 32768;
                }
                blocks.push(correlateEcho({ mic, call, rate: 2000 }));
            }
        } finally {
            closeSync(fd);
        }
        if (source !== sourceKey(options.audioPath)) {
            throw new Error("Audio changed during echo collection; evidence was not published");
        }
        const result: EchoCache = { version: 2, source, layout: options.layout, blocks };
        atomicWriteFileSync(options.cachePath, SafeJSON.stringify(result));
        return result;
    } finally {
        if (existsSync(pcm)) {
            unlinkSync(pcm);
        }
    }
}
export function echoForRange(cache: EchoCache, fromSec: number, toSec: number): EchoMetric | undefined {
    const blocks = cache.blocks
        .slice(Math.max(0, Math.floor(fromSec)), Math.ceil(toSec))
        .filter((b) => b.quality === "linear-estimate");
    if (!blocks.length) {
        return undefined;
    }
    let raw = 0,
        clean = 0,
        call = 0,
        lag = 0,
        gain = 0,
        weight = 0;
    for (const b of blocks) {
        raw += b.rawMicRms ** 2;
        clean += b.cleanMicRms ** 2;
        call += b.callRms ** 2;
        const w = b.rawMicRms ** 2 * b.echoOfCall;
        lag += b.lagMs * w;
        gain += b.gain * w;
        weight += w;
    }
    const rawMicRms = Math.sqrt(raw / blocks.length),
        cleanMicRms = Math.sqrt(clean / blocks.length),
        callRms = Math.sqrt(call / blocks.length);
    const echoOfCall = raw > 0 ? Math.max(0, Math.min(1, 1 - clean / raw)) : 0;
    return {
        correlation: Math.sqrt(echoOfCall),
        echoOfCall,
        lagMs: weight ? lag / weight : 0,
        gain: weight ? gain / weight : 0,
        rawMicRms,
        cleanMicRms,
        callRms,
        rawMicShare: rawMicRms / (rawMicRms + callRms),
        cleanMicShare: cleanMicRms / (cleanMicRms + callRms),
        quality: "linear-estimate",
    };
}
