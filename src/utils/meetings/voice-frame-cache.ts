import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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

function readFrames(cachePath: string, key: string): VoiceFrame[] | undefined {
    try {
        const stat = statSync(cachePath, { throwIfNoEntry: false });
        if (!stat || stat.size > DIGEST_BYTES + MAX_VOICE_FRAMES * FRAME_BYTES) {
            return undefined;
        }

        const bytes = readFileSync(cachePath);
        if (
            (bytes.length - DIGEST_BYTES) % FRAME_BYTES !== 0 ||
            !bytes.subarray(0, DIGEST_BYTES).equals(digest(bytes, key))
        ) {
            return undefined;
        }

        const frames: VoiceFrame[] = [];
        for (let offset = DIGEST_BYTES; offset < bytes.length; offset += FRAME_BYTES) {
            frames.push({ channels: [readChannel(bytes, offset), readChannel(bytes, offset + CHANNEL_BYTES)] });
        }
        return frames;
    } catch (error) {
        logger.debug({ error, cachePath }, "Voice frame cache could not be read");
        return undefined;
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

    const cached = readFrames(cachePath, key);
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
                const saved = readFrames(cachePath, current);
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
