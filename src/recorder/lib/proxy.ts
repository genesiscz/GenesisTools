import { existsSync, readdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { concatList } from "@genesiscz/utils/recording-editor/ffmpeg";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { runVideoCommand } from "@genesiscz/utils/video/process";

const { log } = logger.scoped("recorder-proxy");

/** An audio piece of a frames recording: `audio/<epoch ms>-d<display>-audio-<source>.m4a`. */
const AUDIO_PIECE = /^(\d+(?:\.\d+)?)-d(\d+)-audio-(mic|system)\.m4a$/;
/** H.264 needs even sides; frames of a display with an odd size lose one pixel. */
const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

export interface ProxyResult {
    path: string;
    frames: number;
    audioPieces: number;
    displayId?: number;
}

/**
 * Makes `proxy.mp4` for a frames recording so the editor can open it: each kept frame of one display shown until the
 * next one (the recording's own timing), with the audio pieces placed at their start times and mixed. The frames and
 * the audio files stay; the proxy is only what the editor plays and cuts.
 */
export async function makeProxy(folder: string, { displayId }: { displayId?: number } = {}): Promise<ProxyResult> {
    const manifest = readRecordingManifest(folder);
    const frames = readFrameFolder(folder);

    if (frames.length === 0) {
        throw new Error(`${folder} has no frames to make a movie of`);
    }

    const display = displayId ?? frames[0].displayId;
    const chosen = display === undefined ? frames : frames.filter((frame) => frame.displayId === display);
    const list = join(folder, ".proxy-frames.txt");
    await writeFile(list, concatList(chosen.map((frame) => ({ path: frame.path, atUs: frame.atUs }))));
    const startedMs = manifest ? Date.parse(manifest.startedAt) : Number.NaN;
    const audioDir = join(folder, "audio");
    const pieces =
        existsSync(audioDir) && Number.isFinite(startedMs)
            ? readdirSync(audioDir)
                  .map((name) => ({ name, match: AUDIO_PIECE.exec(name) }))
                  .filter((piece) => piece.match !== null)
                  .map((piece) => ({
                      path: join(audioDir, piece.name),
                      delayMs: Math.max(0, Number(piece.match?.[1]) - startedMs),
                  }))
                  .sort((a, b) => a.delayMs - b.delayMs)
            : [];
    const output = join(folder, "proxy.mp4");
    const partial = join(folder, ".proxy.partial.mp4");
    const audioInputs = pieces.flatMap((piece) => ["-i", piece.path]);
    const audioGraph = pieces.length
        ? [
              "-filter_complex",
              `[0:v]${EVEN_SIZE}[vout];` +
                  `${pieces.map((piece, index) => `[${index + 1}:a]adelay=${Math.round(piece.delayMs)}:all=1[a${index}]`).join(";")};` +
                  `${pieces.map((_, index) => `[a${index}]`).join("")}amix=inputs=${pieces.length}:normalize=0[aout]`,
              "-map",
              "[vout]",
              "-map",
              "[aout]",
              "-c:a",
              "aac",
              "-b:a",
              "160k",
          ]
        : ["-vf", EVEN_SIZE];
    const argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        ...audioInputs,
        ...audioGraph,
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        partial,
    ];
    log.info({ folder, frames: chosen.length, display, audioPieces: pieces.length }, "making the proxy movie");

    try {
        await runVideoCommand({ command: argv, timeoutMs: 10 * 60_000 });
    } finally {
        await rm(list, { force: true });
    }

    await rename(partial, output);
    return { path: output, frames: chosen.length, audioPieces: pieces.length, displayId: display };
}
