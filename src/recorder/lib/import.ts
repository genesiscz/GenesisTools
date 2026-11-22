import { constants } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { type TimeValue, timeSchema, timeToUs } from "@genesiscz/utils/recording-editor/plan";
import {
    newVideoRecordingId,
    type RecordingManifest,
    recordingsLibraryDir,
    writeRecordingManifest,
} from "@genesiscz/utils/screen-recorder/library";
import { trashRecordingFolder } from "@genesiscz/utils/screen-recorder/start";
import { shellWord } from "@genesiscz/utils/shell/quote";
import {
    audioStreamCount,
    type MediaFacts,
    NotMediaError,
    primaryVideo,
    readMediaFacts,
} from "@genesiscz/utils/video/media-facts";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { secondsToMicroseconds } from "@genesiscz/utils/video/sampling";
import { z } from "zod";
import { openProject } from "./edit";
import { markerLabelProblem } from "./library";

/**
 * A library recording made from a movie file that already exists (a render, an export, a movie from another app), the
 * way the recorder writes one: `video-<stamp>-<uuid>/` with the movie and a version 1 `recording.json`, so the editor,
 * `movies.open()` and every `tools recorder` command take it like a recording.
 */

const { log } = logger.scoped("recorder-import");

/** The name of the library's copy, by the extension of the file: the movies the editor (AVFoundation) plays. */
const IMPORT_MOVIE_NAMES: Readonly<Record<string, "screen.mp4" | "screen.mov">> = {
    ".mp4": "screen.mp4",
    ".m4v": "screen.mp4",
    ".mov": "screen.mov",
};

/**
 * The video codecs the editor (AVFoundation) plays, by ffprobe's name, measured with AVURLAsset isPlayable on an M4 Mac
 * with macOS 27 (2026-11-09). vp9, vp8, dnxhd, qtrle, png, cinepak, svq1 and msmpeg4v3 did not play. HEVC plays only
 * under the hvc1 tag: hev1, the tag ffmpeg's libx265 writes into an .mp4 by default, did not play either.
 */
const EDITOR_VIDEO_CODECS: ReadonlySet<string> = new Set([
    "h264",
    "hevc",
    "av1",
    "prores",
    "mpeg4",
    "mpeg2video",
    "mjpeg",
    "h263",
    "rawvideo",
    "v210",
]);

/**
 * The transfers of an HDR movie (high dynamic range: a wider range of brightness and colour, not more pixels), by the
 * names people know them by. The editor's probe refuses them, so the import makes an SDR copy of such a movie.
 */
const HDR_TRANSFERS: Readonly<Record<string, string>> = { smpte2084: "PQ", "arib-std-b67": "HLG" };

/** avconvert's preset of the SDR copy: a largest size (it never enlarges), H.264 in BT.709. */
const SDR_COPY_PRESET = "Preset3840x2160";

/** A moment of the movie: `at` is SOURCE time (seconds, "m:ss" or "h:mm:ss" of the file as it plays). */
export interface ImportMarker {
    at: TimeValue;
    label: string;
}

export interface ImportMovieOptions {
    /** The library's title (1 to 120 characters); default the file's name without its extension. */
    title?: string;
    /** Moments of the movie, in any order; each must be inside it. */
    markers?: readonly ImportMarker[];
    /** The clock of the id and the manifest's times; a test passes one. */
    now?: Date;
    /** Told once before a slow step (the SDR copy of an HDR movie), so a door can say why it waits. */
    onNote?: (text: string) => void;
}

export interface ImportedMovie {
    id: string;
    folder: string;
    title: string;
    /** The library's copy: an APFS clone where the disk can make one, else a whole copy; an HDR movie's SDR copy. */
    movie: string;
    /** The file it was copied from; nothing writes to it. */
    source: string;
    seconds: number;
    frames?: number;
    averageFps?: number;
    /** The movie's audio tracks; with one or more, the editor plays, exports and transcribes its sound. */
    audioTracks: number;
    /** The markers in time order, at source seconds (`movie.markers()` lists them the same way). */
    markers: Array<{ at: number; label: string }>;
    /** What the library's copy does not keep of the file (an HDR movie is an SDR copy); the manifest has the same. */
    warnings: string[];
}

const seconds = (us: number) => Math.round(us / 100_000) / 10;

/** `--marker 0:12=Login done`: the time (seconds or m:ss) before the first `=`, the label after it. */
export function parseImportMarker(raw: string): ImportMarker {
    const split = raw.indexOf("=");
    const at = timeSchema.safeParse(raw.slice(0, Math.max(0, split)).trim());

    if (split < 0 || !at.success) {
        throw new Error(`--marker takes <time>=<label>, e.g. 0:12=Login done or 42.5=Saved (got "${raw}")`);
    }

    return { at: at.data, label: raw.slice(split + 1) };
}

