import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import type { ChannelLayout } from "./energy";
import type { VoiceMatch } from "./voice";

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
        for (let i = limit; i < Math.min(mic.length, call.length); i += stride) {
            const m = mic[i]!,
                c = call[i - lag]!;
            mm += m * m;
            cc += c * c;
            mc += m * c;
            count++;
        }
        return { correlation: mm > 0 && cc > 0 ? mc / Math.sqrt(mm * cc) : 0, mm, cc, mc, count };
    };
    let bestLag = 0,
        best = evaluate(0, 4);
    for (let lag = 0; lag <= limit; lag += 4) {
        const v = evaluate(lag, 4);
        if (Math.abs(v.correlation) > Math.abs(best.correlation)) {
            best = v;
            bestLag = lag;
        }
    }
    const coarse = bestLag;
    best = evaluate(bestLag, 1);
    for (let lag = Math.max(0, coarse - 3); lag <= Math.min(limit, coarse + 3); lag++) {
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
    version: z.literal(1),
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
    const parsed = cacheSchema.safeParse(await Bun.file(options.cachePath).json());
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
}): Promise<EchoCache | undefined> {
    if (options.layout === "unknown") {
        return undefined;
    }
    const cached = await readEchoCache(options);
    if (cached) {
        return cached;
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
                "-ac",
                "2",
                "-ar",
                "2000",
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
        const result: EchoCache = { version: 1, source: sourceKey(options.audioPath), layout: options.layout, blocks };
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
