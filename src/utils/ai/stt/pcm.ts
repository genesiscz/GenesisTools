/**
 * Linear-interpolation resampler for s16le mono PCM. Speech providers that insist on one input
 * rate (OpenAI realtime: 24 kHz minimum) get their rate without forcing every capture source to
 * change; linear interpolation is adequate for 16 → 24 kHz speech, which is the only path here.
 */
export function resamplePcm16(pcm: Uint8Array, fromHz: number, toHz: number): Uint8Array {
    if (fromHz === toHz || pcm.byteLength < 4) {
        return pcm;
    }

    const input = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const outputLength = Math.max(1, Math.round((input.length * toHz) / fromHz));
    const output = new Int16Array(outputLength);
    const step = fromHz / toHz;
    for (let index = 0; index < outputLength; index++) {
        const position = index * step;
        const left = Math.floor(position);
        const right = Math.min(left + 1, input.length - 1);
        const fraction = position - left;
        const sample = input[left] * (1 - fraction) + input[right] * fraction;
        output[index] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    return new Uint8Array(output.buffer);
}
