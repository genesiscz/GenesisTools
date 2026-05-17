export interface DetectedAudioFormat {
    contentType: string;
    filename: string;
    /** Extension without leading dot, e.g. "mp3". */
    ext: string;
}

/**
 * Detect an audio container from its leading magic bytes.
 *
 * Cloud STT APIs (OpenAI, Deepgram, …) infer the codec from the upload's
 * extension / content-type, so a buffer must never be handed over with a
 * mislabeled name (e.g. MP3 bytes written to a `.wav` temp file made Whisper
 * misbehave). Falls back to an mp3 hint when the signature is unknown.
 */
export function detectAudioFormat(buf: Buffer): DetectedAudioFormat {
    if (buf.length < 12) {
        return { contentType: "application/octet-stream", filename: "audio.bin", ext: "bin" };
    }

    // WAV: "RIFF....WAVE"
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
        return { contentType: "audio/wav", filename: "audio.wav", ext: "wav" };
    }

    // FLAC: "fLaC"
    if (buf.toString("ascii", 0, 4) === "fLaC") {
        return { contentType: "audio/flac", filename: "audio.flac", ext: "flac" };
    }

    // OGG: "OggS"
    if (buf.toString("ascii", 0, 4) === "OggS") {
        return { contentType: "audio/ogg", filename: "audio.ogg", ext: "ogg" };
    }

    // MP4 / M4A: "....ftyp" at offset 4
    if (buf.toString("ascii", 4, 8) === "ftyp") {
        const brand = buf.toString("ascii", 8, 12);
        // M4A audio brands: "M4A ", "mp42", "isom", "iso2"
        if (brand.startsWith("M4A") || brand === "mp42" || brand === "isom" || brand === "iso2") {
            return { contentType: "audio/mp4", filename: "audio.m4a", ext: "m4a" };
        }

        return { contentType: "audio/mp4", filename: "audio.mp4", ext: "mp4" };
    }

    // MP3 with ID3 tag: "ID3"
    if (buf.toString("ascii", 0, 3) === "ID3") {
        return { contentType: "audio/mpeg", filename: "audio.mp3", ext: "mp3" };
    }

    // MP3 frame sync: 0xFFEx / 0xFFFx
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
        return { contentType: "audio/mpeg", filename: "audio.mp3", ext: "mp3" };
    }

    // WebM / Matroska: 0x1A 0x45 0xDF 0xA3
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        return { contentType: "audio/webm", filename: "audio.webm", ext: "webm" };
    }

    // Default — let the server try to figure it out, fall back to mp3 hint
    return { contentType: "audio/mpeg", filename: "audio.mp3", ext: "mp3" };
}

/** Extension (no dot) for a buffer's detected audio container. */
export function sniffAudioExt(buf: Buffer): string {
    return detectAudioFormat(buf).ext;
}
