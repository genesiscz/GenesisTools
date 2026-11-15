import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { Curve, gain, hash, RATE, type Stereo, stereo } from "./dsp";
import { applyEffects } from "./effects";
import { fluidSynthArgs } from "./fluidsynth";
import { encodeMidi, MIDI_PARTS } from "./midi";
import { SYNTH_PRESETS } from "./presets";
import { runAudio } from "./process";
import { room } from "./space";
import { renderSynth } from "./synth";
import type { Patch, Score, ScorePart } from "./types";

interface StemContext {
    score: Score;
    folder: string;
    soundfont: string;
    samples: number;
}

/** A score that only names SoundFont programs renders in one FluidSynth pass. Anything else is mixed from stems. */
export function needsStems(score: Score): boolean {
    return (
        score.room !== undefined ||
        score.parts.length > MIDI_PARTS ||
        score.parts.some(
            (part) => part.source.kind !== "soundfont" || part.effects !== undefined || (part.lanes?.length ?? 0) > 0
        )
    );
}

export function resolvePatch(patch: string | Patch): Patch {
    if (typeof patch !== "string") {
        return patch;
    }

    const preset = SYNTH_PRESETS[patch];

    if (!preset) {
        throw new Error(`Unknown synth preset ${patch}; choose ${Object.keys(SYNTH_PRESETS).join(", ")}`);
    }

    return preset;
}

/** Float WAV, the format FluidSynth writes, so one loudness pass reads either render. */
export async function writeFloatWav(file: string, buffer: Stereo): Promise<void> {
    const samples = buffer.left.length;
    const bytes = Buffer.alloc(44 + samples * 8);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(36 + samples * 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(3, 20);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE(RATE, 24);
    bytes.writeUInt32LE(RATE * 8, 28);
    bytes.writeUInt16LE(8, 32);
    bytes.writeUInt16LE(32, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(samples * 8, 40);
    const data = new Float32Array(bytes.buffer, bytes.byteOffset + 44, samples * 2);

    for (let n = 0; n < samples; n++) {
        data[n * 2] = buffer.left[n];
        data[n * 2 + 1] = buffer.right[n];
    }

    await writeFile(file, bytes);
}

/** Any audio file as 48 kHz stereo floats, cut or padded to `samples`. */
export async function readFloat(file: string, samples: number): Promise<Stereo> {
    const raw = `${file}.f32`;
    await runAudio([
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-f",
        "f32le",
        "-ac",
        "2",
        "-ar",
        `${RATE}`,
        raw,
    ]);
    const bytes = await readFile(raw);
    const data = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4))
    );
    const out = stereo(samples);
    const frames = Math.min(samples, Math.floor(data.length / 2));

    for (let n = 0; n < frames; n++) {
        out.left[n] = data[n * 2];
        out.right[n] = data[n * 2 + 1];
    }

    return out;
}

/** FluidSynth applies the part's volume and pan itself, from the MIDI controllers. */
async function soundfontStem(part: ScorePart, index: number, context: StemContext): Promise<Stereo> {
    const { score } = context;
    const midi = join(context.folder, `stem-${index}.mid`);
    const raw = join(context.folder, `stem-${index}.wav`);
    await writeFile(
        midi,
        encodeMidi({
            key: score.key,
            title: score.title,
            bpm: score.bpm,
            seconds: score.seconds,
            end: score.end,
            parts: [{ name: part.name, source: part.source, volume: part.volume, pan: part.pan, notes: part.notes }],
        })
    );
    await runAudio(["fluidsynth", ...fluidSynthArgs({ soundfont: context.soundfont, midi, raw })]);
    return readFloat(raw, context.samples);
}

function synthStem(part: ScorePart, patch: string | Patch, context: StemContext): Stereo {
    const buffer = renderSynth({
        patch: resolvePatch(patch),
        notes: part.notes,
        lanes: part.lanes,
        samples: context.samples,
        seed: hash(part.name),
    });
    const pan = part.pan / 127;
    const volume = (part.volume / 127) ** 2;
    const left = volume * Math.min(1, 2 * (1 - pan));
    const right = volume * Math.min(1, 2 * pan);

    for (let n = 0; n < context.samples; n++) {
        buffer.left[n] *= left;
        buffer.right[n] *= right;
    }

    return buffer;
}

async function renderStem(part: ScorePart, index: number, context: StemContext): Promise<Stereo> {
    const source = part.source;

    switch (source.kind) {
        case "soundfont":
            return soundfontStem(part, index, context);
        case "synth":
            return synthStem(part, source.patch, context);
        default: {
            const unknown: never = source;
            throw new Error(`Unknown source ${String(unknown)}`);
        }
    }
}

/** Every part as its own stem through its effect chain, summed with the shared room. */
export async function mixScore(options: { score: Score; folder: string; soundfont: string }): Promise<Stereo> {
    const { score } = options;
    const samples = Math.round(score.seconds * RATE);
    const context: StemContext = { ...options, samples };
    const mix = stereo(samples);
    const send = stereo(samples);
    const starts = new Map(score.parts.map((part) => [part.name, part.notes.map((note) => note.at)]));

    for (const [index, part] of score.parts.entries()) {
        const lanes = new Map((part.lanes ?? []).map((lane) => [lane.target, new Curve(lane.points, lane.hold)]));
        const buffer = await renderStem(part, index, context);
        const level = lanes.get("level");

        if (level) {
            let factor = 1;

            for (let n = 0; n < samples; n++) {
                if (n % 32 === 0) {
                    factor = gain(level.at(n / RATE));
                }

                buffer.left[n] *= factor;
                buffer.right[n] *= factor;
            }
        }

        applyEffects({ buffer, effects: part.effects ?? {}, lanes, triggers: (name) => starts.get(name) ?? [] });
        const reverb = part.effects?.reverb ?? 0;
        let peak = 0;

        for (let n = 0; n < samples; n++) {
            mix.left[n] += buffer.left[n];
            mix.right[n] += buffer.right[n];
            send.left[n] += buffer.left[n] * reverb;
            send.right[n] += buffer.right[n] * reverb;
            peak = Math.max(peak, Math.abs(buffer.left[n]), Math.abs(buffer.right[n]));
        }

        logger.debug(
            {
                part: part.name,
                source: part.source.kind,
                notes: part.notes.length,
                peakDb: 20 * Math.log10(peak || 1e-9),
            },
            "music stem rendered"
        );
    }

    if (score.room) {
        const wet = room(send, score.room);

        for (let n = 0; n < samples; n++) {
            mix.left[n] += wet.left[n];
            mix.right[n] += wet.right[n];
        }
    }

    return mix;
}