/** The markers as the manifest keeps them (ms of the movie, in order); a bad label or a time outside the movie throws. */
function manifestMarkers(markers: readonly ImportMarker[], durationUs: number): Array<{ atMs: number; label: string }> {
    return markers
        .map((marker) => {
            const problem = markerLabelProblem(marker.label);

            if (problem) {
                throw new RangeError(`${problem} (got "${marker.label}")`);
            }

            const label = marker.label.trim();
            const atUs = timeToUs(marker.at);

            if (atUs < 0) {
                throw new RangeError(`the marker "${label}" at ${seconds(atUs)} s is before the start of the movie`);
            }

            if (atUs > durationUs) {
                throw new RangeError(
                    `the marker "${label}" at ${seconds(atUs)} s is past the end of the movie (${seconds(durationUs)} s)`
                );
            }

            return { atMs: Math.round(atUs / 1000), label };
        })
        .sort((a, b) => a.atMs - b.atMs);
}

/** The title the library shows: the one given, else the file's name (cut to 120 characters). */
function importTitle(given: string | undefined, source: string): string {
    if (given === undefined) {
        return basename(source, extname(source)).trim().slice(0, 120) || "Imported movie";
    }

    const title = given.trim();

    if (!title || title.length > 120) {
        throw new RangeError("a title is 1 to 120 characters");
    }

    return title;
}

/** What ffprobe reads of the file, or why it is not a movie the editor can take. */
async function movieFacts(source: string): Promise<MediaFacts> {
    const file = await stat(source).catch((error: unknown) => {
        log.debug({ error, source }, "the movie to import does not stat");
        throw new Error(`No such file: ${source}`);
    });

    if (!file.isFile()) {
        throw new Error(`${source} is not a file; import takes one movie file`);
    }

    if (!IMPORT_MOVIE_NAMES[extname(source).toLowerCase()]) {
        throw new Error(
            `${basename(source)} is not a movie the editor plays: the editor plays .mp4, .m4v and .mov movies (convert it first, for example with ffmpeg -i in.mkv -c copy out.mp4)`
        );
    }

    const facts = await readMediaFacts({ input: source }).catch((error: unknown) => {
        if (error instanceof NotMediaError) {
            log.debug({ error, source }, "ffprobe does not read the movie to import");
            throw new Error(`${source} is not a movie: ${error.message}`);
        }

        throw error;
    });

    if (!primaryVideo(facts)) {
        throw new Error(`${source} is not a movie: it has no video stream`);
    }

    if (!facts.durationSec || facts.durationSec <= 0) {
        throw new Error(`${source} is not a movie that plays: it has no length`);
    }

    return facts;
}

const videoStreamSchema = z.object({
    streams: z
        .array(
            z.object({
                codec_name: z.string().optional(),
                codec_tag_string: z.string().optional(),
                color_transfer: z.string().optional(),
                pix_fmt: z.string().optional(),
                duration: z.string().optional(),
                side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
            })
        )
        .default([]),
    format: z.object({ duration: z.string().optional() }).optional(),
});

/** An ffmpeg line a person pastes to make `<name>-<suffix><ext>` beside the movie. */
function ffmpegHint(source: string, args: string, suffix: string): string {
    const copy = join(dirname(source), `${basename(source, extname(source))}-${suffix}${extname(source)}`);
    return `ffmpeg -i ${shellWord(source)} ${args} ${shellWord(copy)}`;
}

/**
 * The line a person runs to see why the import's SDR copy failed: the same `avconvert` call, beside the movie. The
 * preset is a largest size (it never enlarges), and its copy is H.264 in BT.709 (checked 2026-11-21 on an HLG movie
 * at 3840 x 2160 and at 1280 x 720, and 2026-11-22 on a PQ movie at 1280 x 720).
 */
function sdrCopyHint(source: string): string {
    const copy = join(dirname(source), `${basename(source, extname(source))}-sdr.mov`);
    return `avconvert --source ${shellWord(source)} --preset ${SDR_COPY_PRESET} --output ${shellWord(copy)}`;
}

