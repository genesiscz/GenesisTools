/** Root-mean-square level of one s16le mono frame, 0..1. */
export function pcmRms(pcm: Uint8Array): number {
    if (pcm.byteLength < 2) {
        return 0;
    }

    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0;
    let samples = 0;
    for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
        const sample = view.getInt16(offset, true) / 32768;
        sum += sample * sample;
        samples++;
    }

    return samples === 0 ? 0 : Math.sqrt(sum / samples);
}

export const VAD_DEFAULT_THRESHOLD = 0.02;
export const VAD_DEFAULT_SILENCE_MS = 400;

export function silenceTimedOut(options: {
    lastLoudMs: number;
    now: number;
    rms: number;
    threshold?: number;
    durationMs?: number;
}): boolean {
    const threshold = options.threshold ?? VAD_DEFAULT_THRESHOLD;
    if (options.rms >= threshold) {
        return false;
    }

    return options.now - options.lastLoudMs >= (options.durationMs ?? VAD_DEFAULT_SILENCE_MS);
}

/**
 * Local speech gate over PCM frames: emits `speech_start` when the level crosses the threshold and
 * `speech_end` after `silenceMs` below it, so a pipeline can fire on silence without waiting for
 * the provider's own endpointing.
 */
export class LocalVad {
    private speaking = false;
    private lastLoudMs = 0;

    constructor(
        private readonly options: { threshold?: number; silenceMs?: number } = {},
        private readonly now: () => number = () => Date.now()
    ) {}

    /** Returns the transition this frame caused, if any. */
    push(pcm: Uint8Array): "speech_start" | "speech_end" | null {
        const rms = pcmRms(pcm);
        const now = this.now();
        if (rms >= (this.options.threshold ?? VAD_DEFAULT_THRESHOLD)) {
            this.lastLoudMs = now;
            if (!this.speaking) {
                this.speaking = true;
                return "speech_start";
            }

            return null;
        }

        if (
            this.speaking &&
            silenceTimedOut({
                lastLoudMs: this.lastLoudMs,
                now,
                rms,
                threshold: this.options.threshold,
                durationMs: this.options.silenceMs,
            })
        ) {
            this.speaking = false;
            return "speech_end";
        }

        return null;
    }
}
