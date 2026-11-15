import { Adsr, Curve, gain, hertz, RATE, random, type Stereo, Svf, stereo } from "./dsp";
import type { Lane, Lfo, Note, Oscillator, Patch } from "./types";

const CONTROL = 8;
const TAU = Math.PI * 2;
const VOWELS = [
    [730, 1090, 2440],
    [530, 1840, 2480],
    [270, 2290, 3010],
    [570, 840, 2410],
    [300, 870, 2240],
];
const VOWEL_GAINS = [1, 0.6, 0.35];

interface VoiceEvent {
    on: number;
    off: number;
    midi: number;
    velocity: number;
}

function blep(phase: number, step: number): number {
    if (phase < step) {
        const t = phase / step;
        return t + t - t * t - 1;
    }

    if (phase > 1 - step) {
        const t = (phase - 1) / step;
        return t * t + t + t + 1;
    }

    return 0;
}

function lfoValue(shape: Lfo["shape"], phase: number): number {
    if (shape === "triangle") {
        return 1 - 4 * Math.abs(phase - 0.5);
    }

    if (shape === "saw") {
        return 1 - 2 * phase;
    }

    if (shape === "square") {
        return phase < 0.5 ? 1 : -1;
    }

    return Math.sin(TAU * phase);
}

class OscState {
    readonly voices: number;
    readonly phases: Float64Array;
    readonly mods: Float64Array;
    readonly steps: Float64Array;
    readonly ratios: Float64Array;
    readonly left: Float64Array;
    readonly right: Float64Array;
    readonly level: number;
    readonly envelope?: Adsr;
    readonly filters?: [Svf, Svf];
    readonly pitchCoef: number;
    readonly fmCoef: number;
    pitchOffset = 0;
    fmIndex = 0;

    constructor(
        readonly spec: Oscillator,
        private readonly rand: () => number
    ) {
        this.voices = Math.max(1, spec.unison ?? 1);
        this.phases = new Float64Array(this.voices);
        this.mods = new Float64Array(this.voices);
        this.steps = new Float64Array(this.voices);
        this.ratios = new Float64Array(this.voices);
        this.left = new Float64Array(this.voices);
        this.right = new Float64Array(this.voices);
        this.level = (spec.level ?? 1) / Math.sqrt(this.voices);
        this.envelope = spec.envelope ? new Adsr(spec.envelope) : undefined;
        this.pitchCoef = spec.pitchEnvelope ? Math.exp((-4.6 * CONTROL) / (spec.pitchEnvelope.decay * RATE)) : 1;
        this.fmCoef = spec.fm?.decay ? Math.exp((-4.6 * CONTROL) / (spec.fm.decay * RATE)) : 1;

        if (spec.filter) {
            this.filters = [new Svf(), new Svf()];
            this.filters[0].set(spec.filter.cutoff, spec.filter.q ?? Math.SQRT1_2);
            this.filters[1].set(spec.filter.cutoff, spec.filter.q ?? Math.SQRT1_2);
        }

        for (let v = 0; v < this.voices; v++) {
            const spread = this.voices === 1 ? 0 : v / (this.voices - 1) - 0.5;
            const pan = spread * 2 * (spec.width ?? 0);
            this.ratios[v] = 2 ** (((spec.detune ?? 0) * spread) / 1200);
            this.left[v] = Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
            this.right[v] = Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
        }
    }

    trigger(): void {
        this.envelope?.gate(true);
        this.pitchOffset = this.spec.pitchEnvelope?.semitones ?? 0;
        this.fmIndex = this.spec.fm?.index ?? 0;

        for (let v = 0; v < this.voices; v++) {
            // One voice starts at zero for a repeatable transient; unison voices start apart, or they phase.
            this.phases[v] = this.voices === 1 ? 0 : this.rand();
            this.mods[v] = 0;
        }
    }
}

