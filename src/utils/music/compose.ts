import type { Effects, Lane, Note, Source } from "./types";

/** The sound and the mix of one part of a score written in code. */
export interface PartSetup {
    source: Source;
    pan?: number;
    effects: Effects;
    lanes?: Lane[];
}

/** A grid of sixteenth steps for a score written in code: sixteen steps make one bar. */
export function grid<Name extends string>(bpm: number, names: readonly Name[]) {
    const step = 60 / bpm / 4;
    const bar = step * 16;
    const notes = Object.fromEntries(names.map((name) => [name, [] as Note[]])) as Record<Name, Note[]>;

    return {
        step,
        bar,
        notes,
        /** Seconds at the start of a bar. */
        at: (bars: number) => bars * bar,
        /** One note: `step` and `steps` are sixteenths and may be fractions. */
        put(part: Name, bars: number, start: number, steps: number, midi: number, velocity: number) {
            notes[part].push({
                at: bars * bar + start * step,
                duration: steps * step,
                midi,
                velocity: Math.round(velocity),
            });
        },
        /** The parts as `scoreSchema` reads them, in the order of the names. `effects.gain` sets each level. */
        parts: (setup: Record<Name, PartSetup>) =>
            names.map((name) => ({
                name,
                source: setup[name].source,
                volume: 127,
                pan: setup[name].pan,
                notes: notes[name],
                effects: setup[name].effects,
                lanes: setup[name].lanes,
            })),
    };
}
