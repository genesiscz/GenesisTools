import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { writePidFile } from "@genesiscz/utils/process/pidfile";
import { readFrameFolder } from "@genesiscz/utils/recording-editor/source";
import type { RecorderSettings } from "@genesiscz/utils/screen-recorder/control";
import type { OcrRow } from "@genesiscz/utils/screen-recorder/frame-output";
import { readRecordingManifest } from "@genesiscz/utils/screen-recorder/library";
import { Storage } from "@genesiscz/utils/storage/storage";
import { appendFrameIndex, ocrBacklog, readFrameIndex } from "./frame-index";
import { ensureOcrWorkers, OCR_FAILURES_BEFORE_RESTART, OCR_PID_FILE, runOcrWorker } from "./ocr-worker";
import { meetingMovieZeroMs, writeMeetingRecordingManifest } from "./recording-manifest";

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

    it("puts the record's markers into settings.markers on the frames' axis, also when an earlier run's frame is time 0", () => {
        const markers = [
            { at: "2026-03-02T09:00:03.250Z", label: "intro" },
            { at: "2026-03-02T09:10:00.000Z", label: "second start" },
        ];
        const marked = { ...record, recording: { ...record.recording, markers } } as MeetingRecord;
        // A later start: the movie still begins at the first frame of the first run.
        const restarted = {
            ...marked,
            recording: { ...marked.recording, startedAt: "2026-03-02T09:09:00.000Z" },
        } as MeetingRecord;

        expect(writeMeetingRecordingManifest(folder, marked)?.settings.markers).toEqual([
            { atMs: 3250, label: "intro" },
            { atMs: 600_000, label: "second start" },
        ]);
        expect(meetingMovieZeroMs(folder, "2026-03-02T09:00:00.000Z")).toBe(Date.parse("2026-03-02T09:00:00.000Z"));
        expect(writeMeetingRecordingManifest(folder, restarted)?.settings.markers).toEqual([
            { atMs: 1750, label: "intro" },
            { atMs: 598_500, label: "second start" },
        ]);
        expect(meetingMovieZeroMs(folder, "2026-03-02T09:09:00.000Z")).toBe(Date.parse("2026-03-02T09:00:01.500Z"));
        expect(writeMeetingRecordingManifest(folder, record)?.settings).toEqual({
            source: "meeting",
            meetingId: record.id,
        });
    });
});

describe("a meeting's ocr.jsonl after an interrupted run", () => {
    it("skips a cut-off row and a non-object row, and dates that frame by its file", () => {
        const cut = mkdtempSync(join(tmpdir(), "gt-test-meeting-manifest-cut-"));

        try {
            mkdirSync(join(cut, "frames"));
            writeFileSync(join(cut, "frames", "10-00-01-500-d2.jpg"), "x");
            writeFileSync(join(cut, "frames", "10-00-05-000-d2.jpg"), "x");
            const fileAt = new Date("2026-03-02T09:00:07.000Z");
            utimesSync(join(cut, "frames", "10-00-05-000-d2.jpg"), fileAt, fileAt);
            writeFileSync(
                join(cut, "ocr.jsonl"),
                [
                    SafeJSON.stringify({
                        file: "frames/10-00-01-500-d2.jpg",
                        at: "2026-03-02T09:00:01.500Z",
                        displayId: 2,
                    }),
                    "null",
                    '{"file":"frames/10-00-05-000-d2.jpg","at":"2026-03-02T09:00:0',
                ].join("\n")
            );

            expect(meetingMovieZeroMs(cut, "2026-03-02T09:00:00.000Z")).toBe(Date.parse("2026-03-02T09:00:00.000Z"));
            writeMeetingRecordingManifest(cut, record);
            expect(readRecordingManifest(cut)?.frames.map((frame) => [frame.file, frame.atMs])).toEqual([
                ["frames/10-00-01-500-d2.jpg", 1500],
                ["frames/10-00-05-000-d2.jpg", 7000],
            ]);
        } finally {
            rmSync(cut, { recursive: true, force: true });
        }
    });
});

