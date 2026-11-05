import { logger } from "@genesiscz/utils/logger";
import { runVideoCommand } from "@genesiscz/utils/video/process";

const { log } = logger.scoped("recording-editor-loudness");

/**
 * The integrated loudness (EBU R128, LUFS) of the movie's audio tracks that are not muted, mixed as the export mixes
 * them; undefined when no such track exists. ebur128 prints its running values as frame metadata; the last
 * `lavfi.r128.I` is the whole movie's.
 */
export async function integratedLoudness(options: {
    video: string;
    mutedTracks?: readonly number[];
}): Promise<number | undefined> {
    const streams = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            options.video,
        ],
    });
    const count = streams.split("\n").filter((line) => line.trim()).length;
    const tracks = Array.from({ length: count }, (_, index) => index).filter(
        (index) => !options.mutedTracks?.includes(index)
    );

    if (tracks.length === 0) {
        return undefined;
    }

    const inputs = tracks.map((index) => `[0:a:${index}]`).join("");
    const mix = tracks.length > 1 ? `${inputs}amix=inputs=${tracks.length}:normalize=0,` : inputs;
    const text = await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            options.video,
            "-filter_complex",
            `${mix}ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file=-[out]`,
            "-map",
            "[out]",
            "-f",
            "null",
            "-",
        ],
        timeoutMs: 10 * 60_000,
    });
    const values = [...text.matchAll(/lavfi\.r128\.I=(-?[\d.]+)/g)].map((match) => Number(match[1]));
    const lufs = values.at(-1);
    log.debug({ video: options.video, tracks, lufs, readings: values.length }, "integrated loudness measured");
    return lufs;
}
