import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConfigStore, meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { type MeetingRecord, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
import { createCanvas } from "@napi-rs/canvas";
import type { z } from "zod";
import { captureCost } from "./capture-cost";
import { configValueAt, parseConfigPath, setConfigValue, unsetConfigValue } from "./config-edit";
import { decideItems, reopenItems } from "./decide";
import { testPhrase } from "./dictionary-test";
import { exportMeeting } from "./export";
import { matchPreview } from "./match-preview";
import { meetingsOverview } from "./overview";
import { screenTimeline } from "./screen-timeline";

let n = 0;

function stores(): { config: MeetingsConfigStore; meetings: MeetingStore } {
    n += 1;
    return {
        config: new MeetingsConfigStore(new Storage(`meetings-ui-config-${process.pid}-${n}`)),
        meetings: new MeetingStore(new Storage(`meetings-ui-${process.pid}-${n}`)),
    };
}

type RecordInput = Partial<z.input<typeof meetingRecordSchema>> & { id: string; start: string };

function record(fields: RecordInput): MeetingRecord {
    return meetingRecordSchema.parse({
        title: "Weekly sync",
        createdAt: fields.start,
        createdBy: "new",
        ...fields,
    });
}

const suggestedAt = "2026-11-04T10:00:00.000Z";

describe("config set and unset", () => {
    test("creates the objects on the way, validates the whole config, and unset brings the default back", async () => {
        const { config } = stores();

        await setConfigValue(config, "global.capture.activeFps", 2);
        await setConfigValue(config, '["projects","side.quest","labels"]', ["Launch"]);
        let read = await config.read();
        expect(read.global.capture.activeFps).toBe(2);
        expect(read.projects["side.quest"]?.labels).toEqual(["Launch"]);
        expect(configValueAt(read, parseConfigPath('["projects","side.quest","labels"]'))).toEqual(["Launch"]);

        await expect(setConfigValue(config, "global.capture.threshold", 7)).rejects.toThrow("threshold");
        expect((await config.read()).global.capture.threshold).toBe(0.02);

        read = await unsetConfigValue(config, "global.capture.activeFps");
        expect(read.global.capture.activeFps).toBe(1);
    });

    test("a path through the prototype or with an empty key is refused", () => {
        expect(() => parseConfigPath("global.__proto__.x")).toThrow("__proto__");
        expect(() => parseConfigPath("global..capture")).toThrow("not a config path");
    });
});

describe("overview", () => {
    test("badges count what each meeting needs, and needsYou lists each reason once", () => {
        const config = meetingsConfigSchema.parse({ global: { suggest: { applyAbove: 0.6 } } });
        const now = new Date("2026-11-05T12:00:00.000Z");
        const records = [
            record({
                id: "a",
                start: "2026-11-05T08:00:00.000Z",
                end: "2026-11-05T09:00:00.000Z",
                sources: { wisprflow: { meetingId: "w1" } },
                items: [
                    {
                        kind: "speaker-range",
                        id: "i1",
                        status: "suggested",
                        label: "S1",
                        fromSec: 0,
                        toSec: 9,
                        confidence: 0.9,
                        suggestedAt,
                    },
                    { kind: "term", id: "i2", status: "suggested", heard: "x", confidence: 0.3, suggestedAt },
                    {
                        kind: "question",
                        id: "i3",
                        status: "suggested",
                        about: "speaker",
                        fromSec: 0,
                        toSec: 9,
                        question: "Who?",
                        suggestedAt,
                    },
                ],
            }),
            record({ id: "b", start: "2026-11-04T08:00:00.000Z", project: "work", recording: { frames: 3 } }),
            record({ id: "old", start: "2026-10-01T08:00:00.000Z" }),
        ];

        const view = meetingsOverview({ records, config, now, days: 14, timeZone: "UTC" });

        expect(view.meetings.map((meeting) => meeting.id)).toEqual(["a", "b"]);
        expect(view.meetings[0]).toMatchObject({ day: "2026-11-05", durationSec: 3600, hasTranscript: true });
        expect(view.meetings[0]?.badges).toEqual({
            noProject: true,
            openQuestions: 1,
            unclearSpeakers: 1,
            recordingOnly: false,
            transcriptOnly: true,
            suggestedAboveApply: 1,
            suggested: 2,
        });
        expect(view.meetings[1]?.badges).toMatchObject({ noProject: false, recordingOnly: true });
        expect(view.needsYou).toEqual({
            noProject: ["a"],
            questions: [{ id: "a", count: 1 }],
            suggestions: [{ id: "a", count: 1 }],
            total: 1,
        });
    });
});

describe("match preview", () => {
    test("a draft rule changes the projects a meeting matches before anything is saved", () => {
        const config = meetingsConfigSchema.parse({
            projects: { work: { labels: [], match: { title: { words: ["sync"] } } }, side: { labels: [] } },
        });
        const records = [
            record({ id: "a", start: "2026-11-05T08:00:00.000Z", title: "Weekly sync" }),
            record({ id: "b", start: "2026-11-04T08:00:00.000Z", title: "Side quest planning" }),
        ];

        const rows = matchPreview({ records, config, draft: { side: { titleWords: ["quest"] } }, limit: 20 });

        expect(rows.map((row) => [row.id, row.now, row.draft, row.changed])).toEqual([
            ["a", ["work"], ["work"], false],
            ["b", [], ["side"], true],
        ]);
    });
});

describe("dictionary test", () => {
    test("names each entry that changes the phrase, with the project's entries over the global ones", () => {
        const config = meetingsConfigSchema.parse({
            global: { dictionary: { entries: [{ type: "fix", value: "Viky", substitution: "wiki" }] } },
            projects: {
                work: {
                    labels: [],
                    dictionary: { entries: [{ type: "abbr", value: "MOP", substitution: "MOP (main order path)" }] },
                },
            },
        });

        const result = testPhrase(config, { phrase: "The MOP is on Viky", project: "work" });

        expect(result.text).toBe("The MOP (main order path) is on wiki");
        expect(result.fired.map((entry) => entry.value)).toEqual(["Viky", "MOP"]);
        expect(testPhrase(config, { phrase: "The MOP is on Viky" }).fired.map((entry) => entry.value)).toEqual([
            "Viky",
        ]);
    });
});

describe("screen timeline", () => {
    test("each frame keeps only the lines the same display did not show before", async () => {
        const { meetings } = stores();
        const created = await meetings.create(
            { title: "Demo", start: "2026-11-05T08:00:00.000Z", createdBy: "record" },
            { command: "test", change: "fixture" }
        );
        const folder = meetings.folder(created.id);
        mkdirSync(join(folder, "frames"), { recursive: true });
        const canvas = createCanvas(400, 200);
        canvas.getContext("2d").fillRect(0, 0, 400, 200);
        const block = (text: string, y: number) => ({
            text,
            confidence: 1,
            bounds: { x: 0.1, y, width: 0.5, height: 0.1 },
        });
        const rows = [
            {
                file: "frames/a-d1.png",
                at: "2026-11-05T08:00:10.000Z",
                displayId: 1,
                text: "Agenda\nItem one",
                blocks: [block("Agenda", 0.8), block("Item one", 0.6)],
            },
            {
                file: "frames/b-d1.png",
                at: "2026-11-05T08:00:20.000Z",
                displayId: 1,
                text: "Agenda\nItem two",
                blocks: [block("Agenda", 0.8), block("Item two", 0.4)],
            },
        ];

        for (const row of rows) {
            writeFileSync(join(folder, row.file), canvas.toBuffer("image/png"));
        }

        writeFileSync(join(folder, "ocr.jsonl"), `${rows.map((row) => SafeJSON.stringify(row)).join("\n")}\n`);

        const view = await screenTimeline({ store: meetings, record: created });

        expect(view.displays).toEqual([{ id: 1, frames: 2 }]);
        expect(view.frames.map((frame) => frame.changed.map((line) => line.text))).toEqual([
            ["Agenda", "Item one"],
            ["Item two"],
        ]);
        expect(view.frames[1]).toMatchObject({ meetingSec: 20, width: 400, height: 200, lineCount: 2 });
    });
});

describe("export", () => {
    test("writes the polished transcript to the project's folder and replaces it on the next export", async () => {
        const { meetings } = stores();
        const target = join(meetings.root, "notes");
        const created = await meetings.create(
            { title: "Planning", start: "2026-11-05T08:00:00.000Z", createdBy: "new", project: "work" },
            { command: "test", change: "fixture" }
        );
        const config = meetingsConfigSchema.parse({ projects: { work: { labels: [], export: { folder: target } } } });
        const transcript = [{ startSec: 5, speaker: "Alice", text: "We ship on Friday." }];

        await expect(
            exportMeeting({ store: meetings, record: { ...created, project: undefined }, config, transcript })
        ).rejects.toThrow("has no project");

        const dry = await exportMeeting({ store: meetings, record: created, config, transcript, dryRun: true });
        expect(dry).toMatchObject({ written: false, replaced: false });
        expect(existsSync(dry.path)).toBe(false);

        const first = await exportMeeting({ store: meetings, record: created, config, transcript });
        expect(first.path).toBe(join(target, `${created.id}.md`));
        expect(readFileSync(first.path, "utf8")).toContain("We ship on Friday.");

        const second = await exportMeeting({ store: meetings, record: created, config, transcript });
        expect(second).toMatchObject({ written: true, replaced: true });
    });
});

describe("capture cost", () => {
    test("the maximum scales with fps and displays; the observed rate comes from the newest real recording", () => {
        const { meetings } = stores();
        const config = meetingsConfigSchema.parse({});
        const records = [
            record({
                id: "rec",
                start: "2026-11-05T08:00:00.000Z",
                recording: {
                    frames: 30,
                    displays: [
                        { id: 1, name: "One", frames: 20 },
                        { id: 2, name: "Two", frames: 10 },
                    ],
                    spans: [{ from: "2026-11-05T08:00:00.000Z", to: "2026-11-05T08:10:00.000Z" }],
                },
            }),
        ];

        const cost = captureCost({ store: meetings, records, config });

        expect(cost.observed).toMatchObject({ meeting: "rec", displays: 2, minutes: 10, framesPerMin: 3 });
        expect(cost.displays.map((choice) => choice.maxCpuSecPerMin)).toEqual([32.2, 16.1, 16.1]);
        expect(cost.activeFps.map((choice) => choice.maxCpuSecPerMin)).toEqual([16.1, 32.2, 64.5]);
        expect(cost.thresholdNote).toContain("not measured");
    });
});

describe("reopen", () => {
    test("puts a confirmed or rejected item back to suggested, and leaves a question and an open item alone", async () => {
        const { meetings } = stores();
        const created = await meetings.create(
            {
                title: "Review",
                start: "2026-11-05T08:00:00.000Z",
                createdBy: "new",
                items: [
                    {
                        kind: "term",
                        id: "i1",
                        status: "suggested",
                        heard: "Viky",
                        proposed: "wiki",
                        rules: [],
                        suggestedAt,
                    },
                    {
                        kind: "term",
                        id: "i2",
                        status: "suggested",
                        heard: "MOO",
                        proposed: "MOP",
                        rules: [],
                        suggestedAt,
                    },
                    {
                        kind: "question",
                        id: "i3",
                        status: "confirmed",
                        about: "term",
                        fromSec: 1,
                        toSec: 2,
                        question: "Which word?",
                        choices: [],
                        decides: [],
                        rules: [],
                        suggestedAt,
                    },
                ],
            },
            { command: "test", change: "fixture" }
        );
        await decideItems({ store: meetings, record: created, status: "confirmed", ids: ["i1"] });
        await decideItems({ store: meetings, record: created, status: "rejected", ids: ["i2"] });

        const result = await reopenItems({ store: meetings, record: created, ids: ["i1", "i2", "i3"] });
        const saved = meetings.read(created.id);

        expect(result.reopened).toEqual(["i1", "i2"]);
        expect(result.skipped.map((skip) => skip.id)).toEqual(["i3"]);
        expect(saved?.items.map((item) => [item.id, item.status, item.decidedAt])).toEqual([
            ["i1", "suggested", undefined],
            ["i2", "suggested", undefined],
            ["i3", "confirmed", undefined],
        ]);
        expect((await reopenItems({ store: meetings, record: saved ?? created, ids: ["i1"] })).skipped).toEqual([
            { id: "i1", reason: "it is not decided" },
        ]);
    });
});