/** ffprobe's read of the first video stream, the one the editor's probe reads, with the file's length. */
async function firstVideoStream(path: string): Promise<z.infer<typeof videoStreamSchema>> {
    const raw = await runVideoCommand({
        command: [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,codec_tag_string,color_transfer,pix_fmt,duration:stream_side_data=rotation:format=duration",
            "-of",
            "json",
            path,
        ],
        timeoutMs: 30_000,
    });
    return videoStreamSchema.parse(SafeJSON.parse(raw, { strict: true }));
}

/** The movie's video as the editor reads it: its length, and its HDR transfer (PQ or HLG) when it has one. */
interface EditorVideo {
    durationUs: number;
    hdr?: string;
}

/**
 * The movie's video as the editor reads it, or why the editor does not play the movie, in the import's words. It
 * reads the stream the editor's probe reads (the first video stream) by the same rules: its length first, the file's
 * when it has none, and a turn other than a quarter turn refused. The codec is the import's own check, because the
 * editor's probe does not look at it and AVFoundation then shows nothing. An HDR movie is not refused: the import
 * makes its SDR copy. Only an 8-bit movie that is tagged HDR is, because avconvert keeps such a movie as it is.
 */
async function editorVideo(source: string): Promise<EditorVideo> {
    const data = await firstVideoStream(source);
    const video = data.streams[0];

    if (!video) {
        throw new Error(`${source} is not a movie: it has no video stream`);
    }

    const codec = video.codec_name ?? "an unknown codec";
    log.debug(
        { source, codec, tag: video.codec_tag_string, transfer: video.color_transfer, pixels: video.pix_fmt },
        "the movie's video"
    );

    if (codec === "hevc" && video.codec_tag_string === "hev1") {
        throw new Error(
            `${source} is not a movie the editor plays: its video is HEVC tagged hev1, which the editor (AVFoundation) does not play. Put it under the hvc1 tag first (nothing is encoded again): ${ffmpegHint(source, "-c copy -tag:v hvc1", "hvc1")}`
        );
    }

    if (!EDITOR_VIDEO_CODECS.has(codec)) {
        throw new Error(
            `${source} is not a movie the editor plays: its video is ${codec}, which the editor (AVFoundation) does not play. Convert it first: ${ffmpegHint(source, "-c:v libx264 -pix_fmt yuv420p -c:a aac", "h264")}`
        );
    }

    const hdr = HDR_TRANSFERS[video.color_transfer ?? ""];

    // HDR video has 10 bits or more a sample (yuv420p10le, p010le, yuv422p12le): ffprobe names the depth last.
    if (hdr && !/1[0246](?:le|be)$/.test(video.pix_fmt ?? "")) {
        throw new Error(
            `${source} is tagged HDR (${hdr}), but its video is 8-bit (${video.pix_fmt ?? "an unknown pixel format"}), and avconvert, which makes the editor's SDR copy, keeps such a movie as it is. The editor takes SDR movies only: export an SDR copy from the app that made it`
        );
    }

    const rotation =
        (((video.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0) % 360) + 360) % 360;

    if (![0, 90, 180, 270].includes(rotation)) {
        throw new Error(
            `${source} is turned ${rotation}°; the editor takes a movie turned 0°, 90°, 180° or 270° only: export an upright copy first`
        );
    }

    const length = video.duration ?? data.format?.duration;
    const durationUs = length === undefined ? 0 : secondsToMicroseconds(length);

    if (durationUs <= 0) {
        throw new Error(`${source} is not a movie that plays: its video has no length`);
    }

    return { durationUs, ...(hdr ? { hdr } : {}) };
}

/**
 * Writes the SDR copy of an HDR movie to `movie` with `avconvert`, which comes with macOS and maps the tones (ffmpeg
 * needs its zscale filter for that, and Homebrew's ffmpeg has none). The copy is H.264 in BT.709 with the movie's
 * frame rate and length, and a turned movie comes out upright. Measured 2026-11-22 on an M4 Mac: 20 s of 3840 x 2160
 * HLG at 30 fps took 7.5 s. avconvert keeps one audio track, so the movie's audio tracks go back in by stream copy
 * when it has more, and it makes a movie over 3840 x 2160 smaller. Returns the copy's facts and what the copy does
 * not keep, as sentences for the manifest's warnings.
 */
