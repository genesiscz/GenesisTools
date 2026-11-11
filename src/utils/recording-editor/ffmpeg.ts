/** ffmpeg command lines of the editor, kept pure so a test can read them. */
import { mixedTracksFilter } from "@genesiscz/utils/recording-editor/loudness";

function seconds(us: number): string {
    return (us / 1_000_000).toFixed(6);
}

/**
 * The ffmpeg filter that samples a movie `fps` times a second on the editor's time base: slot n is the frame the editor
 * shows at n / fps, the latest frame whose time is at or before it. ffmpeg's default (`round=near`) takes the nearest
 * frame instead, up to half a step LATER, so a 1 fps survey of a variable-frame-rate movie placed screen text up to
 * 0.5 s early (round 5, item 1). `start_time=0` keeps slot 0 at the start of the input (or of its `-ss` seek point).
 */
export function sampleFpsFilter(fps: number): string {
    return `fps=${fps}:round=up:start_time=0`;
}

/** `atempo` takes 0.5 to 2 per instance, so a larger change is a chain of them. */
export function atempoChain(factor: number): string {
    const parts: number[] = [];
    let left = factor;

    while (left > 2) {
        parts.push(2);
        left /= 2;
    }

    while (left < 0.5) {
        parts.push(0.5);
        left /= 0.5;
    }

    parts.push(left);
    return parts.map((part) => `atempo=${Number(part.toFixed(6))}`).join(",");
}

const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18"];
/** H.264 and yuv420p need even dimensions; a screen capture of an odd-sized window has them otherwise. */
const EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

export function trimArgv(options: { input: string; output: string; fromUs: number; toUs: number }): string[] {
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-ss",
        seconds(options.fromUs),
        "-i",
        options.input,
        "-t",
        seconds(options.toUs - options.fromUs),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        EVEN,
        ...H264,
        "-c:a",
        "aac",
        options.output,
    ];
}

export function speedArgv(options: { input: string; output: string; factor: number; audio: boolean }): string[] {
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        options.input,
        "-map",
        "0:v:0",
        // Every audio track, as trimArgv keeps them: a recording of system sound and mic has two.
        ...(options.audio ? ["-map", "0:a", "-filter:a", atempoChain(options.factor), "-c:a", "aac"] : ["-an"]),
        "-filter:v",
        `setpts=PTS/${options.factor},${EVEN}`,
        // Without it the muxer keeps the source's constant rate and drops the frames a speed-up packs closer.
        "-fps_mode",
        "passthrough",
        ...H264,
        options.output,
    ];
}

const GIF_FILTER = "fps=10,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse";

function encodeArgs(format: "mp4" | "gif" | "webm", audio: boolean): string[] {
    switch (format) {
        case "mp4":
            return ["-vf", EVEN, ...H264, ...(audio ? ["-c:a", "aac"] : ["-an"]), "-movflags", "+faststart"];
        case "webm":
            // Rows in parallel at speed 3, and CRF 32 for the detail speed 3 loses: on 10 s of 1440p60 a third less
            // CPU than one row at a time at CRF 34, SSIM 0.99911 against 0.99900, the file 5 % larger (deep test RE8).
            return [
                "-vf",
                EVEN,
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                "32",
                "-row-mt",
                "1",
                "-deadline",
                "good",
                "-cpu-used",
                "3",
                ...(audio ? ["-c:a", "libopus"] : ["-an"]),
            ];
        case "gif":
            return ["-filter_complex", GIF_FILTER, "-an"];
    }
}

/**
 * The audio of an export with `audioTracks` tracks, as the Swift export plays it: one track as it is (optional, so an
 * input with none still converts), several mixed into one with no level change. Without a map ffmpeg keeps only one
 * track, so a recording of system sound and mic lost the mic in a player that plays the first track only.
 */
function exportAudioArgs(audioTracks: number): { graph: string[]; map: string[] } {
    if (audioTracks > 1) {
        const tracks = Array.from({ length: audioTracks }, (_, index) => index);
        return {
            graph: ["-filter_complex", `${mixedTracksFilter(tracks).replace(/,$/, "")}[a]`],
            map: ["-map", "[a]"],
        };
    }

    return { graph: [], map: audioTracks === 1 ? ["-map", "0:a:0?"] : [] };
}

/** A video, or the window of it, in another format; `audioTracks` is the input's audio track count. */
export function exportVideoArgv(options: {
    input: string;
    output: string;
    format: "mp4" | "gif" | "webm";
    audioTracks: number;
    fromUs?: number;
    toUs?: number;
}): string[] {
    const window = [
        ...(options.fromUs !== undefined ? ["-ss", seconds(options.fromUs)] : []),
        ...(options.toUs !== undefined ? ["-to", seconds(options.toUs)] : []),
    ];
    const audio = options.format === "gif" ? { graph: [], map: [] } : exportAudioArgs(options.audioTracks);
    const maps = options.format === "gif" ? [] : ["-map", "0:v:0", ...audio.map];
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-v",
        "error",
        ...window,
        "-i",
        options.input,
        ...audio.graph,
        ...maps,
        "-f",
        options.format,
        ...encodeArgs(options.format, options.audioTracks > 0),
        options.output,
    ];
}

/** The concat demuxer's list: each frame shown until the next one, the last for `lastUs`. */
export function concatList(frames: readonly { path: string; atUs: number }[], lastUs = 1_000_000): string {
    const lines = ["ffconcat version 1.0"];

    for (const [index, frame] of frames.entries()) {
        const next = frames[index + 1];
        const durationUs = next ? Math.max(1_000, next.atUs - frame.atUs) : lastUs;
        lines.push(`file '${frame.path.replace(/'/g, "'\\''")}'`, `duration ${seconds(durationUs)}`);
    }

    // The concat demuxer drops the last duration unless the last file is listed once more.
    if (frames.length > 0) {
        lines.push(`file '${frames[frames.length - 1].path.replace(/'/g, "'\\''")}'`);
    }

    return `${lines.join("\n")}\n`;
}

/** A still-frame sequence as a movie; `list` is a concat list written by `concatList`. */
export function exportFramesArgv(options: { list: string; output: string; format: "mp4" | "gif" | "webm" }): string[] {
    return [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        options.list,
        "-fps_mode",
        "vfr",
        "-f",
        options.format,
        ...encodeArgs(options.format, false),
        options.output,
    ];
}
