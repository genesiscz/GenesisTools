import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { audioTrackCount } from "@genesiscz/utils/recording-editor/denoise";
import { atempoChain } from "@genesiscz/utils/recording-editor/ffmpeg";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { type AudioFacts, type AudioLane, movieTracksPlayed } from "./audio-lanes";

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
    return clips?.length
        ? playedClipsFilter(
              tracks.map((track) => `[0:a:${track}]`),
              clips
          )
        : mixedTracksFilter(tracks);
}

function playedClipsFilter(labels: readonly string[], clips: readonly PlayedClip[]): string {
    const tracks = labels.map((_, index) => index);
    const split = labels.map(
        (label, track) => `${label}asplit=${clips.length}${clips.map((_, index) => `[t${track}c${index}]`).join("")}`
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

/** An audible recording lane, with the same source choice and gain as the renderer. */
export interface RecordingLaneInput {
    path: string;
    track: number;
    volume: number;
    offsetMs: number;
}

export function recordingLaneInputs(options: {
    video: string;
    lanes: readonly AudioLane[];
    facts: AudioFacts;
}): RecordingLaneInput[] {
    const { video, lanes, facts } = options;
    const movie = new Set(movieTracksPlayed(lanes, facts));
    const result: RecordingLaneInput[] = [];
    for (const lane of lanes) {
        if (lane.source === "music" || lane.source === "voiceover") {
            continue;
        }
        if (lane.file) {
            const path = resolve(dirname(video), lane.file);
            if (!lane.muted && lane.volume > 0 && existsSync(path)) {
                result.push({ path, track: 0, volume: lane.volume, offsetMs: lane.offsetMs });
            }
        } else if (lane.track !== undefined && movie.delete(lane.track) && !lane.muted && lane.volume > 0) {
            result.push({ path: video, track: lane.track, volume: lane.volume, offsetMs: 0 });
        }
    }
    return result;
}

/** Place each recording input on the source clock before summing, as AVFoundation does in the export. */
function laneMix(lanes: readonly RecordingLaneInput[], durationUs: number) {
    const files = [...new Set(lanes.map(({ path }) => path))];
    const duration = durationUs / 1_000_000;
    const streams = lanes.map(({ path, track, volume, offsetMs }, index) => {
        const start = offsetMs < 0 ? `atrim=start=${-offsetMs / 1000},asetpts=PTS-STARTPTS,` : "";
        const delay = offsetMs > 0 ? `adelay=${offsetMs}:all=1,` : "";
        return `[${files.indexOf(path)}:a:${track}]aresample=48000:async=1:first_pts=0,${start}${delay}volume=${volume},apad,atrim=duration=${duration}[lane${index}]`;
    });
    const labels = lanes.map((_, index) => `[lane${index}]`).join("");
    const mix = lanes.length > 1 ? `amix=inputs=${lanes.length}:normalize=0` : "anull";
    return { inputs: files.flatMap((file) => ["-i", file]), graph: `${streams.join(";")};${labels}${mix}[recorded]` };
}

/** Transcription uses the source clock, before cuts, and the same recording lanes as export. */
export async function recordingLanesToMonoMp3(options: {
    lanes: readonly RecordingLaneInput[];
    durationUs: number;
    output: string;
}): Promise<void> {
    const mix = laneMix(options.lanes, options.durationUs);
    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            ...mix.inputs,
            "-filter_complex",
            mix.graph,
            "-map",
            "[recorded]",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "64k",
            options.output,
        ],
        timeoutMs: 10 * 60_000,
    });
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
    mix?: { lanes: readonly RecordingLaneInput[]; durationUs: number };
}): Promise<number | undefined> {
    const tracks = options.mix ? [] : await audibleTracksOf(options.video, { mutedTracks: options.mutedTracks });

    if ((options.mix?.lanes.length ?? tracks.length) === 0) {
        return undefined;
    }

    const mix = options.mix && laneMix(options.mix.lanes, options.mix.durationUs);
    const audioFilter = mix
        ? `${mix.graph};${options.clips?.length ? playedClipsFilter(["[recorded]"], options.clips) : "[recorded]"}`
        : playedAudioFilter(tracks, options.clips);
    const text = await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            ...(mix ? mix.inputs : ["-i", options.video]),
            "-filter_complex",
            `${audioFilter}ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.I:file=-[out]`,
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