async function writeSdrCopy({
    source,
    movie,
    hdr,
    facts,
}: {
    source: string;
    movie: string;
    hdr: string;
    facts: MediaFacts;
}): Promise<{ facts: MediaFacts; warnings: string[] }> {
    const lengthMs = Math.round((facts.durationSec ?? 0) * 1000);
    const command = ["avconvert", "--source", source, "--preset", SDR_COPY_PRESET, "--output", movie];
    log.debug({ command, lengthMs }, "the SDR copy of an HDR movie starts");
    // Six lengths of the movie and two minutes: the measured copy took about a third of the movie's length.
    const result = await boundedCommand({ command, timeoutMs: 120_000 + lengthMs * 6, maxBufferBytes: 1024 * 1024 });

    if (result.error || result.status !== 0) {
        // avconvert prints its reason first ("avconvert:  invalid source file …"), then its whole usage.
        const said = result.stderr
            .split("\n")
            .find((line) => line.startsWith("avconvert:"))
            ?.replace(/^avconvert:\s*/, "");
        log.warn(
            { source, status: result.status, error: result.error, stderr: result.stderr.slice(0, 2000) },
            "avconvert did not make the SDR copy"
        );
        throw new Error(
            `${source} is an HDR movie (${hdr}), and avconvert did not make its SDR copy: ${said || result.error?.message || `it ended with status ${result.status}`}. Run it by hand to see why: ${sdrCopyHint(source)}`,
            { cause: result.error }
        );
    }

    const kept = HDR_TRANSFERS[(await firstVideoStream(movie)).streams[0]?.color_transfer ?? ""];

    if (kept) {
        throw new Error(
            `${source} is an HDR movie (${hdr}), and avconvert kept its copy HDR (${kept}). The editor takes SDR movies only: export an SDR copy from the app that made it`
        );
    }

    const warnings = [
        `The movie is HDR (${hdr}): the library holds an SDR copy of it (H.264, BT.709) that avconvert made`,
    ];
    const tracks = audioStreamCount(facts);
    let copy = await readMediaFacts({ input: movie });

    if (audioStreamCount(copy) < tracks) {
        const withTracks = join(dirname(movie), `.audio-tracks-${basename(movie)}`);

        try {
            await runVideoCommand({
                command: [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    movie,
                    "-i",
                    source,
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a",
                    "-c",
                    "copy",
                    withTracks,
                ],
                timeoutMs: 120_000 + lengthMs,
            });
            await rename(withTracks, movie);
            copy = await readMediaFacts({ input: movie });
        } catch (error) {
            log.warn({ error, source, movie }, "the SDR copy does not take the movie's audio tracks");
            await rm(withTracks, { force: true });
            warnings.push(`The SDR copy keeps ${audioStreamCount(copy)} of the movie's ${tracks} audio tracks`);
        }
    }

    const before = primaryVideo(facts);
    const after = primaryVideo(copy);

    // By the long side: a turned movie comes out upright, so its width and height change places.
    if (
        before?.width &&
        before.height &&
        after?.width &&
        after.height &&
        Math.max(after.width, after.height) < Math.max(before.width, before.height)
    ) {
        warnings.push(
            `The SDR copy is ${after.width} x ${after.height}; the movie is ${before.width} x ${before.height} (avconvert makes no copy over 3840 x 2160)`
        );
    }

    log.debug({ source, movie, warnings }, "the SDR copy of an HDR movie is made");
    return { facts: copy, warnings };
}

const packetsSchema = z.object({ streams: z.array(z.object({ nb_read_packets: z.string().optional() })).default([]) });

/** The frames of the movie's video stream (ffprobe counts its packets: it reads the file, it decodes nothing). */
async function videoFrameCount(movie: string): Promise<number | undefined> {
    try {
        const raw = await runVideoCommand({
            command: [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_packets",
                "-show_entries",
                "stream=nb_read_packets",
                "-of",
                "json",
                movie,
            ],
            timeoutMs: 120_000,
        });
        const count = Number(packetsSchema.parse(SafeJSON.parse(raw, { strict: true })).streams[0]?.nb_read_packets);
        return Number.isInteger(count) && count > 0 ? count : undefined;
    } catch (error) {
        log.debug({ error, movie }, "the frames of the imported movie are not counted; the manifest leaves them out");
        return undefined;
    }
}

/** A folder an import made and then gave up on goes to the GenesisTools trash, so the library holds no half of one. */
function dropFolder(folder: string): void {
    try {
        const trashed = trashRecordingFolder(folder, "recording-import-failed");
        log.info({ folder, trashed }, "the failed import's folder goes to the trash");
    } catch (error) {
        log.warn({ error, folder }, "the failed import's folder stays where it is");
    }
}

