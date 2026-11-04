import { describe, expect, test } from "bun:test";
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
import { type AssignDeps, assignSweep, buildQuestion, markAssignStart, readAnswer, viewProposals } from "./assign";
import type { AskAnswer, AssignInbox, CreateAskFormInput, InboxAnswer } from "./assign-inbox";

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

    test("the first sweep marks its start and asks only about meetings that end after it", async () => {
        const { store, inbox, deps, create, state } = setup({ mark: false });
        await create("Old", "2026-11-04T14:00:00.000Z");

        expect((await assignSweep(store, deps)).asked).toEqual([]);
        state.now = Date.parse("2026-11-04T19:00:00.000Z");
        const fresh = await create("Fresh", "2026-11-04T18:20:00.000Z");

        expect((await assignSweep(store, deps)).asked).toEqual([fresh.id]);
        expect(inbox.posted).toHaveLength(1);
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
