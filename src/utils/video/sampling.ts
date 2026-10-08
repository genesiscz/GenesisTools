import { VIDEO_FPS, VIDEO_GROUPS } from "./types";

/** Round an ffprobe decimal up to a microsecond without binary float boundary drift. */
export function secondsToMicroseconds(value: string): number {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
        throw new Error("Invalid nonnegative video timestamp");
    }

    const fraction = match[2] ?? "";
    const micros =
        BigInt(match[1]) * 1_000_000n +
        BigInt(fraction.slice(0, 6).padEnd(6, "0")) +
        (/[1-9]/.test(fraction.slice(6)) ? 1n : 0n);
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Video timestamp exceeds the safe range");
    }

    return Number(micros);
}

/**
 * A frame timestamp may be negative: an MP4 with B-frames and no edit list often starts at -0.03 s.
 * Callers shift every frame by the first one, so only the sign has to survive.
 */
export function signedSecondsToMicroseconds(value: string): number {
    if (value.startsWith("-")) {
        return -secondsToMicroseconds(value.slice(1));
    }

    return secondsToMicroseconds(value);
}

export function planVideoSamples({
    durationUs,
    fps,
    framesPerImage,
    startUs = 0,
    endUs = durationUs,
}: {
    durationUs: number;
    fps: number;
    framesPerImage: number;
    startUs?: number;
    endUs?: number;
}) {
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || durationUs > 600_000_000) {
        throw new Error("Video must be longer than zero and no longer than 10 minutes");
    }

    if (!VIDEO_FPS.some((value) => value === fps) || !VIDEO_GROUPS.some((value) => value === framesPerImage)) {
        throw new Error("Choose 1–4 FPS and 1, 4, 8, 16, or 32 frames per image");
    }

    if (
        !Number.isSafeInteger(startUs) ||
        !Number.isSafeInteger(endUs) ||
        startUs < 0 ||
        endUs > durationUs ||
        endUs <= startUs
    ) {
        throw new Error("Choose a nonempty video range within the original duration, in whole microseconds");
    }

    const count = Math.ceil(((endUs - startUs) * fps) / 1_000_000);
    return {
        timestampsUs: Array.from({ length: count }, (_, index) => startUs + (index * 1_000_000) / fps),
        candidates: count,
        images: Math.ceil(count / framesPerImage),
        lastImageFrames: ((count - 1) % framesPerImage) + 1,
    };
}

/** Sampling picks the source frame displayed at that instant, retaining its real timestamp. */
export function locateVideoSamples({ requestedUs, sourceUs }: { requestedUs: number[]; sourceUs: number[] }) {
    if (
        !sourceUs.length ||
        sourceUs.some(
            (value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value < sourceUs[index - 1])
        )
    ) {
        throw new Error("Video has no usable monotonic frame timestamps");
    }

    let index = 0;
    return requestedUs.map((time) => {
        while (index + 1 < sourceUs.length && sourceUs[index + 1] <= time) {
            index += 1;
        }

        return { requestedUs: time, actualUs: sourceUs[index], sourceIndex: index };
    });
}
