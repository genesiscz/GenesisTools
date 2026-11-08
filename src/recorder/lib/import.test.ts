import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as cli from "@genesiscz/utils/cli";
import type { ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { readRecordingManifest, recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { hasAudio, readMediaFacts } from "@genesiscz/utils/video/media-facts";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { openProject } from "./edit";
import { parseImportMarker } from "./import";
import { listLibrary } from "./library";
import { markersOf } from "./moments";
import { MoviesToolset } from "./toolset";

const hasFfmpeg = Bun.which("ffmpeg") !== null;
const ctx: ToolsetContext = { scratchDir: tmpdir(), show: async () => {}, write: () => {} };

interface ImportedMovie {
    recording: string;
    info(): Promise<{ title: string | null; folder: string | null; sourceSeconds: number }>;
    transcript(): Promise<unknown>;
}

interface Movies {
    import(path: string, options?: unknown): Promise<ImportedMovie>;
    list(options?: { limit?: number }): Array<{ id: string; title: string; folder: string; movie?: string }>;
}

async function moviesToolset(): Promise<Movies> {
    const loaded = (await new MoviesToolset().load(ctx)) as { movies: Movies };
    return loaded.movies;
}

interface MovieShape {
    sound: boolean;
    /** The video tagged PQ (HDR10). */
    hdr?: boolean;
    /** The sound runs 1 s past the 2 s video (no -shortest): the file lasts 3 s, its video 2 s. */
    longerSound?: boolean;
    /** ffmpeg's video encoder arguments; default H.264 4:2:0. */
    video?: string[];
}

/** A 2 s, 10 fps movie; with sound it has a 440 Hz AAC track, with hdr its video is tagged PQ (HDR10). */
async function makeMovie(
    path: string,
    { sound, hdr = false, longerSound = false, video }: MovieShape
): Promise<string> {
    const audio = sound ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${longerSound ? 3 : 2}`] : [];
    const audioCodec = sound ? ["-c:a", "aac", ...(longerSound ? [] : ["-shortest"])] : [];
    // x264 writes the transfer into the stream only through its own params (ffmpeg's -color_trc is dropped).
    const color = hdr ? ["-x264-params", "transfer=smpte2084:colorprim=bt2020:colormatrix=bt2020nc"] : [];
    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=10:duration=2",
            ...audio,
            ...(video ?? ["-c:v", "libx264", "-pix_fmt", "yuv420p", ...color]),
            ...audioCodec,
            path,
        ],
    });
    return path;
}

/** A copy of `movie` (no re-encode) whose display matrix turns it by `degrees`. */
async function turnedCopy(movie: string, path: string, degrees: number): Promise<string> {
    await runVideoCommand({
        command: [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-display_rotation",
            String(degrees),
            "-i",
            movie,
            "-c",
            "copy",
            path,
        ],
    });
    return path;
}

function fingerprint(path: string): { bytes: string; mtimeMs: number; size: number } {
    const stat = statSync(path);
    return {
        bytes: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

describe.skipIf(!hasFfmpeg)("movies.import", () => {
    let scratch: string;
    let withSound: string;
    let silent: string;
    let hdr: string;
    let longerSound: string;
    let vp9: string;
    let hev1: string;
    let turned: string;
    const folders = () => (existsSync(recordingsLibraryDir()) ? readdirSync(recordingsLibraryDir()).length : 0);

    beforeAll(async () => {
        scratch = mkdtempSync(join(tmpdir(), "gt-recorder-import-"));
        withSound = await makeMovie(join(scratch, "Product tour.mp4"), { sound: true });
        silent = await makeMovie(join(scratch, "silent.mov"), { sound: false });
        hdr = await makeMovie(join(scratch, "hdr.mp4"), { sound: false, hdr: true });
        longerSound = await makeMovie(join(scratch, "longer sound.mp4"), { sound: true, longerSound: true });
        vp9 = await makeMovie(join(scratch, "vp9.mp4"), { sound: false, video: ["-c:v", "libvpx-vp9"] });
        hev1 = await makeMovie(join(scratch, "hev1.mp4"), {
            sound: false,
            video: ["-c:v", "libx265", "-tag:v", "hev1", "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"],
        });
        turned = await turnedCopy(silent, join(scratch, "turned.mov"), 45);
    });

    afterAll(async () => {
        const { rm } = await import("node:fs/promises");
        await rm(scratch, { recursive: true, force: true });
    });

    test("makes a library recording the readers, the marker list and the sound checks all accept", async () => {
        const movies = await moviesToolset();
        const before = fingerprint(withSound);
        const movie = await movies.import(withSound, {
            title: "Imported tour",
            markers: [
                { at: "0:01.5", label: "Second half" },
                { at: 0.5, label: "Opening" },
            ],
        });
        const folder = movie.recording;

        expect(basename(folder)).toMatch(
            /^video-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(folder).toBe(recordingsLibraryDir(basename(folder)));
        expect(movies.list().find((row) => row.folder === folder)).toMatchObject({
            id: basename(folder),
            title: "Imported tour",
            movie: join(folder, "screen.mp4"),
        });

        const manifest = readRecordingManifest(folder);
        expect(manifest).toMatchObject({ version: 1, id: basename(folder), title: "Imported tour" });
        expect(manifest?.settings).toMatchObject({
            kind: "video",
            outcome: "done",
            markerClock: "movie",
            cursor: "none",
            shortcuts: false,
            video: { file: "screen.mp4", frames: 20 },
        });
        expect(manifest?.endedAt).toBeString();

        expect(markersOf(await openProject(folder))).toEqual([
            { at: 0.5, plays: 0.5, label: "Opening" },
            { at: 1.5, plays: 1.5, label: "Second half" },
        ]);
        expect(await movie.info()).toMatchObject({ title: "Imported tour", folder });

        // The movie keeps its sound: the copy has its audio track, and transcript() goes on to the paid run.
        expect(hasAudio(await readMediaFacts({ input: join(folder, "screen.mp4") }))).toBe(true);
        const run = spyOn(cli, "execTool").mockImplementation(async (args: readonly string[]) => {
            throw new Error(`execTool reached: ${args.join(" ")}`);
        });

        try {
            await expect(movie.transcript()).rejects.toThrow("execTool reached: transcribe");
        } finally {
            run.mockRestore();
        }

        expect(fingerprint(withSound)).toEqual(before);
    });

    test("a movie without sound stays silent and takes its file's name as the title", async () => {
        const movies = await moviesToolset();
        const movie = await movies.import(silent);
        const folder = movie.recording;

        expect(readRecordingManifest(folder)).toMatchObject({ title: "silent", settings: { audio: { sources: [] } } });
        expect(join(folder, "screen.mov")).toBe(listLibrary().find((row) => row.folder === folder)?.movie ?? "");
        await expect(movie.transcript()).rejects.toThrow("was recorded without sound");
    });

    test("refuses a file that is not a movie and a marker outside the movie, and makes no folder", async () => {
        const movies = await moviesToolset();
        const notes = join(scratch, "notes.txt");
        const fake = join(scratch, "fake.mp4");
        writeFileSync(notes, "not a movie");
        writeFileSync(fake, "not a movie either");
        const before = folders();

        await expect(movies.import(notes)).rejects.toThrow("the editor plays .mp4, .m4v and .mov movies");
        await expect(movies.import(fake)).rejects.toThrow("is not a movie");
        await expect(movies.import(join(scratch, "missing.mp4"))).rejects.toThrow("No such file");
        await expect(movies.import(withSound, { markers: [{ at: 2.5, label: "After the end" }] })).rejects.toThrow(
            'the marker "After the end" at 2.5 s is past the end of the movie (2 s)'
        );
        expect(folders()).toBe(before);
    });

    test("a marker after the video's end is refused when the sound runs on past it", async () => {
        const movies = await moviesToolset();
        const before = folders();
        // A refusal after the copy sends its folder to the GenesisTools trash, whose drainer is a detached process.
        const drainer = spyOn(cli, "spawnToolDetached").mockImplementation(() => 0);

        try {
            // The file lasts 3 s, but the editor plays its 2 s of video: 2.5 s is no moment of the movie it shows.
            await expect(movies.import(longerSound, { markers: [{ at: 2.5, label: "Sound only" }] })).rejects.toThrow(
                'the marker "Sound only" at 2.5 s is past the end of the movie (2 s)'
            );
        } finally {
            drainer.mockRestore();
        }

        expect(folders()).toBe(before);
    });

    test("refuses a movie the editor does not play in the import's words, before it copies anything", async () => {
        const movies = await moviesToolset();
        const before = folders();
        const drainer = spyOn(cli, "spawnToolDetached").mockImplementation(() => 0);
        const refusal = (path: string) =>
            movies.import(path).then(
                (movie) => `imported as ${movie.recording}`,
                (error: unknown) => (error instanceof Error ? error.message : String(error))
            );

        try {
            const coded = await refusal(vp9);
            expect(coded).toContain("its video is vp9, which the editor (AVFoundation) does not play");
            expect(coded).toContain("-c:v libx264 -pix_fmt yuv420p -c:a aac");
            const tagged = await refusal(hev1);
            expect(tagged).toContain("its video is HEVC tagged hev1, which the editor (AVFoundation) does not play");
            expect(tagged).toContain("-c copy -tag:v hvc1");
            expect(await refusal(hdr)).toContain("is an HDR movie (PQ); the editor takes SDR movies only");
            expect(await refusal(turned)).toContain(
                "is turned 45°; the editor takes a movie turned 0°, 90°, 180° or 270° only"
            );
            // Nothing was made, so nothing went to the trash either.
            expect(drainer).not.toHaveBeenCalled();
        } finally {
            drainer.mockRestore();
        }

        expect(folders()).toBe(before);
    });
});

describe("parseImportMarker", () => {
    test("reads <time>=<label>, the label may hold an =, and refuses anything else", () => {
        expect(parseImportMarker("0:12=Login done")).toEqual({ at: "0:12", label: "Login done" });
        expect(parseImportMarker("42.5=a=b")).toEqual({ at: "42.5", label: "a=b" });

        for (const raw of ["Login done", "=Login", "soon=Login"]) {
            expect(() => parseImportMarker(raw)).toThrow("--marker takes <time>=<label>");
        }
    });
});