function renderVoice(options: {
    patch: Patch;
    events: VoiceEvent[];
    out: Stereo;
    seed: number;
    lanes: Map<string, Curve>;
}): void {
    const { patch, events, out, lanes } = options;
    const rand = random(options.seed);
    const oscs = patch.oscillators.map((spec) => new OscState(spec, rand));
    const amp = new Adsr(patch.envelope);
    const filter = patch.filter;
    const filterEnv = filter?.envelopeOctaves ? new Adsr(filter.envelope ?? patch.envelope) : undefined;
    const vowel = filter?.type === "vowel";
    const main: [Svf, Svf] = [new Svf(), new Svf()];
    const formants = vowel ? VOWEL_GAINS.map((): [Svf, Svf] => [new Svf(), new Svf()]) : [];
    const lfos = (patch.lfos ?? []).map((spec) => ({ spec, phase: 0 }));
    const drive = patch.drive ? gain(patch.drive) : 0;
    const driveNorm = drive ? 1 / Math.tanh(drive) : 1;
    const level = gain(patch.level ?? 0);
    const glide = patch.mono && patch.glide ? 1 - Math.exp(-3 / (patch.glide * RATE)) : 1;
    const total = out.left.length;
    const start = events[0].on;
    const noise = random(options.seed ^ 0x9e3779b9);
    let pitch = events[0].midi;
    let target = pitch;
    let velocity = 0;
    let velocityTarget = 0;
    let velocityCutoff = 0;
    let next = 0;
    let offAt = -1;
    let open = false;
    let filterLevel = 0;
    let lfoLevel = 1;
    let fmNow = 1;

    for (const lfo of lfos) {
        lfo.phase = lfo.spec.retrigger ? 0 : ((start / RATE) * lfo.spec.rate) % 1;
    }

    for (let n = start; n < total; n++) {
        while (next < events.length && events[next].on <= n) {
            const event = events[next++];
            const legato = open && patch.mono === true;
            target = event.midi;
            velocityTarget = (event.velocity / 127) ** 1.5;
            velocityCutoff = event.velocity / 127;

            if (!legato) {
                if (glide === 1 || amp.done) {
                    pitch = target;
                }

                if (amp.done) {
                    velocity = velocityTarget;
                }

                amp.gate(true);
                filterEnv?.gate(true);

                for (const osc of oscs) {
                    osc.trigger();
                }

                for (const lfo of lfos) {
                    if (lfo.spec.retrigger) {
                        lfo.phase = 0;
                    }
                }
            }

            offAt = event.off;
            open = true;
        }

        if (open && n >= offAt) {
            open = false;
            amp.gate(false);
            filterEnv?.gate(false);

            for (const osc of oscs) {
                osc.envelope?.gate(false);
            }
        }

        if ((n - start) % CONTROL === 0) {
            if (!open && next >= events.length && amp.done && oscs.every((osc) => osc.envelope?.done ?? true)) {
                break;
            }

            const seconds = n / RATE;
            const rate = lanes.get("lfoRate")?.at(seconds) ?? 1;
            let cutoffOctaves = lanes.get("cutoff")?.at(seconds) ?? 0;
            let pitchShift = lanes.get("pitch")?.at(seconds) ?? 0;
            let vowelShift = lanes.get("vowel")?.at(seconds) ?? 0;
            let fmScale = 1 + (lanes.get("fm")?.at(seconds) ?? 0);
            lfoLevel = 1;

            for (const lfo of lfos) {
                const value = lfoValue(lfo.spec.shape, lfo.phase);
                lfo.phase = (lfo.phase + (lfo.spec.rate * rate * CONTROL) / RATE) % 1;

                if (lfo.spec.target === "cutoff") {
                    cutoffOctaves += value * lfo.spec.depth;
                } else if (lfo.spec.target === "pitch") {
                    pitchShift += value * lfo.spec.depth;
                } else if (lfo.spec.target === "vowel") {
                    vowelShift += value * lfo.spec.depth;
                } else if (lfo.spec.target === "fm") {
                    fmScale *= 1 + value * lfo.spec.depth;
                } else {
                    lfoLevel *= 1 - lfo.spec.depth * (0.5 - 0.5 * value);
                }
            }

            for (const osc of oscs) {
                const semis = (osc.spec.semitones ?? 0) + osc.pitchOffset;
                const base =
                    osc.spec.fixed !== undefined
                        ? osc.spec.fixed * 2 ** (semis / 12)
                        : hertz(pitch + pitchShift + semis);
                osc.pitchOffset *= osc.pitchCoef;
                osc.fmIndex *= osc.fmCoef;

                for (let v = 0; v < osc.voices; v++) {
                    osc.steps[v] = Math.min(0.49, (base * osc.ratios[v]) / RATE);
                }
            }

            if (filter) {
                const octaves =
                    cutoffOctaves +
                    filterLevel * (filter.envelopeOctaves ?? 0) +
                    velocityCutoff * (filter.velocityOctaves ?? 0) +
                    ((filter.keyTrack ?? 0) * (pitch - 60)) / 12;

                if (vowel) {
                    const position = Math.min(3.999, Math.max(0, (filter.vowel ?? 0) + vowelShift));
                    const low = Math.floor(position);
                    const mix = position - low;

                    formants.forEach((pair, i) => {
                        const f = (VOWELS[low][i] * (1 - mix) + VOWELS[low + 1][i] * mix) * 2 ** octaves;
                        pair[0].set(f, filter.q ?? 8);
                        pair[1].set(f, filter.q ?? 8);
                    });
                } else {
                    main[0].set(filter.cutoff * 2 ** octaves, filter.q ?? Math.SQRT1_2);
                    main[1].set(filter.cutoff * 2 ** octaves, filter.q ?? Math.SQRT1_2);
                }
            }

            fmNow = fmScale;
        }

        pitch += (target - pitch) * glide;
        velocity += (velocityTarget - velocity) * 0.004;
        const ampLevel = amp.tick();
        filterLevel = filterEnv ? filterEnv.tick() : 0;
        let left = 0;
        let right = 0;

        for (const osc of oscs) {
            const spec = osc.spec;
            let l = 0;
            let r = 0;

            if (spec.wave === "noise") {
                l = noise() * 2 - 1;
                r = spec.width ? l * (1 - spec.width) + (noise() * 2 - 1) * spec.width : l;
            } else {
                for (let v = 0; v < osc.voices; v++) {
                    const step = osc.steps[v];
                    let phase = osc.phases[v] + step;

                    if (phase >= 1) {
                        phase -= 1;
                    }

                    osc.phases[v] = phase;
                    let sample: number;

                    if (spec.wave === "sine") {
                        if (spec.fm) {
                            osc.mods[v] = (osc.mods[v] + step * spec.fm.ratio) % 1;
                            sample = Math.sin(TAU * phase + osc.fmIndex * fmNow * Math.sin(TAU * osc.mods[v]));
                        } else {
                            sample = Math.sin(TAU * phase);
                        }
                    } else if (spec.wave === "triangle") {
                        sample = 4 * Math.abs(phase - 0.5) - 1;
                    } else if (spec.wave === "saw") {
                        sample = 2 * phase - 1 - blep(phase, step);
                    } else {
                        const width = spec.pulseWidth ?? 0.5;
                        sample = (phase < width ? 1 : -1) + blep(phase, step) - blep((phase + 1 - width) % 1, step);
                    }

                    l += sample * osc.left[v];
                    r += sample * osc.right[v];
                }
            }

            if (osc.filters && spec.filter) {
                const [fl, fr] = osc.filters;
                fl.tick(l);
                fr.tick(r);
                const type = spec.filter.type;
                l =
                    type === "lowpass"
                        ? fl.low
                        : type === "highpass"
                          ? fl.high
                          : type === "bandpass"
                            ? fl.band
                            : fl.low + fl.high;
                r =
                    type === "lowpass"
                        ? fr.low
                        : type === "highpass"
                          ? fr.high
                          : type === "bandpass"
                            ? fr.band
                            : fr.low + fr.high;
            }

            const envelope = (osc.envelope ? osc.envelope.tick() : ampLevel) * osc.level;
            left += l * envelope;
            right += r * envelope;
        }

        left *= velocity * lfoLevel;
        right *= velocity * lfoLevel;

        if (drive) {
            left = Math.tanh(left * drive) * driveNorm;
            right = Math.tanh(right * drive) * driveNorm;
        }

        if (vowel) {
            let l = 0;
            let r = 0;

            formants.forEach((pair, i) => {
                pair[0].tick(left);
                pair[1].tick(right);
                l += pair[0].band * VOWEL_GAINS[i];
                r += pair[1].band * VOWEL_GAINS[i];
            });
            left = l * 2;
            right = r * 2;
        } else if (filter) {
            const [fl, fr] = main;
            fl.tick(left);
            fr.tick(right);
            const type = filter.type;
            left =
                type === "lowpass"
                    ? fl.low
                    : type === "highpass"
                      ? fl.high
                      : type === "bandpass"
                        ? fl.band
                        : fl.low + fl.high;
            right =
                type === "lowpass"
                    ? fr.low
                    : type === "highpass"
                      ? fr.high
                      : type === "bandpass"
                        ? fr.band
                        : fr.low + fr.high;
        }

        out.left[n] += left * level;
        out.right[n] += right * level;
    }
}

/** Render every note of one part. A mono patch is one voice; any other patch gets a voice per note. */
export function renderSynth(options: {
    patch: Patch;
    notes: Note[];
    lanes?: Lane[];
    samples: number;
    seed: number;
}): Stereo {
    const out = stereo(options.samples);
    const lanes = new Map((options.lanes ?? []).map((lane) => [lane.target, new Curve(lane.points, lane.hold)]));
    const events = [...options.notes]
        .sort((a, b) => a.at - b.at)
        .map((note) => ({
            on: Math.round(note.at * RATE),
            off: Math.round((note.at + note.duration) * RATE),
            midi: note.midi,
            velocity: note.velocity,
        }));

    if (events.length === 0) {
        return out;
    }

    if (options.patch.mono) {
        renderVoice({ patch: options.patch, events, out, seed: options.seed, lanes });
        return out;
    }

    events.forEach((event, index) => {
        renderVoice({ patch: options.patch, events: [event], out, seed: options.seed + index * 7919, lanes });
    });
    return out;
}