describe("the frame index and the OCR worker (two phases)", () => {
    const settings: RecorderSettings["ocr"] = {
        enabled: true,
        languages: ["en-US"],
        minChars: 0,
        threshold: 5,
        skipTextless: false,
        region: "frame",
        read: "frame",
        tilePx: 960,
    };
    let stores = 0;

    /** A meeting with `frames` kept on disk and listed in its index; `ocr` rows already written, if any. */
    async function meetingWith(frames: Array<{ name: string; at: string; changePercent?: number; reason?: string }>) {
        stores += 1;
        const store = new MeetingStore(new Storage(`meetings-ocr-worker-${process.pid}-${stores}`));
        const created = await store.create(
            { title: "OCR fixture", start: "2026-11-11T14:00:00.000Z", createdBy: "record" },
            { command: "test", change: "fixture" }
        );
        const dir = store.folder(created.id);
        mkdirSync(join(dir, "frames"), { recursive: true });
        const add = (frame: (typeof frames)[number]) => {
            writeFileSync(join(dir, "frames", frame.name), "jpeg");
            appendFrameIndex(dir, {
                file: `frames/${frame.name}`,
                at: new Date(frame.at),
                displayId: 1,
                changePercent: frame.changePercent ?? 40,
                reason: frame.reason ?? "change",
                motionBoxes: [],
            });
        };

        for (const frame of frames) {
            add(frame);
        }

        return { store, id: created.id, dir, add };
    }

    /** A recognizer that throws `failures(path, call)` times for a frame, then reads its name back as the text. */
    function fakeEngine(fails: (file: string, attempt: number) => boolean) {
        const attempts = new Map<string, number>();
        const engine = {
            reads: [] as string[],
            restarts: 0,
            recognize: async (image: string) => {
                const name = image.split("/").at(-1) ?? image;
                const attempt = (attempts.get(name) ?? 0) + 1;
                attempts.set(name, attempt);
                engine.reads.push(name);

                if (fails(name, attempt)) {
                    throw new Error("TextRecognition.CRImageReaderError error 1");
                }

                return { text: `text of ${name}`, blocks: [] };
            },
            restart: () => {
                engine.restarts += 1;
            },
        };
        return engine;
    }

    function rows(dir: string): OcrRow[] {
        return readFileSync(join(dir, "ocr.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => SafeJSON.parse(line, { strict: true }));
    }

    it("derives the index of a meeting from before frames.jsonl from ocr.jsonl, and prefers the index line", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-test-frame-index-"));

        try {
            writeFileSync(
                join(dir, "ocr.jsonl"),
                `${[
                    { file: "frames/b-d2.jpg", at: "2026-03-02T09:00:05.000Z", text: "old" },
                    { file: "frames/a-d1.jpg", at: "2026-03-02T09:00:01.000Z", displayId: 1, changePercent: 3 },
                ]
                    .map((row) => SafeJSON.stringify(row))
                    .join("\n")}\n`
            );
            expect(readFrameIndex(dir).map((row) => [row.file, row.displayId, row.changePercent])).toEqual([
                ["frames/a-d1.jpg", 1, 3],
                ["frames/b-d2.jpg", 2, 0],
            ]);

            appendFrameIndex(dir, {
                file: "frames/c-d1.jpg",
                at: new Date("2026-03-02T09:00:03.000Z"),
                displayId: 1,
                changePercent: 9,
                reason: "change",
                motionBoxes: [[1, 2, 3, 4]],
            });
            expect(readFrameIndex(dir).map((row) => row.file)).toEqual([
                "frames/a-d1.jpg",
                "frames/c-d1.jpg",
                "frames/b-d2.jpg",
            ]);
            expect(ocrBacklog(dir).map((row) => row.file)).toEqual(["frames/c-d1.jpg"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("dates a frame that has no OCR row yet by its index line in the manifest", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:02.000Z" }]);
        const zero = Date.parse("2026-11-11T14:00:00.000Z");
        writeMeetingRecordingManifest(meeting.dir, {
            ...record,
            recording: { startedAt: "2026-11-11T14:00:00.000Z" },
        } as unknown as MeetingRecord);

        expect(existsSync(join(meeting.dir, "ocr.jsonl"))).toBe(false);
        expect(readRecordingManifest(meeting.dir)?.frames.map((frame) => [frame.file, frame.atMs])).toEqual([
            ["frames/f1-d1.jpg", Date.parse("2026-11-11T14:00:02.000Z") - zero],
        ]);
    });

    it("retries a read that throws, then starts a fresh helper, then writes a failed row that --retry-failed reads again in place", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
        ]);
        // f1 fails twice (no restart), f2 fails on the old and on the fresh helper.
        const stuck = fakeEngine((name, attempt) => (name === "f1-d1.jpg" && attempt <= 2) || name === "f2-d1.jpg");
        const first = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: stuck });

        expect(first).toMatchObject({ status: "done", read: 3, failed: 1, restarts: 1 });
        expect(stuck.restarts).toBe(1);
        expect(stuck.reads.filter((name) => name === "f2-d1.jpg")).toHaveLength(2 * OCR_FAILURES_BEFORE_RESTART);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.failed])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined],
            ["frames/f2-d1.jpg", "", "TextRecognition.CRImageReaderError error 1"],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined],
        ]);
        expect(existsSync(join(meeting.dir, OCR_PID_FILE))).toBe(false);

        const working = fakeEngine(() => false);
        const retried = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: working,
            retryFailed: true,
        });

        expect(retried).toMatchObject({ read: 0, reread: 1, failed: 0 });
        expect(working.reads).toEqual(["f2-d1.jpg"]);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.failed])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined],
            ["frames/f2-d1.jpg", "text of f2-d1.jpg", undefined],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined],
        ]);
    });

    it("goes on where ocr.jsonl ends, with the last row as the display's previous read", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine: fakeEngine(() => false) });
        // Below the OCR threshold: the frame keeps the previous text, which only the written row can give.
        meeting.add({ name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z", changePercent: 1 });
        meeting.add({ name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" });
        const engine = fakeEngine(() => false);
        const resumed = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });

        expect(resumed.read).toBe(2);
        expect(engine.reads).toEqual(["f3-d1.jpg"]);
        expect(rows(meeting.dir).map((row) => [row.file, row.text, row.skipped])).toEqual([
            ["frames/f1-d1.jpg", "text of f1-d1.jpg", undefined],
            ["frames/f2-d1.jpg", "text of f1-d1.jpg", "below-threshold"],
            ["frames/f3-d1.jpg", "text of f3-d1.jpg", undefined],
        ]);
    });

    it("--reread-empty-since reads the empty rows from that time again and leaves the earlier ones", async () => {
        const meeting = await meetingWith([
            { name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" },
            { name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" },
            { name: "f3-d1.jpg", at: "2026-11-11T14:00:03.000Z" },
        ]);
        writeFileSync(
            join(meeting.dir, "ocr.jsonl"),
            `${["f1-d1.jpg", "f2-d1.jpg", "f3-d1.jpg"]
                .map((name, i) =>
                    SafeJSON.stringify({
                        file: `frames/${name}`,
                        at: `2026-11-11T14:00:0${i + 1}.000Z`,
                        displayId: 1,
                        changePercent: 40,
                        reason: "change",
                        text: "",
                        blocks: [],
                    })
                )
                .join("\n")}\n`
        );
        const engine = fakeEngine(() => false);
        const result = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine,
            rereadEmptySince: new Date("2026-11-11T14:00:02.000Z"),
        });

        expect(result).toMatchObject({ read: 0, reread: 2 });
        expect(rows(meeting.dir).map((row) => row.text)).toEqual(["", "text of f2-d1.jpg", "text of f3-d1.jpg"]);
    });

    it("leaves a meeting a live worker holds alone", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        writePidFile(join(meeting.dir, OCR_PID_FILE));

        try {
            const engine = fakeEngine(() => false);
            const result = await runOcrWorker({ store: meeting.store, meetingId: meeting.id, settings, engine });

            expect(result).toMatchObject({ status: "busy", holder: process.pid, read: 0 });
            expect(engine.reads).toEqual([]);
        } finally {
            rmSync(join(meeting.dir, OCR_PID_FILE), { force: true });
        }
    });

    it("--follow reads frames as the recorder lists them and ends once the recorder stopped and the backlog is read", async () => {
        const meeting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        let checks = 0;
        const result = await runOcrWorker({
            store: meeting.store,
            meetingId: meeting.id,
            settings,
            engine: fakeEngine(() => false),
            follow: true,
            pollMs: 100,
            recording: () => {
                checks += 1;

                if (checks === 2) {
                    // The recorder keeps a last frame and stops before the worker looks again.
                    meeting.add({ name: "f2-d1.jpg", at: "2026-11-11T14:00:02.000Z" });
                    return false;
                }

                return checks < 2;
            },
        });

        expect(result.read).toBe(2);
        expect(rows(meeting.dir).map((row) => row.file)).toEqual(["frames/f1-d1.jpg", "frames/f2-d1.jpg"]);
    });

    it("ensureOcrWorkers starts a worker only for a recent meeting with frames that have no OCR row", async () => {
        const waiting = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        const read = await meetingWith([{ name: "f1-d1.jpg", at: "2026-11-11T14:00:01.000Z" }]);
        await runOcrWorker({ store: read.store, meetingId: read.id, settings, engine: fakeEngine(() => false) });
        const now = new Date("2026-11-11T15:00:00.000Z");
        const startedWaiting: string[] = [];
        const startedRead: string[] = [];

        await ensureOcrWorkers(waiting.store, { now, start: (id) => startedWaiting.push(id) });
        await ensureOcrWorkers(read.store, { now, start: (id) => startedRead.push(id) });
        await ensureOcrWorkers(waiting.store, {
            now: new Date("2026-11-20T15:00:00.000Z"),
            start: (id) => startedWaiting.push(`late ${id}`),
        });

        expect(startedWaiting).toEqual([waiting.id]);
        expect(startedRead).toEqual([]);
    });
});
