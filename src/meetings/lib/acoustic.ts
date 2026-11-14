import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { SafeJSON } from "@genesiscz/utils/json";
import { correlateEcho, echoForRange, readEchoCache } from "@genesiscz/utils/meetings/echo";
import type { MeetingStore } from "@genesiscz/utils/meetings/record";
import {
    embedVoice,
    embedVoiceLines,
    readVoiceSamples,
    saveVoiceSample,
    scoreVoice,
    type VoiceMatch,
    VoiceUnavailableError,
    voiceEvidenceSchema,
} from "@genesiscz/utils/meetings/voice";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { OpenedMeeting } from "./opened-meeting";

export async function acousticMeeting(store: MeetingStore, ref: string) {
    const record = store.resolve(ref);
    if (!record) {
        throw new Error(`Unknown meeting ${ref}`);
    }
    const opened = OpenedMeeting.of(store, record);
    const audioPath = await opened.audioPath();
    const layout = (await opened.energy()).calibration?.layout ?? "unknown";
    return { record, opened, audioPath, layout, folder: join(store.folder(record.id), "evidence") };
}
export async function collectAcoustic(store: MeetingStore, meeting: string) {
    const c = await acousticMeeting(store, meeting);
    await c.opened.calibrate();
    const layout = (await c.opened.energy()).calibration?.layout ?? "unknown";
    const cache = await readEchoCache({ audioPath: c.audioPath, cachePath: join(c.folder, "echo.json"), layout });
    return { blocks: cache?.blocks.length ?? 0, layout };
}
export async function inspectAcoustic(options: {
    store: MeetingStore;
    meeting: string;
    fromSec: number;
    toSec: number;
}) {
    const context = await acousticMeeting(options.store, options.meeting);
    const { audioPath, folder, layout } = context;
    if (layout === "unknown") {
        return { quality: "unknown" as const, reason: "channel layout is unknown" };
    }
    const cache = await readEchoCache({ audioPath, cachePath: join(folder, "echo.json"), layout });
    const metric = cache ? echoForRange(cache, options.fromSec, options.toSec) : undefined;
    return {
        quality: metric?.quality ?? "unknown",
        reason: metric ? "Linear projection residual, speech quality unverified" : "Run acoustic collect explicitly",
        layout,
        metric,
    };
}
export async function voiceMeeting(options: {
    store: MeetingStore;
    meeting: string;
    fromSec: number;
    toSec: number;
    channel: 0 | 1;
    person?: string;
}) {
    const { folder, audioPath, record } = await acousticMeeting(options.store, options.meeting);
    const file = join(folder, "voices.json");
    let voice: Awaited<ReturnType<typeof embedVoice>>;
    try {
        voice = await embedVoice({ audioPath, ...options });
    } catch (error) {
        // Scoring a sample that cannot be scored is an unknown voice; enrolling one stays a refusal to act on.
        if (options.person || !(error instanceof VoiceUnavailableError)) {
            throw error;
        }

        const match: VoiceMatch = {
            model: readVoiceSamples(file)[0]?.model ?? "unavailable",
            quality: "unknown",
            candidates: [],
            reason: error.message,
        };
        return match;
    }

    if (options.person) {
        mkdirSync(folder, { recursive: true });
        saveVoiceSample(file, {
            ...voice,
            source: record.id,
            channel: options.channel,
            fromSec: options.fromSec,
            toSec: options.toSec,
            person: options.person,
            confirmed: true,
        });
    }
    return scoreVoice({ ...voice, samples: readVoiceSamples(file) });
}

/** Every `factor` samples averaged into one: a low-pass copy at a lower rate for the lag search. */
export function decimate(samples: Float32Array, factor: number): Float32Array {
    const out = new Float32Array(Math.floor(samples.length / factor));

    for (let i = 0; i < out.length; i++) {
        let sum = 0;

        for (let j = 0; j < factor; j++) {
            sum += samples[i * factor + j]!;
        }

        out[i] = sum / factor;
    }

    return out;
}

/** The recording as it was read: a change of size or time means its scores were measured on other audio. */
function recordingFingerprint(audioPath: string): string {
    const stat = statSync(audioPath);
    return SafeJSON.stringify([audioPath, stat.size, stat.mtimeMs]);
}

