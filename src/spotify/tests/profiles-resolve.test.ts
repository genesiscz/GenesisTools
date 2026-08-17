/**
 * `resolveHistoryDir` against the layouts a real Spotify export actually arrives in.
 *
 * The export is a zip whose top level holds the JSON files AND loose documents such as
 * `ReadMeFirst_ExtendedStreamingHistory.pdf`. People also point `profile add` at the folder
 * they unzipped into, one level above. Both have to work, and neither may surface a raw
 * system error.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHistoryDir } from "@app/spotify/lib/profiles";

const root = mkdtempSync(join(tmpdir(), "spotify-resolve-test-"));

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

/** An export folder: the audio JSON files, plus the loose files Spotify ships beside them. */
function makeExport(dir: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Streaming_History_Audio_2024_1.json"), "[]");
    writeFileSync(join(dir, "ReadMeFirst_ExtendedStreamingHistory.pdf"), "%PDF-1.4\n");

    return dir;
}

describe("resolveHistoryDir", () => {
    test("finds the audio files when pointed straight at the export folder", () => {
        const dir = makeExport(join(root, "direct"));
        expect(resolveHistoryDir(dir)).toBe(dir);
    });

    // The regression: every entry of the parent is probed, and probing the PDF with
    // `readdirSync` threw ENOTDIR before the entry was checked for being a directory.
    test("descends into a child export folder even when loose FILES sit beside it", () => {
        const parent = join(root, "parent");
        mkdirSync(parent, { recursive: true });
        writeFileSync(join(parent, "ReadMeFirst_ExtendedStreamingHistory.pdf"), "%PDF-1.4\n");
        writeFileSync(join(parent, "Read_Me_First.txt"), "hello");
        const child = makeExport(join(parent, "Spotify Extended Streaming History"));

        expect(resolveHistoryDir(parent)).toBe(child);
    });

    test("a folder with no audio files fails with the explanatory message, not ENOTDIR", () => {
        const empty = join(root, "empty");
        mkdirSync(empty, { recursive: true });
        writeFileSync(join(empty, "notes.pdf"), "%PDF-1.4\n");

        expect(() => resolveHistoryDir(empty)).toThrow("no Streaming_History_Audio_");
    });

    test("a missing directory names itself", () => {
        expect(() => resolveHistoryDir(join(root, "nope"))).toThrow("no such directory");
    });
});
