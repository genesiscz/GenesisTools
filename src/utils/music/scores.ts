import { MusicTracks, SCORE_END, SCORE_SECONDS, ShelvedTracks } from "./kalendora-score";
import { type Score, type ScorePart, scoreSchema } from "./types";

const tracks = { ...MusicTracks, ...ShelvedTracks };
export const TRACK_KEYS = Object.keys(tracks);
const programs: Record<keyof typeof tracks, readonly number[]> = {
    Pulse: [89, 33, 12, 119, 0, 0, 0],
    PulseLight: [89, 33, 12, 119],
    Calm: [89, 0, 32, 11],
    Piano: [0, 0, 0, 0],
};

const volumes: Partial<Record<keyof typeof tracks, readonly number[]>> = {
    Calm: [85, 65, 60, 35],
};

function trackKey(value: string): keyof typeof tracks {
    const entry = Object.keys(tracks).find((key) => key.toLowerCase() === value.toLowerCase());

    if (entry === undefined || !(entry in tracks)) {
        throw new Error(`Unknown track ${value}; choose ${TRACK_KEYS.join(", ")}`);
    }

    return entry as keyof typeof tracks;
}

/** Original note patterns, voiced by sampled GM instruments instead of lavfi partials. */
export function builtinScore(value: string): Score {
    const key = trackKey(value);
    const original = tracks[key];
    const parts: ScorePart[] = original.instruments().map((instrument, index) => {
        const percussion = (key === "Pulse" && index >= 4) || (key === "Piano" && index === 3);
        const drum = key === "Piano" ? 70 : [36, 42, 39][index - 4];
        const part: ScorePart = {
            name: `${key}-${index + 1}`,
            program: programs[key][index],
            percussion,
            volume: volumes[key]?.[index] ?? Math.max(1, Math.min(127, Math.round(instrument.gain * 350))),
            pan: Math.round((127 * instrument.pan[1]) / (instrument.pan[0] + instrument.pan[1])),
            notes: [],
        };

        for (const line of instrument.lines) {
            line.steps.forEach((hit, step) => {
                const at = step * line.step;

                if (!hit || at >= SCORE_SECONDS) {
                    return;
                }

                const duration = Math.min(
                    SCORE_SECONDS - at,
                    Math.max(0.04, Math.min(line.ring * line.step, line.sound.hold + 2 / line.sound.decay))
                );
                part.notes.push({
                    at,
                    duration,
                    midi: percussion ? drum : hit.midi,
                    velocity: Math.max(1, Math.min(127, Math.round(hit.vel * 100))),
                });
            });
        }

        if (instrument.kind === "noise" && instrument.lines.length === 0) {
            part.notes.push({ at: 78, duration: 8.4, midi: 60, velocity: 45 });
        }

        return part;
    });
    return scoreSchema.parse({
        key,
        title: original.title,
        bpm: original.bpm,
        seconds: SCORE_SECONDS,
        end: SCORE_END,
        parts,
    });
}