/** All three tracks are returned, even for a cleaned preview. Originals are never rewritten. */
export async function acousticClip(options: { store: MeetingStore; meeting: string; fromSec: number; toSec: number }) {
    const { audioPath, folder, layout } = await acousticMeeting(options.store, options.meeting);
    if (layout === "unknown") {
        throw new Error("Cannot isolate tracks: channel layout is unknown");
    }
    const channel = layout === "left-mic" ? 0 : 1;
    const [mic, call] = await Promise.all([
        toFloat32AudioWindow(audioPath, { ...options, channel }),
        toFloat32AudioWindow(audioPath, { ...options, channel: channel === 0 ? 1 : 0 }),
    ]);
    // The lag and gain come from a 2 kHz copy, as the cache collector measures them: the exhaustive search at 16 kHz
    // took about 476 million sample steps for a minute, on the service's one thread.
    const metric = correlateEcho({ mic: decimate(mic, 8), call: decimate(call, 8), rate: 2000 });
    const lag = Math.round(metric.lagMs * 16);
    const clean = Float32Array.from(mic, (sample, i) => sample - metric.gain * (call[i - lag] ?? 0));
    const dir = join(folder, "acoustic-clips");
    mkdirSync(dir, { recursive: true });
    const stat = statSync(audioPath);
    const key = `${options.fromSec}-${options.toSec}-${Bun.hash(SafeJSON.stringify([audioPath, stat.size, stat.mtimeMs, layout, "linear-v1"])).toString(36)}`;
    const tracks = {
        rawMic: join(dir, `${key}-raw-mic.wav`),
        isolatedCall: join(dir, `${key}-call.wav`),
        cleanMic: join(dir, `${key}-clean-estimate.wav`),
    };
    const wav = (samples: Float32Array) => {
        const bytes = Buffer.alloc(44 + samples.length * 2);
        bytes.write("RIFF");
        bytes.writeUInt32LE(bytes.length - 8, 4);
        bytes.write("WAVEfmt ", 8);
        bytes.writeUInt32LE(16, 16);
        bytes.writeUInt16LE(1, 20);
        bytes.writeUInt16LE(1, 22);
        bytes.writeUInt32LE(16000, 24);
        bytes.writeUInt32LE(32000, 28);
        bytes.writeUInt16LE(2, 32);
        bytes.writeUInt16LE(16, 34);
        bytes.write("data", 36);
        bytes.writeUInt32LE(samples.length * 2, 40);
        for (let i = 0; i < samples.length; i++) {
            bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
        }
        return bytes;
    };
    atomicWriteFileSync(tracks.rawMic, wav(mic));
    atomicWriteFileSync(tracks.isolatedCall, wav(call));
    atomicWriteFileSync(tracks.cleanMic, wav(clean));
    return { tracks, metric, quality: "linear-estimate" as const };
}

/** Explicit collection after confirmed enrolment. The two channel results never share an identity by label. */
export async function collectVoiceEvidence(store: MeetingStore, meeting: string) {
    const { folder, audioPath, opened, layout } = await acousticMeeting(store, meeting);
    if (layout === "unknown") {
        throw new Error("Voice evidence needs calibrated channels");
    }
    const enrolmentFile = join(folder, "voices.json");
    // The inputs as the scores use them: published only when neither changed during the long embedding loop.
    const enrolment = Bun.hash(readFileSync(enrolmentFile)).toString();
    const source = recordingFingerprint(audioPath);
    const samples = readVoiceSamples(enrolmentFile);
    if (!samples.length) {
        throw new Error("Enrol confirmed voices before collecting identity evidence");
    }
    const evidence = await opened.evidence();
    const transcript = await opened.meeting();
    const lines: Record<string, VoiceMatch> = {};
    const energy = await opened.energy();
    for (const line of lineEvidence(
        transcript.transcript,
        evidence ?? { segments: [], speaking: [] },
        undefined,
        energy.share
    )) {
        const duration = line.endSec - line.startSec;
        if (duration < 1.5 || duration > 60) {
            continue;
        }
        const share = energy.share?.(line.startSec, line.endSec);
        // Mixed and unavailable channels stay unknown; no fabricated person from a platform label.
        if (share === undefined || (share > 0.35 && share < 0.8)) {
            continue;
        }
        const channel = share <= 0.35 ? (layout === "left-mic" ? 1 : 0) : layout === "left-mic" ? 0 : 1;
        const [embedded] = await embedVoiceLines({
            audioPath,
            spans: [{ index: line.index, fromSec: line.startSec, toSec: line.endSec }],
            channels: [{ channel, track: share <= 0.35 ? "isolated-call" : "raw-mic" }],
        });
        const voice = embedded?.channels[0];
        lines[`${line.startSec}:${line.endSec}`] =
            voice?.quality === "ready"
                ? scoreVoice({ model: voice.model, embedding: voice.embedding, samples })
                : {
                      model: samples[0]!.model,
                      quality: "unknown",
                      candidates: [],
                      reason: voice?.quality === "unknown" ? voice.reason : "no embedding",
                  };
    }
    if (Bun.hash(readFileSync(enrolmentFile)).toString() !== enrolment || recordingFingerprint(audioPath) !== source) {
        throw new Error(
            "The enrolled voices or the recording changed while voice evidence was collected; collect again."
        );
    }

    const result = voiceEvidenceSchema.parse({ version: 1, source, enrolment, lines });
    atomicWriteFileSync(join(folder, "voice-scores.json"), SafeJSON.stringify(result));
    return {
        lines: Object.keys(lines).length,
        matched: Object.values(lines).filter((v) => v.quality === "matched").length,
    };
}
