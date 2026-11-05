import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerAskForm, cancelAskForm, getAskForm } from "@app/question/lib/pending/ask";
import { SafeJSON } from "@genesiscz/utils/json";
import type { CalendarEntry, CalendarLookup } from "@genesiscz/utils/meetings/calendar-entry";
import { MeetingsConfigStore, meetingsConfigSchema } from "@genesiscz/utils/meetings/config";
import {
    calendarCandidates,
    mergeCalendarEntries,
    proposeProjects,
    reasonText,
} from "@genesiscz/utils/meetings/proposals";
import { MeetingStore } from "@genesiscz/utils/meetings/record";
import type { SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { Storage } from "@genesiscz/utils/storage/storage";
import {
    type AssignDeps,
    applyAnswer,
    askAtMeetingEnd,
    askMeeting,
    assignSweep,
    buildQuestion,
    hasOpenAssignSteps,
    markAssignStart,
    readAnswer,
    skipReason,
    viewProposals,
} from "./assign";
import {
    type AskAnswer,
    type AssignInbox,
    type CreateAskFormInput,
    decisionInbox,
    type InboxAnswer,
} from "./assign-inbox";

const ALICE = { name: "Alice Novak", email: "alice@example.com" };
const BOB = { name: "Bob Smith", email: "bob@example.com" };
const ME = { name: "Owner Example", email: "owner@example.com", self: true };

function entry(
    fields: Partial<CalendarEntry> & Pick<CalendarEntry, "entryId" | "title" | "start" | "end">
): CalendarEntry {
    return { from: "wisprflow", people: [], ...fields };
}

/** An inbox in memory: posted questions, and the answers a test gives. */
class MemoryInbox implements AssignInbox {
    readonly posted: Array<CreateAskFormInput & { id: string }> = [];
    readonly forms = new Map<string, InboxAnswer>();

    async post(input: CreateAskFormInput): Promise<{ id: string }> {
        const id = input.id ?? `form-${this.posted.length}`;
        this.posted.push({ ...input, id });
        this.forms.set(id, { status: "pending", answers: {} });
        return { id };
    }

    async read(id: string): Promise<InboxAnswer | null> {
        return this.forms.get(id) ?? null;
    }

    async cancel(id: string): Promise<void> {
        this.forms.set(id, { status: "cancelled", answers: {} });
    }

    answer(id: string, answers: AskAnswer[]): void {
        this.forms.set(id, { status: "answered", answers: Object.fromEntries(answers.map((a) => [a.itemId, a])) });
    }
}

let n = 0;

function setup(
    options: { folders?: string[]; entries?: CalendarEntry[]; apple?: CalendarLookup; mark?: boolean } = {}
) {
    n += 1;
    const store = new MeetingStore(new Storage(`meetings-assign-${process.pid}-${n}`));

    if (options.mark !== false) {
        markAssignStart(store, new Date("2026-11-04T00:00:00.000Z"));
    }

    const config = new MeetingsConfigStore(new Storage(`meetings-assign-config-${process.pid}-${n}`));
    const inbox = new MemoryInbox();
    const state = { folders: options.folders ?? [], now: Date.parse("2026-11-04T18:00:00.000Z") };
    const meeting: SourceMeeting = {
        sourceMeetingId: "w1",
        title: "x",
        start: "",
        participants: [],
        speakers: [],
        transcript: [],
        folders: [],
    };
    const source: TranscriptSource = {
        id: "wisprflow",
        label: "Fake",
        load: async () => meeting,
        describe: () => ({}),
        dictionary: async () => [],
        recordingClock: async () => null,
        evidence: async () => null,
        liveRecording: async () => null,
        calendarEntries: async () => ({ ok: true, from: "wisprflow", entries: options.entries ?? [] }),
        folders: async () => state.folders,
        meetingFolders: async () => state.folders,
        folderWrite: { supported: false, reason: "No write", manualStep: "move it by hand" },
    };
    const deps: AssignDeps = {
        inbox,
        config,
        calendars: async (range, linked) => [
            ...(linked ? [await linked.calendarEntries(range)] : []),
            options.apple ?? { ok: true, from: "apple-calendar", entries: [] },
        ],
        source: async (record) =>
            record.sources.wisprflow
                ? { source, sourceMeetingId: String(record.sources.wisprflow.meetingId) }
                : undefined,
        now: () => state.now,
    };
    const create = (title: string, start: string, fields: Record<string, unknown> = {}) =>
        store.create(
            {
                title,
                start,
                end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
                createdBy: "link",
                sources: { wisprflow: { meetingId: `w-${title}`, folders: [] } },
                ...fields,
            },
            { command: "test", change: "created" }
        );

    return { store, config, inbox, state, deps, create };
}

describe("proposals", () => {
    test("rules, paired people of each overlapping entry, title history and labels rank the projects", () => {
        const config = meetingsConfigSchema.parse({
            projects: {
                offers: {
                    labels: ["Offers 2.0"],
                    match: {
                        people: [
                            { ...ALICE, pairedBy: [{ kind: "manual", at: "2026-11-01T10:00:00.000Z" }] },
                            { ...BOB, pairedBy: [{ kind: "manual", at: "2026-11-01T10:00:00.000Z" }] },
                        ],
                    },
                },
                wiki: { match: { title: { words: ["wiki"] } } },
                infra: {},
            },
            sources: { wisprflow: { match: { infra: { folders: ["Ops"] } } } },
        });
        const start = "2026-11-04T14:00:00.000Z";
        const entries = [
            entry({
                entryId: "e1",
                title: "Offers 2.0 review",
                start,
                end: "2026-11-04T14:30:00.000Z",
                people: [ALICE, BOB, ME],
            }),
            entry({ entryId: "e2", title: "Wiki", start: "2026-11-04T14:15:00.000Z", end: "2026-11-04T15:00:00.000Z" }),
        ];
        const proposals = proposeProjects(config, {
            title: "Offers and the wiki",
            source: { id: "wisprflow", folders: [] },
            calendars: calendarCandidates({ entries, start, end: "2026-11-04T14:30:00.000Z", slackMin: 15 }),
            participants: [{ name: "Smith Bob" }],
            history: [{ id: "old", title: "Offers planning", project: "offers", labels: ["Offers 2.0"] }],
        });

        expect(proposals.projects.map((p) => [p.project, p.score])).toEqual([
            ["wiki", 40],
            ["offers", 38],
        ]);
        expect(proposals.projects.find((p) => p.project === "offers")?.reasons.map(reasonText)).toEqual([
            '2 of 2 people of "Offers 2.0 review" paired: Alice Novak, Bob Smith',
            'title words "offers" as in 1 earlier meeting(s)',
        ]);
        expect(proposals.calendars.map((c) => [c.entry.entryId, c.share])).toEqual([
            ["e1", 1],
            ["e2", 0.5],
        ]);
        expect(proposals.labels).toEqual([
            { project: "offers", label: "Offers 2.0", reason: '"Offers 2.0" is in the title' },
        ]);
        expect(proposals.folder).toEqual({
            kind: "move",
            source: "wisprflow",
            folders: [
                { project: "wiki", folders: [] },
                { project: "offers", folders: [] },
            ],
        });
    });

    test("one entry in two calendars merges: the source's people and Apple's calendar name", () => {
        const start = "2026-11-04T14:00:00.000Z";
        const end = "2026-11-04T15:00:00.000Z";
        const merged = mergeCalendarEntries([
            [entry({ entryId: "w", title: "Planning", start, end, people: [ALICE] })],
            [entry({ from: "apple-calendar", entryId: "a", calendar: "Work", title: "planning", start, end })],
        ]);

        expect(merged).toEqual([
            entry({
                entryId: "w",
                title: "Planning",
                start,
                end,
                people: [ALICE],
                calendar: "Work",
                alsoIn: [{ from: "apple-calendar", entryId: "a", calendar: "Work" }],
            }),
        ]);
    });
});

describe("ask each time", () => {
    test("one question per ended meeting without a project; its answer applies project, labels and pairings", async () => {
        const start = "2026-11-04T14:00:00.000Z";
        const entries = [
            entry({ entryId: "e1", title: "Planning", start, end: "2026-11-04T14:30:00.000Z", people: [ALICE, ME] }),
            entry({
                entryId: "e2",
                title: "Other",
                start: "2026-11-04T14:10:00.000Z",
                end: "2026-11-04T14:40:00.000Z",
            }),
        ];
        const { store, config, inbox, deps, create, state } = setup({
            entries,
            apple: { ok: false, from: "apple-calendar", reason: 'Calendar access is "denied"', fix: "grant it" },
        });
        await config.addProject("offers");
        const meeting = await create("Planning", start);
        await create("Has one", "2026-11-04T15:00:00.000Z", { project: "offers" });
        await create("Live", "2026-11-04T16:00:00.000Z", { end: undefined });

        expect((await assignSweep(store, deps)).asked).toEqual([meeting.id]);
        expect((await assignSweep(store, deps)).asked).toEqual([]);
        expect(inbox.posted).toHaveLength(1);

        const question = inbox.posted[0]!;
        expect(question.items.map((item) => item.id)).toEqual(["project", "calendar", "labels"]);
        expect(question.items[0]?.promptMarkdown).toContain('apple-calendar not read: Calendar access is "denied"');
        expect(question.items[0]?.promptMarkdown).toContain(
            "the meeting is in no folder. No write, so move it yourself"
        );
        expect(question.items[1]?.choices).toHaveLength(3);

        inbox.answer(question.id, [
            { itemId: "project", selectedChoices: ["project:offers"] },
            { itemId: "calendar", selectedChoices: ["calendar:0"] },
            { itemId: "labels", freeText: "Offers 2.0, Kickoff" },
        ]);
        state.folders = [];
        const sweep = await assignSweep(store, deps);

        expect(sweep.advanced).toEqual([{ meeting: meeting.id, outcome: "applied" }]);
        const record = store.read(meeting.id)!;
        expect(record.project).toBe("offers");
        expect(record.labels).toEqual(["Offers 2.0", "Kickoff"]);
        expect(record.calendar).toMatchObject({ eventId: "e1", attendees: ["Alice Novak", "Owner Example"] });
        expect(record.assign?.ask?.outcome).toBe("applied");
        expect(record.assign?.folder).toMatchObject({ state: "waiting", project: "offers" });

        const read = await config.read();
        expect(read.projects.offers?.labels).toEqual(["Offers 2.0", "Kickoff"]);
        expect(read.projects.offers?.match?.people).toEqual([
            {
                ...ALICE,
                pairedBy: [
                    {
                        kind: "calendar",
                        from: "wisprflow",
                        entryId: "e1",
                        title: "Planning",
                        start,
                        meetingId: meeting.id,
                        at: new Date(state.now).toISOString(),
                    },
                ],
            },
        ]);

        const later = await create("Next", "2026-11-04T17:00:00.000Z", {
            participants: [{ name: "novak alice", from: [] }],
        });
        const view = await viewProposals(store, later, deps);
        expect(view.proposals.projects[0]?.project).toBe("offers");

        expect(await config.unpairEntry("e1")).toEqual([{ project: "offers", ...ALICE, left: true }]);
        expect((await viewProposals(store, later, deps)).proposals.projects).toEqual([]);
    });

    test("the folder ladder: a moved meeting asks to pair its new folder, and yes pairs it", async () => {
        const { store, config, inbox, deps, create, state } = setup();
        await config.addProject("offers");
        const meeting = await create("Planning", "2026-11-04T14:00:00.000Z");
        await assignSweep(store, deps);
        inbox.answer(inbox.posted[0]!.id, [{ itemId: "project", freeText: "offers" }]);
        await assignSweep(store, deps);

        expect(store.read(meeting.id)?.assign?.folder?.state).toBe("waiting");
        expect((await assignSweep(store, deps)).advanced).toEqual([]);

        state.folders = ["Offers"];
        expect((await assignSweep(store, deps)).advanced).toEqual([{ meeting: meeting.id, outcome: "folder asked" }]);

        const folderQuestion = inbox.posted[1]!;
        expect(folderQuestion.items[0]?.promptMarkdown).toContain('folder "Offers"');
        inbox.answer(folderQuestion.id, [{ itemId: "folder", selectedChoices: ["folder:yes"] }]);

        expect((await assignSweep(store, deps)).advanced).toEqual([{ meeting: meeting.id, outcome: "folder paired" }]);
        expect((await config.read()).sources.wisprflow.match.offers?.folders).toEqual(["Offers"]);
        expect(store.read(meeting.id)?.assign?.folder?.state).toBe("paired");
    });

    test("a meeting in no folder: the question names the folder of each proposed project to move it into", async () => {
        const { store, config, deps, create } = setup();
        await config.addProject("offers");
        await config.addSourceFolder("wisprflow", "offers", "Offers 2.0");
        await create("Offers sync", "2026-11-03T14:00:00.000Z", { project: "offers" });
        const meeting = await create("Offers review", "2026-11-04T14:00:00.000Z");
        const question = buildQuestion(await viewProposals(store, meeting, deps), await config.read());
        const prompt = question.items[0]?.promptMarkdown ?? "";

        expect(prompt).toContain("the meeting is in no folder. No write, so move it yourself: move it by hand.");
        expect(prompt).toContain('Folders of the proposed projects: offers → "Offers 2.0".');
        expect(prompt).toContain("The next sync sees the meeting in a folder and asks to pair that folder");
    });

    test("a meeting in a folder no project has offers to pair it; a new project name joins the known ones", async () => {
        const { store, config, inbox, deps, create } = setup({ folders: ["Side"] });
        const meeting = await create("Lunch", "2026-11-04T14:00:00.000Z");
        await assignSweep(store, deps);
        const question = buildQuestion(await viewProposals(store, meeting, deps), await config.read());

        expect(question.items.map((item) => item.id)).toEqual(["project", "labels", "folder"]);
        inbox.answer(inbox.posted[0]!.id, [
            { itemId: "project", freeText: "side" },
            { itemId: "folder", selectedChoices: ["folder:yes"] },
        ]);
        await assignSweep(store, deps);

        const read = await config.read();
        expect(Object.keys(read.projects)).toEqual(["side"]);
        expect(read.sources.wisprflow.match.side?.folders).toEqual(["Side"]);
        expect(store.read(meeting.id)?.assign?.folder).toBeUndefined();
    });

    test("auto-recording off: a hand-recorded meeting is asked at its end, once, and the watcher is wanted until the answer", async () => {
        const { store, config, inbox, deps, create } = setup({ mark: false });
        expect((await config.read()).sources.wisprflow.autoRecord.enabled).toBe(false);
        await config.addProject("offers");
        const handRecorded = (title: string, start: string) => {
            const stoppedAt = new Date(Date.parse(start) + 20 * 60_000).toISOString();
            return create(title, start, {
                end: undefined,
                sources: {},
                recording: { status: "stopped", startedAt: start, stoppedAt },
            });
        };
        const meeting = await handRecorded("Planning", "2026-11-04T16:00:00.000Z");

        const first = await askAtMeetingEnd(store, meeting.id, deps);
        expect(first.outcome).toBe("asked");
        expect(inbox.posted).toHaveLength(1);
        expect(inbox.posted[0]?.items[0]?.id).toBe("project");
        expect(hasOpenAssignSteps(store)).toBe(true);

        // A second end call, and the sweep after it, add no second question.
        expect((await askAtMeetingEnd(store, meeting.id, deps)).outcome).toStartWith("asked at ");
        expect((await assignSweep(store, deps)).asked).toEqual([]);
        expect(inbox.posted).toHaveLength(1);

        // The first ask marked the sweep's start at this meeting's end, so an older meeting is never asked.
        const older = await handRecorded("Older", "2026-11-04T09:00:00.000Z");
        expect((await askAtMeetingEnd(store, older.id, deps)).outcome).toBe("ended before ask each time began");
        expect(inbox.posted).toHaveLength(1);

        // The sweep reads the answer back; then nothing waits and the watcher may end.
        inbox.answer(inbox.posted[0]!.id, [{ itemId: "project", selectedChoices: ["project:offers"] }]);
        await assignSweep(store, deps);
        expect(store.read(meeting.id)?.project).toBe("offers");
        expect(hasOpenAssignSteps(store)).toBe(false);
    });

    test("an end the record does not show asks nothing, and ask each time off asks nothing", async () => {
        const { store, config, inbox, deps, create } = setup();
        const live = await create("Live", "2026-11-04T16:00:00.000Z", {
            end: undefined,
            sources: {},
            recording: { status: "recording" },
        });

        expect((await askAtMeetingEnd(store, live.id, deps)).outcome).toBe("not ended");
        expect((await askAtMeetingEnd(store, "2026-11-04_17-00-gone", deps)).outcome).toBe("gone");

        await config.update((raw) => {
            raw.global = { assign: { ask: false } };
        });
        const ended = await create("Ended", "2026-11-04T15:00:00.000Z");
        expect((await askAtMeetingEnd(store, ended.id, deps)).outcome).toBe("ask each time is off");
        expect(inbox.posted).toHaveLength(0);
    });

    test("the first sweep marks its start and asks only about meetings that end after it", async () => {
        const { store, inbox, deps, create, state } = setup({ mark: false });
        await create("Old", "2026-11-04T14:00:00.000Z");

        expect((await assignSweep(store, deps)).asked).toEqual([]);
        state.now = Date.parse("2026-11-04T19:00:00.000Z");
        const fresh = await create("Fresh", "2026-11-04T18:20:00.000Z");

        expect((await assignSweep(store, deps)).asked).toEqual([fresh.id]);
        expect(inbox.posted).toHaveLength(1);
    });

    test("the calendar look-behind is 3 hours without a key, and global.assign.calendarLookbehindHours changes it", async () => {
        const { store, config, deps, create } = setup();
        const meeting = await create("Planning", "2026-11-04T14:00:00.000Z");
        const froms: number[] = [];
        const watching: AssignDeps = {
            ...deps,
            calendars: async (range, linked) => {
                froms.push(range.from.getTime());
                return deps.calendars(range, linked);
            },
        };
        const start = Date.parse(meeting.start);

        await viewProposals(store, meeting, watching);
        await config.update((raw) => {
            raw.global = { assign: { calendarLookbehindHours: 6 } };
        });
        await viewProposals(store, meeting, watching);

        expect(froms).toEqual([start - 3 * 3_600_000, start - 6 * 3_600_000]);
    });

    test("a meeting waits 14 days for its folder without a key, and global.assign.folderWaitDays changes it", async () => {
        const answerFolder = async (days?: number) => {
            const { store, config, inbox, deps, create, state } = setup();
            await config.addProject("offers");

            if (days !== undefined) {
                await config.update((raw) => {
                    raw.global = { assign: { folderWaitDays: days } };
                });
            }

            const meeting = await create("Planning", "2026-11-04T14:00:00.000Z");
            await assignSweep(store, deps);
            inbox.answer(inbox.posted[0]!.id, [{ itemId: "project", freeText: "offers" }]);
            await assignSweep(store, deps);
            const since = Date.parse(store.read(meeting.id)?.assign?.folder?.since ?? "");
            const outcomeAfter = async (waitedMs: number) => {
                state.now = since + waitedMs;
                return (await assignSweep(store, deps)).advanced.map((step) => step.outcome);
            };

            return { outcomeAfter };
        };
        const day = 24 * 3_600_000;
        const fresh = await answerFolder();
        expect(await fresh.outcomeAfter(14 * day - 60_000)).toEqual([]);
        expect(await fresh.outcomeAfter(14 * day + 60_000)).toEqual(["folder wait expired"]);

        const longer = await answerFolder(30);
        expect(await longer.outcomeAfter(15 * day)).toEqual([]);
        expect(await longer.outcomeAfter(30 * day + 60_000)).toEqual(["folder wait expired"]);
    });

    test("a failed post is asked again after 10 minutes without a key, and global.assign.retryFailedMin changes it", async () => {
        const failedAsk = async (minutes?: number) => {
            const { store, config, inbox, deps, create, state } = setup();

            if (minutes !== undefined) {
                await config.update((raw) => {
                    raw.global = { assign: { retryFailedMin: minutes } };
                });
            }

            const meeting = await create("Planning", "2026-11-04T14:00:00.000Z");
            const post = inbox.post.bind(inbox);
            inbox.post = async () => {
                throw new Error("inbox down");
            };
            await askMeeting(store, meeting, deps);
            inbox.post = post;

            const asked = Date.parse(store.read(meeting.id)?.assign?.ask?.askedAt ?? "");
            const skippedAfter = async (waitedMin: number) => {
                const retry = (await config.read()).global.assign.retryFailedMin;
                const record = store.read(meeting.id)!;
                return (
                    skipReason({ record, store, now: asked + waitedMin * 60_000, retryFailedMin: retry }) !== undefined
                );
            };

            return { skippedAfter, state };
        };
        const fresh = await failedAsk();
        expect(await fresh.skippedAfter(9)).toBe(true);
        expect(await fresh.skippedAfter(11)).toBe(false);

        const slower = await failedAsk(30);
        expect(await slower.skippedAfter(11)).toBe(true);
        expect(await slower.skippedAfter(31)).toBe(false);
    });

    test("readAnswer: no project, a known one picked, labels from choices and text", () => {
        expect(readAnswer({ project: { itemId: "project", selectedChoices: ["project:none"] } })).toEqual({
            project: null,
            labels: [],
        });
        expect(
            readAnswer({
                project: { itemId: "project", selectedChoices: ["project:offers"] },
                calendar: { itemId: "calendar", selectedChoices: ["calendar:none"] },
                labels: { itemId: "labels", selectedChoices: ["label:A"], freeText: "a, B" },
            })
        ).toEqual({ project: "offers", labels: ["A", "B"] });
    });
});

/**
 * The same flow on the real question store (the test preload points ~/.genesis-tools at a temporary home). The owner
 * answers or cancels through the store's own functions, the ones `tools question answer` and `cancel` call, so what
 * `readAnswer` sees is what the store keeps and not what a test wrote in its shape.
 */
describe("ask each time on the real question store", () => {
    const START = "2026-11-04T14:00:00.000Z";

    // The form id comes from the meeting id and the clock, and the real store outlives each test: one title per test.
    async function askedOnRealStore(title: string, inbox: AssignInbox = decisionInbox) {
        const made = setup();
        const deps: AssignDeps = { ...made.deps, inbox };
        await made.config.addProject("offers");
        const meeting = await made.create(title, START);
        expect((await assignSweep(made.store, deps)).asked).toEqual([meeting.id]);
        const formId = made.store.read(meeting.id)?.assign?.ask?.formId ?? "";

        return { ...made, deps, meeting, formId };
    }

    test("a form answered through the store applies the project and the new labels", async () => {
        const { store, config, deps, meeting, formId } = await askedOnRealStore("Northwind planning");
        const posted = getAskForm(formId);

        expect(posted?.status).toBe("pending");
        expect(posted?.items.map((item) => item.id)).toEqual(["project", "labels"]);
        expect(hasOpenAssignSteps(store)).toBe(true);
        expect((await assignSweep(store, deps)).advanced).toEqual([]);

        const outcome = await answerAskForm(formId, [
            { itemId: "project", selectedChoices: ["project:offers"] },
            { itemId: "labels", freeText: "Offers 2.0, Kickoff" },
        ]);
        expect(outcome).toMatchObject({ ok: true });
        expect(getAskForm(formId)?.status).toBe("answered");

        expect((await assignSweep(store, deps)).advanced).toEqual([{ meeting: meeting.id, outcome: "applied" }]);
        const record = store.read(meeting.id)!;
        expect(record.project).toBe("offers");
        expect(record.labels).toEqual(["Offers 2.0", "Kickoff"]);
        expect(record.assign?.ask?.outcome).toBe("applied");
        expect(Object.keys((await config.read()).projects)).toEqual(["offers"]);
    });

    test("a project typed into the form's free text on the store is a new project", async () => {
        const { store, config, deps, meeting, formId } = await askedOnRealStore("Fabrikam kickoff");

        expect(
            await answerAskForm(formId, [
                { itemId: "project", freeText: "fabrikam" },
                { itemId: "labels", freeText: "Rollout" },
            ])
        ).toMatchObject({ ok: true });
        await assignSweep(store, deps);

        expect(store.read(meeting.id)?.project).toBe("fabrikam");
        expect(Object.keys((await config.read()).projects)).toContain("fabrikam");
    });

    test("a cancelled form leaves the meeting without a project, closes the step and is not asked again", async () => {
        const { store, deps, meeting, formId } = await askedOnRealStore("Contoso review");

        expect(cancelAskForm(formId)?.status).toBe("cancelled");
        expect((await assignSweep(store, deps)).advanced).toEqual([{ meeting: meeting.id, outcome: "cancelled" }]);

        const record = store.read(meeting.id)!;
        expect(record.project).toBeUndefined();
        expect(record.assign?.ask?.outcome).toBe("cancelled");
        expect(hasOpenAssignSteps(store)).toBe(false);
        expect((await assignSweep(store, deps)).asked).toEqual([]);
    });

    test("a form that passed its timeout is closed as a timeout by the store's own expiry", async () => {
        // The assign flow posts without a timeout, so this inbox adds one to reach the store's expiry path.
        const withTimeout: AssignInbox = {
            ...decisionInbox,
            post: (input) => decisionInbox.post({ ...input, timeoutMs: 60_000 }),
        };
        const { store, deps, meeting, formId } = await askedOnRealStore("Litware sync", withTimeout);

        expect(getAskForm(formId)?.status).toBe("pending");
        setSystemTime(new Date(Date.now() + 2 * 60_000));

        try {
            expect(getAskForm(formId)?.status).toBe("timeout");
            expect((await assignSweep(store, deps)).advanced).toEqual([{ meeting: meeting.id, outcome: "timeout" }]);
        } finally {
            setSystemTime();
        }

        const record = store.read(meeting.id)!;
        expect(record.project).toBeUndefined();
        expect(record.assign?.ask?.outcome).toBe("timeout");
        expect(hasOpenAssignSteps(store)).toBe(false);
    });
});

test("folder questions persist before posting and recover the same choices and id", async () => {
    const storage = new Storage(`assign-claim-${process.pid}`);
    const store = new MeetingStore(storage);
    const since = "2026-11-05T10:00:00.000Z";
    const record = await store.create(
        {
            title: "Fixture",
            start: since,
            createdBy: "new",
            assign: { folder: { source: "wisprflow", project: "work", state: "waiting", since } },
        },
        { command: "new", change: "fixture" }
    );
    const index = join(store.root, "assign-open.json");
    writeFileSync(index, SafeJSON.stringify({ open: { [record.id]: "folder-wait" } }));
    const config = new MeetingsConfigStore(new Storage(`assign-config-${process.pid}`));
    const forms: CreateAskFormInput[] = [];
    let answer: InboxAnswer | null = null;
    let now = Date.parse(since);
    const deps: AssignDeps = {
        config,
        now: () => now,
        calendars: async () => [],
        source: async () => ({
            sourceMeetingId: "fixture",
            source: {
                id: "wisprflow",
                label: "Fixture",
                load: async () => {
                    throw new Error("unused");
                },
                describe: () => ({}),
                dictionary: async () => [],
                recordingClock: async () => null,
                evidence: async () => null,
                liveRecording: async () => null,
                calendarEntries: async () => ({ ok: true, from: "fixture", entries: [] }),
                folders: async () => [],
                meetingFolders: async () => ["Notes"],
                folderWrite: { supported: false, reason: "fixture", manualStep: "fixture" },
            },
        }),
        inbox: {
            read: async () => answer,
            cancel: async () => {},
            post: async (input) => {
                forms.push(input);
                const saved = new MeetingStore(storage).read(record.id)!;
                expect(saved.assign?.folder).toMatchObject({ state: "asked", folder: "Notes", formId: input.id });
                expect(SafeJSON.parse(readFileSync(index, "utf8")).open[record.id]).toBe("folder-ask");
                if (forms.length === 1) {
                    throw new Error("interrupted post");
                }
                answer = { status: "pending", answers: {} };
                return { id: input.id! };
            },
        },
    };

    await assignSweep(store, deps);
    now += 1000;
    await assignSweep(new MeetingStore(storage), deps);
    expect(forms).toHaveLength(2);
    expect(forms[1]).toEqual(forms[0]);
    answer = { status: "answered", answers: { folder: { itemId: "folder", selectedChoices: ["folder:no"] } } };
    await assignSweep(new MeetingStore(storage), deps);
    expect(new MeetingStore(storage).read(record.id)?.assign?.folder?.state).toBe("declined");
});

describe("assign apply", () => {
    test("an explicit no project removes the project the meeting already has", async () => {
        const { store, deps, create } = setup();
        const record = await create("Standup", "2026-11-04T09:00:00.000Z", { project: "work" });
        expect(store.read(record.id)?.project).toBe("work");

        const applied = await applyAnswer({ store, record, deps, answer: { project: null, labels: [] } });

        expect(applied.project).toBeUndefined();
        expect(store.read(record.id)?.project).toBeUndefined();
    });

    test("a folder pairing without an asked question pairs the one source folder, and refuses otherwise", async () => {
        const { store, deps, config, state, create } = setup({ folders: ["Clients"] });
        const record = await create("Review", "2026-11-04T10:00:00.000Z");

        const applied = await applyAnswer({
            store,
            record,
            deps,
            answer: { project: "work", labels: [], pairFolder: true },
        });

        expect(applied.folderPaired).toBe("Clients");
        expect((await config.read()).sources.wisprflow?.match.work?.folders).toEqual(["Clients"]);

        state.folders = [];
        const other = await create("Planning", "2026-11-04T11:00:00.000Z");
        await expect(
            applyAnswer({ store, record: other, deps, answer: { project: "work", labels: [], pairFolder: true } })
        ).rejects.toThrow("is in no Fake folder");
        expect(store.read(other.id)?.project).toBeUndefined();
    });
});
