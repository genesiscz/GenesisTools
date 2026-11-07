import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { recordingsLibraryDir } from "@genesiscz/utils/screen-recorder/library";
import { duplicateRecording, movedPaths } from "./duplicate";
import { listLibrary } from "./library";

const read = (path: string): Record<string, unknown> => SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

/** A recording folder with a movie, a cursor track, music inside the folder, an edit and an undo file. */
function fixture(root: string, name: string): string {
    const folder = join(root, name);
    mkdirSync(join(folder, "audio"), { recursive: true });
    writeFileSync(join(folder, "screen.mp4"), "not really a movie");
    writeFileSync(join(folder, "cursor.jsonl"), '{"t":0,"x":0.5,"y":0.5}\n');
    writeFileSync(join(folder, "audio", "bed.mp3"), "music");
    writeFileSync(
        join(folder, "recording.json"),
        SafeJSON.stringify({
            version: 1,
            id: name,
            title: "Demo",
            startedAt: "2026-11-07T10:00:00.000Z",
            displays: [],
            settings: { kind: "video" },
            frames: [],
            warnings: [],
        })
    );
    writeFileSync(
        join(folder, "edit.json"),
        SafeJSON.stringify({
            version: 1,
            source: {
                video: join(folder, "screen.mp4"),
                cursor: join(folder, "cursor.jsonl"),
                recording: name,
                durationUs: 10_000_000,
                width: 1920,
                height: 1080,
            },
            clips: [{ id: "c1", fromUs: 0, toUs: 10_000_000 }],
            audio: { include: true, volume: 1, mutedTracks: [], music: { file: join(folder, "audio", "bed.mp3") } },
            revision: 3,
        })
    );
    writeFileSync(join(folder, "edit.undo.json"), '{"steps":[]}');
    return folder;
}

describe("duplicateRecording", () => {
    test("moves only the paths inside the old folder", () => {
        expect(movedPaths({ a: "/old/x.mp4", b: ["/old", "/older/y"], c: 3 }, "/old", "/new")).toEqual({
            a: "/new/x.mp4",
            b: ["/new", "/older/y"],
            c: 3,
        });
    });

    test("a folder copy points every path into the copy, takes a new title and leaves the undo history", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-duplicate-"));
        const folder = fixture(root, "video-2026-11-07_10-00-00");
        const target = join(root, "after");
        const answer = await duplicateRecording(folder, { to: target });

        expect(answer).toEqual({ path: join(target, "edit.json"), folder: target, title: "Demo (copy)" });
        const edit = read(answer.path);
        expect(edit.source).toMatchObject({
            video: join(target, "screen.mp4"),
            cursor: join(target, "cursor.jsonl"),
            recording: "video-2026-11-07_10-00-00",
        });
        expect(edit.audio).toMatchObject({ music: { file: join(target, "audio", "bed.mp3") } });
        expect(read(join(target, "recording.json"))).toMatchObject({
            id: "video-2026-11-07_10-00-00",
            title: "Demo (copy)",
        });
        expect(existsSync(join(target, "edit.undo.json"))).toBe(false);
        expect(readFileSync(join(target, "audio", "bed.mp3"), "utf8")).toBe("music");
        // The original is untouched.
        expect(read(join(folder, "edit.json"))).toMatchObject({ source: { video: join(folder, "screen.mp4") } });
        await expect(duplicateRecording(folder, { to: target })).rejects.toThrow(/already exists/);
    });

    test("without --to the copy is a new library recording with its own id", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-duplicate-"));
        const folder = fixture(root, "video-2026-11-07_10-00-00");
        const answer = await duplicateRecording(folder, { title: "After", now: new Date(2026, 10, 7, 15, 30, 0) });

        const id = answer.id ?? "";
        expect(id).toMatch(/^video-2026-11-07_15-30-00-[0-9a-f]{8}$/);
        expect(answer.folder).toBe(recordingsLibraryDir(id));
        expect(read(join(answer.folder, "recording.json"))).toMatchObject({ id, title: "After" });
        expect(read(answer.path)).toMatchObject({ source: { recording: id } });
        expect(listLibrary().map((row) => row.id)).toContain(id);
    });

    test("a plain movie copies its edit and the files the edit names in its folder", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-duplicate-"));
        const movie = join(root, "talk.mp4");
        writeFileSync(movie, "not really a movie");
        writeFileSync(join(root, "bed.mp3"), "music");
        writeFileSync(
            join(root, "talk.edit.json"),
            SafeJSON.stringify({
                version: 1,
                source: { video: movie, durationUs: 5_000_000, width: 640, height: 360 },
                clips: [{ id: "c1", fromUs: 0, toUs: 5_000_000 }],
                audio: { include: true, volume: 1, mutedTracks: [], music: { file: join(root, "bed.mp3") } },
            })
        );
        const target = join(root, "copy");
        const answer = await duplicateRecording(join(root, "talk.edit.json"), { to: target });

        expect(answer.path).toBe(join(target, "talk.edit.json"));
        const edit = read(answer.path);
        expect(edit.source).toMatchObject({ video: join(target, "talk.mp4") });
        expect(edit.audio).toMatchObject({ music: { file: join(target, "bed.mp3") } });
        expect(existsSync(join(target, "bed.mp3"))).toBe(true);
    });
});
