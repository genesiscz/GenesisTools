import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { writeMeetingRecordingManifest } from "./recording-manifest";

const folder = mkdtempSync(join(tmpdir(), "gt-test-meeting-manifest-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const record = {
    id: "2026-03-02_10-00-meeting",
    title: "Weekly sync",
    recording: {
        startedAt: "2026-03-02T09:00:00.000Z",
        stoppedAt: "2026-03-02T09:30:00.000Z",
        displays: [{ id: 2, name: "Side", frames: 2 }],
    },
} as unknown as MeetingRecord;

describe("a meeting's screen recording as a recorder recording", () => {
    it("gives nothing for a meeting without frames", () => {
        expect(writeMeetingRecordingManifest(folder, record)).toBeUndefined();
    });

    it("lists every frame at its time from ocr.jsonl, in order, for the editor's frame reader", () => {
        mkdirSync(join(folder, "frames"));
        writeFileSync(join(folder, "frames", "10-00-05-000-d2.jpg"), "x");
        writeFileSync(join(folder, "frames", "10-00-01-500-d2.jpg"), "x");
        writeFileSync(
            join(folder, "ocr.jsonl"),
            [
                {
                    file: "frames/10-00-05-000-d2.jpg",
                    at: "2026-03-02T09:00:05.000Z",
                    displayId: 2,
                    changePercent: 12.5,
                    reason: "change",
                    text: "b",
                },
                { file: "frames/10-00-01-500-d2.jpg", at: "2026-03-02T09:00:01.500Z", displayId: 2, text: "a" },
            ]
                .map((row) => SafeJSON.stringify(row))
                .join("\n")
        );

        writeMeetingRecordingManifest(folder, record);
        const manifest = readRecordingManifest(folder);

        expect(manifest?.title).toBe("Weekly sync");
        expect(manifest?.frames.map((frame) => [frame.file, frame.atMs, frame.displayId])).toEqual([
            ["frames/10-00-01-500-d2.jpg", 1500, 2],
            ["frames/10-00-05-000-d2.jpg", 5000, 2],
        ]);
        expect(readFrameFolder(folder).map((frame) => frame.atUs)).toEqual([1_500_000, 5_000_000]);
        // A row the recorder wrote with its change percent keeps it; an older row without one reads 0.
        expect(manifest?.frames.map((frame) => [frame.changePercent, frame.reason])).toEqual([
            [0, "change"],
            [12.5, "change"],
        ]);
    });
});
