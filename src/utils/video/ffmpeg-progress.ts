/** One block of `ffmpeg -progress` output: where the encode is in the output timeline, and how fast it moves. */
export interface FfmpegProgress {
    outTimeSec: number | null;
    /** Times realtime, e.g. 21.3 for "21.3x". */
    speed: number | null;
    totalBytes: number | null;
    /** `progress=end`: the last block of the run. */
    ended: boolean;
}

function numberOrNull(value: string | undefined): number | null {
    if (value === undefined || value === "N/A") {
        return null;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Turns the `key=value` lines `ffmpeg -progress pipe:1` writes into one callback per block. A block ends at its
 * `progress=continue|end` line; chunks may split a line anywhere, so the reader keeps the unfinished tail.
 */
export function ffmpegProgressReader(onProgress: (progress: FfmpegProgress) => void): (chunk: Uint8Array) => void {
    const decoder = new TextDecoder();
    let pending = "";
    let block: Record<string, string> = {};

    return (chunk) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";

        for (const line of lines) {
            const equals = line.indexOf("=");

            if (equals < 1) {
                continue;
            }

            const key = line.slice(0, equals).trim();
            const value = line.slice(equals + 1).trim();

            if (key !== "progress") {
                block[key] = value;
                continue;
            }

            const outTimeUs = numberOrNull(block.out_time_us ?? block.out_time_ms);
            onProgress({
                outTimeSec: outTimeUs === null || outTimeUs < 0 ? null : outTimeUs / 1_000_000,
                speed: numberOrNull(block.speed?.replace(/x$/, "")),
                totalBytes: numberOrNull(block.total_size),
                ended: value === "end",
            });
            block = {};
        }
    };
}
