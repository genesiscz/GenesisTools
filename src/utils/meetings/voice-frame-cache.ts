import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { type ChannelVoice, MAX_VOICE_FRAMES, type VoiceFrame, voiceFrames } from "./voice-features";

// Bump when the decode, frame math or binary layout changes. The digest covers the source key and all frame bytes.
const FRAME_VERSION = 1;
const DIGEST_BYTES = 32;
const CHANNEL_BYTES = 5 * Float64Array.BYTES_PER_ELEMENT;
const FRAME_BYTES = 2 * CHANNEL_BYTES;

function sourceKey(audioPath: string): string | undefined {
    const identity = fileIdentity(audioPath);
    return identity ? SafeJSON.stringify([FRAME_VERSION, audioPath, identity], { strict: true }) : undefined;
}

function digest(bytes: Buffer, key: string): Buffer {
    return createHash("sha256").update(key).update(bytes.subarray(DIGEST_BYTES)).digest();
}

function pack(frames: VoiceFrame[], key: string): Buffer {
    const bytes = Buffer.allocUnsafe(DIGEST_BYTES + frames.length * FRAME_BYTES);
    let offset = DIGEST_BYTES;
    for (const frame of frames) {
        for (let side = 0; side < 2; side++) {
            const channel = frame.channels[side]!;
            offset = bytes.writeDoubleLE(channel.rms, offset);
            offset = bytes.writeDoubleLE(channel.lowBandShare, offset);
            offset = bytes.writeDoubleLE(channel.tilt, offset);
            offset = bytes.writeDoubleLE(channel.pitchHz ?? NaN, offset);
            offset = bytes.writeDoubleLE(channel.voicedShare, offset);
        }
    }
    digest(bytes, key).copy(bytes);
    return bytes;
}

function readChannel(bytes: Buffer, offset: number): ChannelVoice {
    const pitch = bytes.readDoubleLE(offset + 24);
    return {
        rms: bytes.readDoubleLE(offset),
        lowBandShare: bytes.readDoubleLE(offset + 8),
        tilt: bytes.readDoubleLE(offset + 16),
        pitchHz: Number.isNaN(pitch) ? null : pitch,
        voicedShare: bytes.readDoubleLE(offset + 32),
    };
}

/** How long a cache read holds the event loop before it yields, like the decoder's own time slices. */
const READ_SLICE_MS = 20;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

function yieldToLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * An eight-hour cache holds about 46 MB: it is read, hashed and decoded in slices, never in one blocking pass. The
 * file is opened once and its size bound is checked on that handle, so a file replaced after the check is never read.
 */
async function readFrames(cachePath: string, key: string): Promise<VoiceFrame[] | undefined> {
    const handle = await open(cachePath, "r").catch(() => undefined);
    if (!handle) {
        return undefined;
    }

    try {
        const { size } = await handle.stat();
        if (
            size < DIGEST_BYTES ||
            size > DIGEST_BYTES + MAX_VOICE_FRAMES * FRAME_BYTES ||
            (size - DIGEST_BYTES) % FRAME_BYTES !== 0
        ) {
            return undefined;
        }

        const bytes = Buffer.allocUnsafe(size);
        const hash = createHash("sha256").update(key);
        for (let filled = 0; filled < size; ) {
            const { bytesRead } = await handle.read(bytes, filled, Math.min(HASH_CHUNK_BYTES, size - filled), filled);
            if (bytesRead === 0) {
                return undefined;
            }

            if (filled + bytesRead > DIGEST_BYTES) {
                hash.update(bytes.subarray(Math.max(filled, DIGEST_BYTES), filled + bytesRead));
            }

            filled += bytesRead;
        }

        if (!bytes.subarray(0, DIGEST_BYTES).equals(hash.digest())) {
            return undefined;
        }

        const frames: VoiceFrame[] = [];
        let sliceStart = performance.now();
        for (let offset = DIGEST_BYTES; offset < bytes.length; offset += FRAME_BYTES) {
            frames.push({ channels: [readChannel(bytes, offset), readChannel(bytes, offset + CHANNEL_BYTES)] });
            if (performance.now() - sliceStart > READ_SLICE_MS) {
                await yieldToLoop();
                sliceStart = performance.now();
            }
        }
        return frames;
    } catch (error) {
        logger.debug({ error, cachePath }, "Voice frame cache could not be read");
        return undefined;
    } finally {
        await handle.close();
    }
}

/** Collecting evidence may populate the cache. Read-only callers can still use the streaming decoder directly. */
export async function collectVoiceFrames({
    audioPath,
    cachePath,
}: {
    audioPath: string;
    cachePath: string;
}): Promise<VoiceFrame[]> {
    const key = sourceKey(audioPath);
    if (!key) {
        return voiceFrames({ audioPath });
    }

    const cached = await readFrames(cachePath, key);
    if (cached && sourceKey(audioPath) === key) {
        return cached;
    }

    let acquired = false;
    try {
        return await withFileLock(
            `${cachePath}.lock`,
            async () => {
                acquired = true;
                const current = sourceKey(audioPath);
                if (!current) {
                    return voiceFrames({ audioPath });
                }

                // Another process may have finished collecting while this one waited for the lock.
                const saved = await readFrames(cachePath, current);
                if (saved && sourceKey(audioPath) === current) {
                    return saved;
                }

                const frames = await voiceFrames({ audioPath });
                if (sourceKey(audioPath) !== current) {
                    throw new Error("Audio changed during voice frame collection");
                }

                try {
                    atomicWriteFileSync(cachePath, pack(frames, current), { mode: 0o600 });
                } catch (error) {
                    logger.debug({ error, cachePath }, "Voice frames computed but cache could not be saved");
                }
                return frames;
            },
            180_000
        );
    } catch (error) {
        if (acquired) {
            throw error;
        }

        logger.debug({ error, cachePath }, "Voice frame cache lock unavailable; decoding without saving");
        return voiceFrames({ audioPath });
    }
}
