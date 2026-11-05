import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CopyFile } from "@genesiscz/utils/fs/clone";
import { SafeJSON } from "@genesiscz/utils/json";
import { meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { noteFramesDir, screenNoteMarkdown, writeScreenNote } from "./screen-note";

const root = mkdtempSync(join(tmpdir(), "gt-test-screen-note-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const record = meetingRecordSchema.parse({
    id: "2026-03-02_10-00-meeting",
    title: "Weekly sync",
    start: "2026-03-02T10:00:00.000Z",
    createdBy: "record",
    createdAt: "2026-03-02T10:00:00.000Z",
    updatedAt: "2026-03-02T10:00:00.000Z",
    recording: { displays: [{ id: 2, name: "Side", frames: 3 }] },
});
const ZERO_MS = Date.parse("2026-03-02T10:00:00.000Z");

/** A meeting folder with four frame rows: the third repeats the second's text, the fourth's picture is gone. */
function meetingFolder(name: string): string {
    const folder = join(root, name, "meeting");
    mkdirSync(join(folder, "frames"), { recursive: true });
    const rows = [
        { file: "frames/10-00-05-000-d2.jpg", at: "2026-03-02T10:00:05.000Z", displayId: 2, text: "Board\nSprint 4" },
        { file: "frames/10-01-00-000-d2.jpg", at: "2026-03-02T10:01:00.000Z", displayId: 2, text: "Code ```ts```" },
        { file: "frames/10-01-30-000-d2.jpg", at: "2026-03-02T10:01:30.000Z", displayId: 2, text: "Code ```ts```" },
        { file: "frames/10-02-00-000-d2.jpg", at: "2026-03-02T10:02:00.000Z", displayId: 2, text: "" },
    ];

    for (const row of rows.slice(0, 3)) {
        writeFileSync(join(folder, row.file), `jpeg of ${row.file}`);
    }

    writeFileSync(join(folder, "ocr.jsonl"), `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);
    return folder;
}

/** The picture links of a note, as the viewer reads them: percent-decoded, relative to the note. */
function pictureLinks(notePath: string): string[] {
    return [...readFileSync(notePath, "utf8").matchAll(/!\[\]\(([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]));
}

describe("the screen note of a meeting", () => {
    it("keeps raw meeting IDs and the final blank line when no frames are shown", () => {
        const result = screenNoteMarkdown({
            record: { ...record, id: "yes" },
            rows: [],
            zeroMs: ZERO_MS,
            links: new Map(),
            ocrPath: "ocr.jsonl",
            picturesLabel: "frames/",
        });

        expect(result.markdown).toBe(
            "---\nmeeting: yes\n---\n\n# Screen OCR: Weekly sync\n\n" +
                "Source: `ocr.jsonl` (0 frames; 0 shown here, a frame whose text did not change on its display is left out). Pictures: `frames/`. Times are local time and the transcript time.\n\n"
        );
    });

    it("preserves every byte of a note with a missing picture and backticks", () => {
        const zero = new Date(2026, 2, 2, 10, 0, 0).getTime();
        const rows = [
            { file: "frames/one.jpg", at: new Date(zero + 5000).toISOString(), displayId: 2, text: "Code ```x```" },
            { file: "frames/missing.jpg", at: new Date(zero + 60000).toISOString(), displayId: 2, text: "Other" },
        ];
        const result = screenNoteMarkdown({
            record,
            rows,
            zeroMs: zero,
            links: new Map([["frames/one.jpg", "images/one.jpg"]]),
            ocrPath: "meeting/ocr.jsonl",
            picturesLabel: "images/",
        });

        expect(result).toEqual({
            shown: 2,
            markdown:
                "---\nmeeting: 2026-03-02_10-00-meeting\n---\n\n# Screen OCR: Weekly sync\n\n" +
                "Source: `meeting/ocr.jsonl` (2 frames; 2 shown here, a frame whose text did not change on its display is left out). Pictures: `images/`. Times are local time and the transcript time.\n\n" +
                "## 10:00:05 · transcript 00:05 · Side\n\n![](images/one.jpg)\n\n````text\nCode ```x```\n````\n\n" +
                "## 10:01:00 · transcript 01:00 · Side\n\n_The picture frames/missing.jpg is not on disk._\n\n```text\nOther\n```\n",
        });
    });

    it("clones each shown frame beside the note and links the clone by a relative path", () => {
        const folder = meetingFolder("vault-note");
        const notePath = join(root, "vault-note", "vault", "Meetings", "Weekly sync.ScreenOCR.md");
        const result = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });

        expect(result.frames).toBe(4);
        expect(result.shown).toBe(3);
        expect(result.missing).toEqual(["frames/10-02-00-000-d2.jpg"]);
        // APFS (macOS) clones; a volume that cannot (ext4 on a Linux runner) gets copies.
        expect(result.cloned + result.copied).toBe(2);

        if (process.platform === "darwin") {
            expect(result.cloned).toBe(2);
        }

        const links = pictureLinks(notePath);
        expect(links).toEqual([
            "Weekly sync.ScreenOCR.frames/10-00-05-000-d2.jpg",
            "Weekly sync.ScreenOCR.frames/10-01-00-000-d2.jpg",
        ]);

        for (const link of links) {
            const placed = join(dirname(notePath), link);
            expect(readFileSync(placed, "utf8")).toBe(`jpeg of frames/${link.split("/").pop()}`);
        }

        const note = readFileSync(notePath, "utf8");
        expect(note).toContain("![](Weekly%20sync.ScreenOCR.frames/10-00-05-000-d2.jpg)");
        expect(note).toContain("_The picture frames/10-02-00-000-d2.jpg is not on disk._");
        expect(note).toContain("````text\nCode ```ts```\n````");
        expect(note).toContain("· transcript 01:00 · Side");
        expect(note).toContain("4 frames; 3 shown here");
    });

    it("adds nothing on a second run", () => {
        const folder = meetingFolder("rerun");
        const notePath = join(root, "rerun", "notes", "sync.md");
        writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });
        const first = readFileSync(notePath, "utf8");
        const again = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });

        expect(again.cloned + again.copied).toBe(0);
        expect(again.kept).toBe(2);
        expect(readFileSync(notePath, "utf8")).toBe(first);
    });

    it("copies a frame the volume cannot clone, and says so in the result", () => {
        const folder = meetingFolder("no-clone");
        const notePath = join(root, "no-clone", "notes", "sync.md");
        const calls: number[] = [];
        const noClone: CopyFile = (_source, _destination, mode) => {
            calls.push(mode);
            throw Object.assign(new Error("clone not supported"), { code: "ENOTSUP" });
        };
        const result = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS, copyFile: noClone });

        expect(calls.length).toBe(2);
        expect(result.cloned).toBe(0);
        expect(result.copied).toBe(2);
        expect(readFileSync(join(noteFramesDir(notePath), "10-00-05-000-d2.jpg"), "utf8")).toBe(
            "jpeg of frames/10-00-05-000-d2.jpg"
        );
    });

    it("links a frame already under the note's folder where it is", () => {
        const folder = meetingFolder("in-folder");
        const notePath = join(folder, "screen.md");
        const result = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });

        expect(result.cloned + result.copied).toBe(0);
        expect(existsSync(noteFramesDir(notePath))).toBe(false);
        expect(pictureLinks(notePath)).toEqual(["frames/10-00-05-000-d2.jpg", "frames/10-01-00-000-d2.jpg"]);
    });

    it("never overwrites a note that is not this meeting's screen note", () => {
        const folder = meetingFolder("foreign");
        const notePath = join(root, "foreign", "notes", "plan.md");
        mkdirSync(dirname(notePath), { recursive: true });
        writeFileSync(notePath, "# My plan\n");

        expect(() => writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS })).toThrow(
            "is not the screen note of 2026-03-02_10-00-meeting"
        );
        expect(readFileSync(notePath, "utf8")).toBe("# My plan\n");
        expect(existsSync(noteFramesDir(notePath))).toBe(false);
    });
});
it("keeps placed picture links after recording retention removes the originals", () => {
    const folder = meetingFolder("retained-note");
    const notePath = join(root, "retained-note", "vault", "note.md");
    writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });
    const before = pictureLinks(notePath);
    for (const name of ["10-00-05-000-d2.jpg", "10-01-00-000-d2.jpg", "10-01-30-000-d2.jpg"]) {
        unlinkSync(join(folder, "frames", name));
    }
    const rerun = writeScreenNote({ record, meetingFolder: folder, notePath, zeroMs: ZERO_MS });
    expect(pictureLinks(notePath)).toEqual(before);
    expect(rerun.missing).toEqual(["frames/10-02-00-000-d2.jpg"]);
    for (const link of before) {
        expect(existsSync(join(dirname(notePath), link))).toBe(true);
    }
});
