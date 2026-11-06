import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { MeetingsConfigStore, meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import { readCorrections } from "@genesiscz/utils/meetings/corrections";
import { type MeetingRecord, MeetingStore, meetingRecordSchema } from "@genesiscz/utils/meetings/record";
import { Storage } from "@genesiscz/utils/storage/storage";
import { createCanvas } from "@napi-rs/canvas";
import type { z } from "zod";
import { captureCost } from "./capture-cost";
import {
    applyConfigEdits,
    configValueAt,
    missingMapKey,
    parseConfigEdits,
    parseConfigPath,
    setConfigValue,
    unknownConfigPath,
    unsetConfigValue,
} from "./config-edit";
import { decideItems, reopenItems } from "./decide";
import { testPhrase } from "./dictionary-test";
import { exportMeeting } from "./export";
import { matchPreview } from "./match-preview";
import { meetingsOverview } from "./overview";
import { removeProject, renameProject } from "./project-admin";
import { screenTimeline } from "./screen-timeline";
import { openMeetingsWindow, windowOpenArgs } from "./window";
import { revisionsRead } from "./window-reads";

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
    test("show names the projects the config holds when a path names one it does not (R2-MC6)", () => {
        const config = meetingsConfigSchema.parse({ projects: { work: {} } });

        expect(missingMapKey(config, parseConfigPath("projects.side"))).toEqual({
            reason: 'projects has no "side"; it holds work.',
            settings: "tools meetings config show projects",
        });
        expect(missingMapKey(config, parseConfigPath("projects.work.labels"))).toBeUndefined();
        expect(missingMapKey(config, parseConfigPath("global.capture.activeFps"))).toBeUndefined();
    });

    test("edits that are not JSON get the shape the command takes, with the parser's reason (R2-MC6)", () => {
        expect(parseConfigEdits("not json")).toEqual({
            error: 'config edit takes a JSON array of { path, value, expect? } or { path, unset: true, expect? } (expect: the value the change replaces); this text is not JSON: JSON Parse error: Unexpected identifier "not"',
        });
        expect(parseConfigEdits('[{"path":"global.language","value":"cs"}]')).toEqual({
            edits: [{ path: "global.language", value: "cs" }],
        });
    });

    test("a misspelled key is refused with the closest setting, and an unset may still remove it (MC6)", async () => {
        const { config } = stores();

        await expect(setConfigValue(config, "global.capture.activFps", 5)).rejects.toThrow(
            'global.capture has no setting "activFps"; did you mean "activeFps"? Nothing was written.'
        );
        expect(unknownConfigPath(parseConfigPath("global.capture.activeFps"))).toBeUndefined();
        expect(unknownConfigPath(parseConfigPath('["projects","a.b","labels"]'))).toBeUndefined();
        expect(unknownConfigPath(parseConfigPath("languages.de.ocr"))).toBeUndefined();
        expect(unknownConfigPath(parseConfigPath("global.nosuch"))?.reason).toBe('global has no setting "nosuch".');
        await expect(unsetConfigValue(config, "global.capture.activFps")).resolves.toBeDefined();
    });

    test("a write that names the value it replaces is refused when another editor changed it first", async () => {
        const { config } = stores();
        const path = '["languages","cs","ocr"]';
        // Another editor added German after this page read Czech and English.
        await setConfigValue(config, path, ["cs-CZ", "en-US", "de-DE"]);

        await expect(setConfigValue(config, path, ["cs-CZ"], { expect: ["cs-CZ", "en-US"] })).rejects.toMatchObject({
            code: "config-stale",
        });
        await expect(unsetConfigValue(config, path, { expect: ["cs-CZ", "en-US"] })).rejects.toMatchObject({
            code: "config-stale",
        });
        await expect(
            applyConfigEdits(config, [
                { path: "global.capture.activeFps", value: 2, expect: 1 },
                { path, value: ["cs-CZ"], expect: ["cs-CZ", "en-US"] },
            ])
        ).rejects.toMatchObject({ code: "config-stale" });
        let read = await config.read();
        expect(read.languages.cs.ocr).toEqual(["cs-CZ", "en-US", "de-DE"]);
        expect(read.global.capture.activeFps).toBe(1);

        read = await applyConfigEdits(config, [
            { path: "global.capture.activeFps", value: 2, expect: 1 },
            { path, value: ["cs-CZ"], expect: ["cs-CZ", "en-US", "de-DE"] },
        ]);
        expect(read.languages.cs.ocr).toEqual(["cs-CZ"]);
        expect(read.global.capture.activeFps).toBe(2);

        // A key nobody set yet expects null; the expectation reads the value with its default.
        await setConfigValue(config, '["projects","work","export"]', { folder: "/notes" }, { expect: null });
        read = await unsetConfigValue(config, "global.capture.activeFps", { expect: 2 });
        expect(read.global.capture.activeFps).toBe(1);
    });

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
        expect(view.olderMeetings).toBe(1);
        expect(meetingsOverview({ records: [], config, now, days: 14 }).olderMeetings).toBe(0);
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

describe("window revisions", () => {
    test("a token changes only when what its part reads changed", async () => {
        const { meetings } = stores();
        const created = await meetings.create(
            { title: "Demo", start: "2026-11-05T08:00:00.000Z", createdBy: "record" },
            { command: "test", change: "fixture" }
        );
        const folder = meetings.folder(created.id);
        const first = await revisionsRead({ store: meetings, record: created });

        expect(await revisionsRead({ store: meetings, record: created })).toEqual(first);
        // No source: the transcript read only says so, which the record alone decides, so the token is known.
        expect(first.transcript).not.toBeNull();

        mkdirSync(join(folder, "frames"), { recursive: true });
        writeFileSync(join(folder, "ocr.jsonl"), "{}\n");
        const framed = await revisionsRead({ store: meetings, record: created });

        expect(framed.timeline).not.toBe(first.timeline);
        expect({ ...framed, timeline: first.timeline }).toEqual(first);

        writeFileSync(join(folder, "frames", "a-d1.png"), "x");
        const added = await revisionsRead({ store: meetings, record: created });

        expect(added.timeline).not.toBe(framed.timeline);

        const updated = await meetings.update(created.id, { command: "test", change: "label" }, (record) => {
            record.labels = ["demo"];
        });
        const changed = await revisionsRead({ store: meetings, record: updated });

        expect(changed.show).not.toBe(added.show);
        expect(changed.transcript).not.toBe(added.transcript);
        expect(changed.speakers).not.toBe(added.speakers);
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
        expect(second).toMatchObject({ written: true, replaced: true, action: "replace" });
    });

    async function exported(project: string, ifEdited?: "beside" | "refuse" | "replace") {
        const { meetings } = stores();
        const target = join(meetings.root, "notes");
        const created = await meetings.create(
            { title: "Harbor review", start: "2026-11-05T09:00:00.000Z", createdBy: "new", project },
            { command: "test", change: "fixture" }
        );
        const config = meetingsConfigSchema.parse({
            ...(ifEdited ? { global: { export: { ifEdited } } } : {}),
            projects: { [project]: { labels: [], export: { folder: target } } },
        });
        const transcript = [{ startSec: 5, speaker: "Alice", text: "Northwind signs on Monday." }];
        return { meetings, target, created, config, transcript };
    }

    test("an export never writes through a symlink in the folder, so a note outside the folder stays", async () => {
        const { meetings, target, created, config, transcript } = await exported("work");
        const outside = join(meetings.root, "outside.md");
        writeFileSync(outside, "OUTSIDE NOTE");
        mkdirSync(target, { recursive: true });
        symlinkSync(outside, join(target, `${created.id}.md`));

        await expect(exportMeeting({ store: meetings, record: created, config, transcript })).rejects.toMatchObject({
            code: "export-unsafe-path",
        });
        expect(readFileSync(outside, "utf8")).toBe("OUTSIDE NOTE");
        expect(lstatSync(join(target, `${created.id}.md`)).isSymbolicLink()).toBe(true);
    });

    test("an edited note survives the next export: the new one goes beside it, or the export refuses", async () => {
        const { meetings, created, config, transcript } = await exported("work");
        const first = await exportMeeting({ store: meetings, record: created, config, transcript });
        writeFileSync(first.path, `${readFileSync(first.path, "utf8")}\nMANUAL EDIT MUST SURVIVE\n`);

        const second = await exportMeeting({ store: meetings, record: created, config, transcript });
        expect(readFileSync(first.path, "utf8")).toContain("MANUAL EDIT MUST SURVIVE");
        expect(second).toMatchObject({ written: true, replaced: false, action: "beside", kept: first.path });
        expect(second.path).not.toBe(first.path);
        expect(readFileSync(second.path, "utf8")).toContain("Northwind signs on Monday.");

        await expect(
            exportMeeting({ store: meetings, record: created, config, transcript, ifEdited: "refuse" })
        ).rejects.toMatchObject({ code: "export-edited" });
        expect(readFileSync(first.path, "utf8")).toContain("MANUAL EDIT MUST SURVIVE");

        const forced = await exportMeeting({
            store: meetings,
            record: created,
            config,
            transcript,
            ifEdited: "replace",
        });
        expect(forced).toMatchObject({ path: first.path, replaced: true, action: "replace" });
        expect(readFileSync(first.path, "utf8")).not.toContain("MANUAL EDIT MUST SURVIVE");

        // The replaced note is the export's own again, so the next export replaces it without asking.
        const again = await exportMeeting({ store: meetings, record: created, config, transcript, ifEdited: "refuse" });
        expect(again).toMatchObject({ path: first.path, action: "replace" });
    });

    test("the config decides what an export does with an edited note", async () => {
        const { meetings, created, config, transcript } = await exported("work", "refuse");
        const first = await exportMeeting({ store: meetings, record: created, config, transcript });
        writeFileSync(first.path, "MANUAL EDIT");

        const dry = await exportMeeting({ store: meetings, record: created, config, transcript, dryRun: true });
        expect(dry).toMatchObject({ written: false, action: "refuse" });
        await expect(exportMeeting({ store: meetings, record: created, config, transcript })).rejects.toMatchObject({
            code: "export-edited",
        });
        expect(readFileSync(first.path, "utf8")).toBe("MANUAL EDIT");
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

describe("undo of a decision", () => {
    async function meetingWith(items: MeetingRecord["items"]) {
        const { meetings } = stores();
        const created = await meetings.create(
            { title: "Harbor sync", start: "2026-11-05T08:00:00.000Z", createdBy: "new", items },
            { command: "test", change: "fixture" }
        );
        return { meetings, created };
    }

    test("confirming a confirmed item again changes nothing, so the first Undo still works (MC16)", async () => {
        const { meetings, created } = await meetingWith([
            { kind: "term", id: "i1", status: "suggested", heard: "Viky", proposed: "wiki", rules: [], suggestedAt },
        ]);
        const first = await decideItems({ store: meetings, record: created, status: "confirmed", ids: ["i1"] });
        const again = await decideItems({ store: meetings, record: created, status: "confirmed", ids: ["i1"] });

        expect(again).toEqual({
            decided: [],
            skipped: [{ id: "i1", reason: "it is confirmed already", needs: "nothing" }],
        });
        expect(
            (await reopenItems({ store: meetings, record: created, ids: ["i1"], token: first.token })).reopened
        ).toEqual(["i1"]);
    });

    test("an Undo names its decision, and is refused once another decision changed the item", async () => {
        const { meetings, created } = await meetingWith([
            { kind: "term", id: "i1", status: "suggested", heard: "Viky", proposed: "wiki", rules: [], suggestedAt },
        ]);
        const confirmed = await decideItems({ store: meetings, record: created, status: "confirmed", ids: ["i1"] });
        expect(typeof confirmed.token).toBe("string");
        // Another terminal rejects the item before the window's Undo is pressed.
        const rejected = await decideItems({ store: meetings, record: created, status: "rejected", ids: ["i1"] });

        await expect(
            reopenItems({ store: meetings, record: created, ids: ["i1"], token: confirmed.token })
        ).rejects.toMatchObject({ code: "item-changed" });
        expect(meetings.read(created.id)?.items[0]?.status).toBe("rejected");

        // The newer decision's own Undo is not stale.
        expect(
            (await reopenItems({ store: meetings, record: created, ids: ["i1"], token: rejected.token })).reopened
        ).toEqual(["i1"]);
    });
});

describe("undo puts back what the decision changed", () => {
    test("the speaker a confirm gave, the state before a reject, and a withdrawn ledger line", async () => {
        const { meetings } = stores();
        const created = await meetings.create(
            {
                title: "Northwind review",
                start: "2026-11-05T10:00:00.000Z",
                createdBy: "new",
                items: [
                    {
                        kind: "speaker-range",
                        id: "i1",
                        status: "suggested",
                        label: "S1",
                        fromSec: 0,
                        toSec: 9,
                        rules: [],
                        suggestedAt,
                    },
                    {
                        kind: "term",
                        id: "i2",
                        status: "suggested",
                        heard: "Viky",
                        proposed: "wiki",
                        rules: [],
                        suggestedAt,
                    },
                ],
            },
            { command: "test", change: "fixture" }
        );
        const named = await decideItems({
            store: meetings,
            record: created,
            status: "confirmed",
            ids: ["i1"],
            speaker: "Alice Example",
        });
        const term = await decideItems({ store: meetings, record: created, status: "confirmed", ids: ["i2"] });
        const rejected = await decideItems({ store: meetings, record: created, status: "rejected", ids: ["i2"] });

        await reopenItems({ store: meetings, record: created, ids: ["i1"], token: named.token });
        await reopenItems({ store: meetings, record: created, ids: ["i2"], token: rejected.token });
        let saved = meetings.read(created.id);
        expect(saved?.items[0]).toMatchObject({ status: "suggested" });
        expect(saved?.items[0] && "speaker" in saved.items[0] ? saved.items[0].speaker : undefined).toBeUndefined();
        expect(saved?.items[0]?.decision).toBeUndefined();
        expect(saved?.items[1]).toMatchObject({ status: "confirmed" });

        await reopenItems({ store: meetings, record: created, ids: ["i2"] });
        saved = meetings.read(created.id);
        expect(saved?.items[1]).toMatchObject({ status: "suggested", proposed: "wiki" });
        expect(term.token).not.toBe(rejected.token);

        const ledger = readCorrections().filter((line) => line.meeting === created.id);
        // The confirm, the reject's retraction, the confirmation the reject's Undo brings back, and the last Undo's
        // retraction: the ledger follows the item's state, so a rejected spelling stops counting as dictionary evidence.
        expect(ledger.map((line) => [line.item, line.retracted === true])).toEqual([
            ["i2", false],
            ["i2", true],
            ["i2", false],
            ["i2", true],
        ]);
    });
});

describe("window", () => {
    test("an app without the Meetings part gets it built before the window opens, or the command says how", async () => {
        const calls: string[] = [];
        const deps = (parts: string[]) => ({
            status: () => ({ built: true, parts }),
            build: async () => {
                calls.push("build");
            },
            open: (args: string[]) => {
                calls.push(`open ${args.includes("--meetings")}`);
                return { status: 0, stderr: "" };
            },
        });

        await openMeetingsWindow({ meeting: "m1" }, deps(["hub"]));
        expect(calls).toEqual(["build", "open true"]);

        calls.length = 0;
        await openMeetingsWindow({}, deps(["meetings"]));
        expect(calls).toEqual(["open true"]);

        calls.length = 0;
        await expect(openMeetingsWindow({ build: false }, deps(["hub"]))).rejects.toThrow(
            "tools macos permissions build --add-part meetings"
        );
        expect(calls).toEqual([]);
    });

    test("the open arguments name the face, the place, the meeting and the tab; no focus opens it behind", () => {
        expect(windowOpenArgs({ place: { project: "side.quest" }, meeting: "m1", tab: "items" }, "/A.app")).toEqual([
            "-n",
            "/A.app",
            "--args",
            "--meetings",
            "--place",
            "project:side.quest",
            "--meeting",
            "m1",
            "--tab",
            "items",
        ]);
        expect(windowOpenArgs({ focus: false }, "/A.app")).toEqual([
            "-n",
            "-g",
            "/A.app",
            "--args",
            "--meetings",
            "--no-focus",
        ]);
    });
});

/** MU11: a project can be renamed everywhere it is named, and removed with a backup. */
describe("projects rename and remove", () => {
    async function withProject() {
        const { config, meetings } = stores();
        await config.addProject("wrok");
        await config.setProjectLabels("wrok", { add: ["Checkout 2.0"] });
        await config.addSourceFolder("wisprflow", "wrok", "Work");
        const used = await meetings.create(
            { title: "Planning", start: "2026-11-02T14:00:00.000Z", createdBy: "new", project: "wrok" },
            { command: "test", change: "created" }
        );
        return { config, meetings, used: used.id };
    }

    test("a rename moves the block, the folder pairing and the meetings' project", async () => {
        const { config, meetings, used } = await withProject();
        const result = await renameProject({ config, store: meetings, from: "wrok", to: "work" });
        const read = await config.read();

        expect(result.meetings).toEqual([used]);
        expect(read.projects.wrok).toBeUndefined();
        expect(read.projects.work?.labels).toEqual(["Checkout 2.0"]);
        expect(read.sources.wisprflow.match.work?.folders).toEqual(["Work"]);
        expect(meetings.read(used)?.project).toBe("work");
        await expect(renameProject({ config, store: meetings, from: "work", to: "work" })).rejects.toThrow(
            "exists already"
        );
    });

    test("a project meetings use is refused unless --unassign, and the removed block is kept", async () => {
        const { config, meetings, used } = await withProject();
        const backupRoot = join(meetings.root, "..", "backups");

        await expect(removeProject({ config, store: meetings, name: "wrok", backupRoot })).rejects.toThrow(used);

        const result = await removeProject({ config, store: meetings, name: "wrok", unassign: true, backupRoot });
        const kept = SafeJSON.parse(readFileSync(result.backup, "utf8"));

        expect((await config.read()).projects.wrok).toBeUndefined();
        expect(meetings.read(used)?.project).toBeUndefined();
        expect(kept).toMatchObject({
            project: "wrok",
            block: { labels: ["Checkout 2.0"] },
            sources: { wisprflow: { folders: ["Work"] } },
        });
    });
});
