import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    analysisCachePath,
    cachedAnalysis,
    movieContentKey,
    readAnalysis,
} from "@genesiscz/utils/recording-editor/analysis-cache";
import { wholeProject } from "@genesiscz/utils/recording-editor/project";
import { releaseLock, tryAcquireLock } from "@genesiscz/utils/storage/file-lock";
import { runVideoCommand } from "@genesiscz/utils/video/process";
import { z } from "zod";
import { changeStepsOf } from "./fx-analysis";

const made: string[] = [];

/** A scratch folder removed after each test: a run writes about 60 MB of fake movies. */
function tempFolder(prefix: string): string {
    const folder = mkdtempSync(join(tmpdir(), prefix));
    made.push(folder);
    return folder;
}

afterEach(() => {
    for (const folder of made.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

/** A fake movie: bytes that differ per seed, big enough that the start, middle and end slices all differ. */
function fakeMovie(folder: string, name: string, seed: number, size = 9 * 1024 * 1024): string {
    const bytes = Buffer.alloc(size);

    for (let index = 0; index < size; index += 4096) {
        bytes[index] = (index / 4096 + seed) % 251;
    }

    const path = join(folder, name);
    writeFileSync(path, bytes);
    return path;
}

const numbers = z.array(z.number());

// R8 8: three editors on three copies of one demo each read its screen text again (caches were keyed by the path),
// and Vision queued for an hour.
describe("one analysis per movie content, shared by its copies", () => {
    test("a byte copy has the movie's content key; a changed byte or size does not", () => {
        const folder = tempFolder("gt-analysis-key-");
        const movie = fakeMovie(folder, "a.mp4", 1);
        const copy = join(folder, "copy.mp4");
        copyFileSync(movie, copy);
        const other = fakeMovie(folder, "b.mp4", 2);
        const longer = fakeMovie(folder, "c.mp4", 1, 9 * 1024 * 1024 + 1);

        expect(movieContentKey(copy)).toBe(movieContentKey(movie));
        expect(movieContentKey(other)).not.toBe(movieContentKey(movie));
        expect(movieContentKey(longer)).not.toBe(movieContentKey(movie));
        expect(analysisCachePath(copy, "motion")).toBe(analysisCachePath(movie, "motion"));
    });

    test("the copy reads the first movie's analysis, nothing is computed twice", async () => {
        const folder = tempFolder("gt-analysis-copy-");
        const movie = fakeMovie(folder, "a.mp4", 3);
        const copy = join(folder, "copy.mp4");
        copyFileSync(movie, copy);
        let computed = 0;
        const compute = async () => {
            computed++;
            return [1, 2, 3];
        };

        expect(await cachedAnalysis({ video: movie, name: "steps", key: "v1", schema: numbers, compute })).toEqual([
            1, 2, 3,
        ]);
        expect(await cachedAnalysis({ video: copy, name: "steps", key: "v1", schema: numbers, compute })).toEqual([
            1, 2, 3,
        ]);
        expect(computed).toBe(1);
        // Another way of reading it is another answer.
        await cachedAnalysis({ video: copy, name: "steps", key: "v2", schema: numbers, compute });
        expect(computed).toBe(2);
    });

    test("two calls at once compute once; an incremental cache is extended, not replaced", async () => {
        const folder = tempFolder("gt-analysis-once-");
        const movie = fakeMovie(folder, "a.mp4", 4);
        let computed = 0;
        const compute = async (cached: number[] | undefined) => {
            computed++;
            await Bun.sleep(20);
            return [...(cached ?? []), 7];
        };
        const request = { video: movie, name: "dense", key: "v1", schema: numbers, compute };
        const [first, second] = await Promise.all([cachedAnalysis(request), cachedAnalysis(request)]);

        expect(first).toEqual([7]);
        expect(second).toEqual([7]);
        expect(computed).toBe(1);
        const extended = await cachedAnalysis({ ...request, complete: (cached) => cached.includes(8) });
        expect(extended).toEqual([7, 7]);
    });

    test("a caller that finds another process's lock waits and reads its answer", async () => {
        const folder = tempFolder("gt-analysis-lock-");
        const movie = fakeMovie(folder, "a.mp4", 5);
        const path = analysisCachePath(movie, "screen-text");
        expect(await tryAcquireLock(`${path}.lock`)).toBe(true);
        let computed = 0;
        const waiting = cachedAnalysis({
            video: movie,
            name: "screen-text",
            key: "v1",
            schema: numbers,
            retryMs: 100,
            compute: async () => {
                computed++;
                return [0];
            },
        });
        await Bun.sleep(250);
        writeFileSync(path, SafeJSON.stringify({ key: "v1", data: [4, 2] }));
        await releaseLock(`${path}.lock`);

        expect(await waiting).toEqual([4, 2]);
        expect(computed).toBe(0);
    });

    test("an old cache beside the movie is read without a write, and the first cached call moves it over", async () => {
        const folder = tempFolder("gt-analysis-legacy-");
        const movie = fakeMovie(folder, "a.mp4", 6);
        const legacyPath = join(folder, "a.waits.json");
        writeFileSync(legacyPath, SafeJSON.stringify({ key: "old-key", data: [9] }));
        const request = {
            video: movie,
            name: "waits",
            key: "v3",
            schema: numbers,
            legacy: { path: legacyPath, key: "old-key" },
        };

        expect(readAnalysis(request)).toEqual([9]);
        expect(existsSync(analysisCachePath(movie, "waits"))).toBe(false);
        const compute = async (): Promise<number[]> => {
            throw new Error("the old cache answers; nothing is computed");
        };
        expect(await cachedAnalysis({ ...request, compute })).toEqual([9]);
        expect(readAnalysis({ video: movie, name: "waits", key: "v3", schema: numbers })).toEqual([9]);
    });
});

const hasFfmpeg = Boolean(Bun.which("ffmpeg"));

describe.skipIf(!hasFfmpeg)("changeStepsOf on a copy of a movie", () => {
    test("reads the change steps the first copy measured, and writes nothing beside the copy", async () => {
        const folder = tempFolder("gt-analysis-steps-");
        const movie = join(folder, "first.mp4");
        await runVideoCommand({
            command: [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=96x64:r=10:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                movie,
            ],
        });
        const copyFolder = tempFolder("gt-analysis-steps-copy-");
        const copy = join(copyFolder, "second.mp4");
        copyFileSync(movie, copy);
        const size = { durationUs: 1_000_000, width: 96, height: 64 };

        const measured = await changeStepsOf(wholeProject({ video: movie, ...size }));
        expect(measured.steps.length).toBeGreaterThan(0);
        // Mark the shared answer: a copy that measures again would not return the mark.
        const shared = analysisCachePath(copy, "waits");
        expect(existsSync(shared)).toBe(true);
        const marked = SafeJSON.parse(readFileSync(shared, "utf8"), { strict: true });
        writeFileSync(shared, SafeJSON.stringify({ ...marked, data: { ...marked.data, fps: 999 } }));

        const again = await changeStepsOf(wholeProject({ video: copy, ...size }));
        expect(again.fps).toBe(999);
        expect(existsSync(join(copyFolder, "second.waits.json"))).toBe(false);
    });
});
