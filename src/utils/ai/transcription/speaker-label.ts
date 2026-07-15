/**
 * The single place speaker-label format is decided. sherpa-onnx emits
 * `speaker_00` (lowercase); Deepgram emits integer ids; the pyannote /
 * Spokenly / reference-SRT convention is `SPEAKER_00` (uppercase, zero-padded
 * to 2). Every render path MUST go through this — never uppercase ad hoc.
 */
export function normalizeSpeakerLabel(raw: string | number | null | undefined): string | undefined {
    if (raw === null || raw === undefined || raw === "") {
        return undefined;
    }

    if (typeof raw === "number") {
        if (!Number.isInteger(raw) || raw < 0) {
            return undefined;
        }

        return `SPEAKER_${String(raw).padStart(2, "0")}`;
    }

    const m = raw.match(/(\d+)\s*$/);

    if (m) {
        return `SPEAKER_${m[1].padStart(2, "0")}`;
    }

    // Unknown format (no trailing digits) — pass through uppercased. sherpa
    // (`speaker_NN`) and Deepgram (int) always hit the branches above; this is
    // a safety fallthrough, not an expected path.
    return raw.toUpperCase();
}

/**
 * Inverse of `normalizeSpeakerLabel`: extract the numeric speaker index from a
 * `SPEAKER_NN`-style label (any casing / trailing-digit format). Returns
 * undefined for labels without a trailing number.
 */
export function speakerIndexFromLabel(label: string | null | undefined): number | undefined {
    if (!label) {
        return undefined;
    }

    const m = label.match(/(\d+)\s*$/);

    if (!m) {
        return undefined;
    }

    const idx = Number.parseInt(m[1], 10);
    return Number.isInteger(idx) && idx >= 0 ? idx : undefined;
}