/**
 * Imports a movie into the recordings library as a new recording. The file stays as it is: the library gets an APFS
 * clone where the disk can make one (no extra disk until one side changes), else a whole copy. An HDR movie (PQ or
 * HLG) gets an SDR copy instead (`writeSdrCopy`), because the editor takes SDR movies only; the manifest's warnings
 * say so. The file is read first as the editor reads it (its video codec, its turn, its video's length for the
 * markers), so a refusal copies nothing; then the editor's own probe of the copy (its size and length limits) decides
 * that it plays before the folder becomes a recording. The markers are movie time
 * (`settings.markerClock` "movie"). A movie with sound keeps it: the manifest names the movie as its sound source, so
 * the editor plays, exports and transcribes it like a recording with system audio in its movie.
 */
export async function importMovie(input: string, options: ImportMovieOptions = {}): Promise<ImportedMovie> {
    const source = resolve(input);
    const facts = await movieFacts(source);
    const title = importTitle(options.title, source);
    // A marker the movie's video does not reach is refused before anything is copied, and again below against the
    // editor's own length, the one the manifest keeps, so the two can never disagree.
    const video = await editorVideo(source);

    // Before anything is made, as every refusal: without avconvert there is no SDR copy to make.
    if (video.hdr && Bun.which("avconvert") === null) {
        throw new Error(
            `${source} is an HDR movie (${video.hdr}); the editor takes SDR movies only, and this machine has no avconvert (it comes with macOS) to make the SDR copy: export an SDR copy first`
        );
    }

    manifestMarkers(options.markers ?? [], video.durationUs);
    const now = options.now ?? new Date();
    const id = newVideoRecordingId(now);
    const folder = recordingsLibraryDir(id);
    // avconvert writes a QuickTime movie, so an HDR movie's SDR copy is screen.mov whatever the file's extension.
    const name = video.hdr ? "screen.mov" : (IMPORT_MOVIE_NAMES[extname(source).toLowerCase()] ?? "screen.mp4");
    const movie = join(folder, name);
    await mkdir(folder, { recursive: true, mode: 0o700 });

    try {
        let copied: { facts: MediaFacts; warnings: string[] } = { facts, warnings: [] };

        if (video.hdr) {
            options.onNote?.(
                `${basename(source)} is an HDR movie (${video.hdr}): the import makes an SDR copy of it for the editor with avconvert, and a long movie takes a while`
            );
            copied = await writeSdrCopy({ source, movie, hdr: video.hdr, facts });
        } else {
            await copyFile(source, movie, constants.COPYFILE_FICLONE);
        }

        const durationUs = await openProject(movie)
            .then((opened) => opened.project.source.durationUs)
            .catch((error: unknown) => {
                throw new Error(
                    `${source} does not open in the editor: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            });
        const markers = manifestMarkers(options.markers ?? [], durationUs);
        const frames = await videoFrameCount(movie);
        const durationMs = Math.round(durationUs / 1000);
        const averageFps = frames && durationMs > 0 ? Math.round((frames / (durationMs / 1000)) * 10) / 10 : undefined;
        const rate = primaryVideo(facts)?.frameRate ?? averageFps;
        const audioTracks = audioStreamCount(copied.facts);
        const manifest: RecordingManifest = {
            version: 1,
            id,
            title,
            startedAt: now.toISOString(),
            // The wall span equals the movie here; movies.list() reads durationMs first and this span only without it.
            endedAt: new Date(now.getTime() + durationMs).toISOString(),
            displays: [],
            settings: {
                kind: "video",
                ...(rate === undefined ? {} : { fps: Math.round(rate) }),
                // A recording that names no source was recorded without sound, and its transcript is refused.
                audio: { sources: audioTracks > 0 ? ["movie"] : [] },
                // No cursor track: the editor draws no pointer and no keys overlay, as for a window movie.
                cursor: "none",
                shortcuts: false,
                video: {
                    file: name,
                    durationMs,
                    ...(frames === undefined ? {} : { frames }),
                    ...(averageFps === undefined ? {} : { averageFps }),
                },
                outcome: "done",
                markers,
                markerClock: "movie",
                importedFrom: source,
            },
            frames: [],
            warnings: copied.warnings,
        };
        await writeRecordingManifest(folder, manifest);
        log.debug({ id, folder, source, durationMs, frames, audioTracks, markers: markers.length }, "movie imported");
        return {
            id,
            folder,
            title,
            movie,
            source,
            seconds: Math.round(durationMs) / 1000,
            ...(frames === undefined ? {} : { frames }),
            ...(averageFps === undefined ? {} : { averageFps }),
            audioTracks,
            markers: markers.map((marker) => ({ at: marker.atMs / 1000, label: marker.label })),
            warnings: copied.warnings,
        };
    } catch (error) {
        log.debug({ error, source, folder }, "the movie import failed");
        dropFolder(folder);
        throw error;
    }
}
