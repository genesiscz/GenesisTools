export interface DingPreset {
    freqs: number[];
    durationMs: number;
    attackMs: number;
    decayMs: number;
}

export const DING_PRESETS: Record<string, DingPreset> = {
    "soft-chime": { freqs: [880, 1320], durationMs: 320, attackMs: 6, decayMs: 280 },
    "subtle-bell": { freqs: [660, 990, 1980], durationMs: 420, attackMs: 4, decayMs: 380 },
    blip: { freqs: [1200], durationMs: 90, attackMs: 2, decayMs: 70 },
    knock: { freqs: [180, 240], durationMs: 130, attackMs: 1, decayMs: 110 },
};

const SAMPLE_RATE = 24000;

/** Deterministic additive synth → 16-bit mono PCM WAV. No deps, no assets. */
export function renderPresetWav(name: keyof typeof DING_PRESETS | string): Buffer {
    const p = DING_PRESETS[name] ?? DING_PRESETS["soft-chime"];
    const n = Math.floor((p.durationMs / 1000) * SAMPLE_RATE);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        const ms = (i / SAMPLE_RATE) * 1000;
        const atk = Math.min(1, ms / p.attackMs);
        const dec = Math.exp(-Math.max(0, ms - p.attackMs) / p.decayMs);
        const env = atk * dec;
        let s = 0;
        for (const f of p.freqs) {
            s += Math.sin(2 * Math.PI * f * t);
        }

        s = (s / p.freqs.length) * env * 0.6;
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
    }

    return wrapWav(pcm, SAMPLE_RATE);
}

function wrapWav(pcm: Buffer, rate: number): Buffer {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}
