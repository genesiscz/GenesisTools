import { z } from "zod";
import { CONTAINER_CLOCK_FILTER } from "../audio/converter";
import { logger } from "../logger";

export const channelVoiceSchema = z.object({
    rms: z.number(),
    lowBandShare: z.number(),
    tilt: z.number(),
    pitchHz: z.number().nullable(),
    voicedShare: z.number(),
});
export const lineVoiceSchema = z.object({
    index: z.number().int(),
    channels: z.array(channelVoiceSchema),
    cluster: z.object({ id: z.number().int(), confidence: z.number(), speaker: z.string().optional() }).optional(),
});
export type ChannelVoice = z.infer<typeof channelVoiceSchema>;
export type LineVoice = z.infer<typeof lineVoiceSchema>;
export interface VoiceSpan {
    index: number;
    fromSec: number;
    toSec: number;
    speaker?: string;
}
export interface VoiceFrame {
    channels: ChannelVoice[];
}
const RATE = 8000;
const SAMPLES = 400;
const FRAME_SEC = SAMPLES / RATE;
const MAX_FRAMES = (8 * 3600) / FRAME_SEC;
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** Pitch by normalized autocorrelation, 60 to 400 Hz. Silence/unvoiced frames return null. */
export function measureVoice(samples: Float32Array): ChannelVoice {
    let total = 0,
        low = 0,
        diff = 0,
        y1 = 0,
        y2 = 0,
        previous = 0,
        mean = 0;
    const a = Math.exp((-2 * Math.PI * 300) / RATE);
    for (const x of samples) {
        mean += x;
        y1 = (1 - a) * x + a * y1;
        y2 = (1 - a) * y1 + a * y2;
        total += x * x;
        low += y2 * y2;
        diff += (x - previous) ** 2;
        previous = x;
    }
    mean /= samples.length || 1;
    const rms = Math.sqrt(total / (samples.length || 1));
    let best = 0,
        lagBest = 0;
    if (rms > 0.002) {
        for (let lag = 20; lag <= 133; lag++) {
            let cross = 0,
                left = 0,
                right = 0;
            for (let i = lag; i < samples.length; i += 2) {
                const x = samples[i]! - mean,
                    y = samples[i - lag]! - mean;
                cross += x * y;
                left += x * x;
                right += y * y;
            }
            const score = cross / Math.sqrt(left * right || 1);
            // Prefer the first period over its equal-scoring multiples.
            if (score > best + 0.015) {
                best = score;
                lagBest = lag;
            }
        }
    }
    const voiced = best >= 0.65 && lagBest > 0;
    return {
        rms,
        lowBandShare: total ? low / total : 0,
        tilt: total ? diff / total : 0,
        pitchHz: voiced ? RATE / lagBest : null,
        voicedShare: voiced ? 1 : 0,
    };
}

/** One stereo streaming decode, bounded to eight hours of 50 ms features, never stores PCM or a durable cache. */
export async function voiceFrames(options: { audioPath: string; signal?: AbortSignal }): Promise<VoiceFrame[]> {
    if (!Bun.which("ffmpeg")) {
        throw new Error("ffmpeg is required for voice features.");
    }
    const argv = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        options.audioPath,
        "-map",
        "0:a:0",
        "-af",
        CONTAINER_CLOCK_FILTER,
        "-ar",
        String(RATE),
        "-ac",
        "2",
        "-f",
        "f32le",
        "pipe:1",
    ];
    logger.debug({ argv }, "decoding voice features");
    const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 180_000,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const stderr = (async () => {
        let message = "";
        for await (const chunk of proc.stderr) {
            if (message.length < 4096) {
                message += new TextDecoder().decode(chunk).slice(0, 4096 - message.length);
            }
        }
        return message;
    })();
    const frames: VoiceFrame[] = [];
    const frameBytes = SAMPLES * 2 * 4;
    let pending = new Uint8Array(frameBytes),
        filled = 0;
    try {
        for await (const chunk of proc.stdout) {
            let offset = 0;
            while (offset < chunk.length) {
                const take = Math.min(frameBytes - filled, chunk.length - offset);
                pending.set(chunk.subarray(offset, offset + take), filled);
                filled += take;
                offset += take;
                if (filled === frameBytes) {
                    if (frames.length >= MAX_FRAMES) {
                        throw new Error("Voice feature limit is eight hours; split the recording explicitly.");
                    }
                    const pcm = new DataView(pending.buffer);
                    const channels = [new Float32Array(SAMPLES), new Float32Array(SAMPLES)];
                    for (let i = 0; i < SAMPLES; i++) {
                        channels[0]![i] = pcm.getFloat32(i * 8, true);
                        channels[1]![i] = pcm.getFloat32(i * 8 + 4, true);
                    }
                    frames.push({ channels: channels.map(measureVoice) });
                    filled = 0;
                }
            }
        }
        const code = await proc.exited;
        const error = await stderr;
        if (code !== 0) {
            throw new Error(`Voice decode failed (${code}): ${error}`);
        }
        return frames;
    } finally {
        if (proc.exitCode === null) {
            proc.kill();
        }
        await proc.exited;
        await stderr;
    }
}

