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

export function silenceTimedOut(options: {
    lastLoudMs: number;
    now: number;
    rms: number;
    threshold?: number;
    durationMs?: number;
}): boolean {
    const threshold = options.threshold ?? 0.02;
    if (options.rms >= threshold) {
        return false;
    }
    return options.now - options.lastLoudMs >= (options.durationMs ?? 400);
}
