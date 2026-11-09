import { logger } from "@genesiscz/utils/logger";
import { audioTrackCount } from "@genesiscz/utils/recording-editor/denoise";
import { atempoChain } from "@genesiscz/utils/recording-editor/ffmpeg";
import { runVideoCommand } from "@genesiscz/utils/video/process";

const { log } = logger.scoped("recording-editor-loudness");

/** The edit's audio settings (`project.audio`) that decide which of the movie's tracks the export plays. */
export interface PlayedAudio {
    /** False: the export plays no audio at all. */
    include?: boolean;
    /** The tracks (`a:N`) the export plays at volume 0. */
    mutedTracks?: readonly number[];
}

/** The tracks (`a:N`) out of `count` that the export plays: each unmuted one, none when the audio is left out. */
export function audibleTracks(count: number, audio: PlayedAudio = {}): number[] {
    if (audio.include === false) {
        return [];
    }

    return Array.from({ length: count }, (_, index) => index).filter((index) => !audio.mutedTracks?.includes(index));
}

/**
 * The tracks a transcription hears: the ones the export plays, so captions follow the sound the viewer hears. Throws
 * when no track plays, because a transcript of a muted track would caption words nobody hears.
 */
export function transcribedTracks(count: number, audio: PlayedAudio = {}): number[] {
    const tracks = audibleTracks(count, audio);

    if (tracks.length === 0) {
        throw new Error("every audio track is muted or left out, so there is nothing to transcribe");
    }

    return tracks;
}

/** `audibleTracks` over the movie's probed audio stream count. */
export async function audibleTracksOf(video: string, audio?: PlayedAudio): Promise<number[]> {
    return audibleTracks(await audioTrackCount(video), audio);
}

/**
 * The start of a filter graph that hears `tracks` the way the export mixes them: one track as it is, several summed by
 * amix with no level change. The next filter follows it directly.
 */
export function mixedTracksFilter(tracks: readonly number[]): string {
    const inputs = tracks.map((index) => `[0:a:${index}]`).join("");
    return tracks.length > 1 ? `${inputs}amix=inputs=${tracks.length}:normalize=0,` : inputs;
}

/** A played stretch of the source (an edit clip): its source range and its speed. */
export interface PlayedClip {
    fromUs: number;
    toUs: number;
    speed: number;
}

/**
 * The filter graph head that hears `tracks` as the export plays them: without clips the whole movie, with clips each
 * clip's source range of every track, mixed, sped up as it plays (so a part weighs its played length), then joined.
 */
export function playedAudioFilter(tracks: readonly number[], clips?: readonly PlayedClip[]): string {
    if (!clips || clips.length === 0) {
        return mixedTracksFilter(tracks);
    }

    const split = tracks.map(
        (track) => `[0:a:${track}]asplit=${clips.length}${clips.map((_, index) => `[t${track}c${index}]`).join("")}`
    );
    const parts = clips.map((clip, index) => {
        const trimmed = tracks.map(
            (track) =>
                `[t${track}c${index}]atrim=start=${clip.fromUs / 1_000_000}:end=${clip.toUs / 1_000_000},asetpts=PTS-STARTPTS[a${track}c${index}]`
        );
        const inputs = tracks.map((track) => `[a${track}c${index}]`).join("");
        const mixed = tracks.length > 1 ? `${inputs}amix=inputs=${tracks.length}:normalize=0` : `${inputs}anull`;
        const speed = clip.speed === 1 ? "" : `,${atempoChain(clip.speed)}`;
        return `${trimmed.join(";")};${mixed}${speed}[p${index}]`;
    });
    const joined = `${clips.map((_, index) => `[p${index}]`).join("")}concat=n=${clips.length}:v=0:a=1`;
    return `${[...split, ...parts].join(";")};${joined},`;
}

/**
 * The integrated loudness (EBU R128, LUFS) of the movie's audio tracks that are not muted, mixed as the export mixes
 * them; undefined when no such track exists. ebur128 prints its running values as frame metadata; the last
 * `lavfi.r128.I` is the whole movie's. It ignores `include`, because normalize turns the audio on. With `clips`, only
 * those stretches count, at their played speed, so the gain fits what the export plays after cuts.
 */
export async function integratedLoudness(options: {
    video: string;
    mutedTracks?: readonly number[];
    clips?: readonly PlayedClip[];
}): Promise<number | undefined> {
    const tracks = await audibleTracksOf(options.video, { mutedTracks: options.mutedTracks });

    if (tracks.length === 0) {
        return undefined;
    }

    const text = await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            options.video,
            "-filter_complex",
            `${playedAudioFilter(tracks, options.clips)}ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file=-[out]`,
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
    log.debug(
        { video: options.video, tracks, clips: options.clips?.length, lufs, readings: values.length },
        "integrated loudness measured"
    );
    return lufs;
}