export function lineVoices(options: { frames: readonly VoiceFrame[]; spans: readonly VoiceSpan[] }): LineVoice[] {
    return options.spans.map((span) => {
        const frames = options.frames.slice(
            Math.max(0, Math.floor(span.fromSec / FRAME_SEC)),
            Math.ceil(span.toSec / FRAME_SEC)
        );
        const channels = [0, 1].map((channel): ChannelVoice => {
            const values = frames.map((frame) => frame.channels[channel]!).filter(Boolean);
            const energy = values.reduce((sum, value) => sum + value.rms ** 2, 0);
            const pitches = values.filter((value) => value.pitchHz !== null).map((value) => value.pitchHz!);
            return {
                rms: Math.sqrt(energy / (values.length || 1)),
                lowBandShare: energy
                    ? values.reduce((sum, value) => sum + value.lowBandShare * value.rms ** 2, 0) / energy
                    : 0,
                tilt: energy ? values.reduce((sum, value) => sum + value.tilt * value.rms ** 2, 0) / energy : 0,
                pitchHz: pitches.length ? median(pitches) : null,
                voicedShare: pitches.length / (values.length || 1),
            };
        });
        return { index: span.index, channels };
    });
}

/** Deterministic standardized k-means. Confirmed line anchors fix identity; a cluster without anchors has no name. */
export function clusterVoices(options: {
    lines: readonly LineVoice[];
    channel: number;
    voices: number;
    anchors?: ReadonlyMap<number, string>;
}): LineVoice[] {
    if (
        !Number.isInteger(options.voices) ||
        options.voices < 1 ||
        options.voices > 16 ||
        ![0, 1].includes(options.channel)
    ) {
        throw new Error("voices must be 1..16 and channel 0 or 1.");
    }
    const usable = options.lines.filter((line) => (line.channels[options.channel]?.rms ?? 0) > 0.002);
    if (!usable.length) {
        return options.lines.map(({ cluster: _previous, ...line }) => line);
    }
    const vector = (line: LineVoice) => {
        const v = line.channels[options.channel]!;
        return [Math.log(v.rms + 1e-8), v.lowBandShare, v.tilt, Math.log(v.pitchHz ?? 150)];
    };
    const vectors = usable.map(vector);
    const means = vectors[0]!.map((_, d) => vectors.reduce((sum, v) => sum + v[d]!, 0) / vectors.length);
    const scales = means.map(
        (mean, d) => Math.sqrt(vectors.reduce((sum, v) => sum + (v[d]! - mean) ** 2, 0) / vectors.length) || 1
    );
    // Level varies with distance to the device. Pitch carries more identity information than gain.
    const weights = [0.1, 0.5, 0.5, 2];
    const points = vectors.map((v) => v.map((x, d) => ((x - means[d]!) / scales[d]!) * weights[d]!));
    const distance = (a: number[], b: number[]) => a.reduce((sum, x, d) => sum + (x - b[d]!) ** 2, 0);
    const names = [...new Set(usable.flatMap((line) => options.anchors?.get(line.index) ?? []))].sort();
    if (names.length > options.voices) {
        throw new Error("More anchor speakers than requested voices.");
    }
    const k = Math.min(options.voices, points.length);
    const centers = names.map((name) => {
        const group = points.filter((_, i) => options.anchors?.get(usable[i]!.index) === name);
        return means.map((_, d) => median(group.map((v) => v[d]!)));
    });
    if (!centers.length) {
        centers.push([...points[0]!]);
    }
    while (centers.length < k) {
        centers.push([
            ...points.reduce((best, v) =>
                Math.min(...centers.map((c) => distance(v, c))) > Math.min(...centers.map((c) => distance(best, c)))
                    ? v
                    : best
            ),
        ]);
    }
    let assignments: number[] = [];
    for (let iteration = 0; iteration < 30; iteration++) {
        assignments = points.map((v, i) => {
            const anchor = options.anchors?.get(usable[i]!.index);
            return anchor
                ? names.indexOf(anchor)
                : centers
                      .map((c) => distance(v, c))
                      .reduce((best, value, j, all) => (value < all[best]! ? j : best), 0);
        });
        for (let c = names.length; c < k; c++) {
            const group = points.filter((_, i) => assignments[i] === c);
            if (group.length) {
                centers[c] = means.map((_, d) => group.reduce((sum, v) => sum + v[d]!, 0) / group.length);
            }
        }
    }
    const clusters = new Map(
        usable.map((line, i) => {
            const id = assignments[i]!;
            const own = distance(points[i]!, centers[id]!);
            const other = Math.min(...centers.filter((_, j) => j !== id).map((c) => distance(points[i]!, c)));
            const confidence = k === 1 ? 1 : Math.max(0, Math.min(1, (other - own) / (other + 1e-8)));
            return [line.index, { id, confidence, ...(names[id] ? { speaker: names[id] } : {}) }] as const;
        })
    );
    return options.lines.map(({ cluster: _previous, ...line }) => ({
        ...line,
        ...(clusters.has(line.index) ? { cluster: clusters.get(line.index)! } : {}),
    }));
}
