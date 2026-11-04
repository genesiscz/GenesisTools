import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { appleCalendarEntries } from "@genesiscz/utils/meetings/calendar";
import type { CalendarEntry, CalendarLookup } from "@genesiscz/utils/meetings/calendar-entry";
import {
    type MeetingsConfig,
    MeetingsConfigStore,
    mergeLabels,
    projectNameSchema,
} from "@genesiscz/utils/meetings/config";
import {
    calendarCandidates,
    type MeetingFacts,
    mergeCalendarEntries,
    type Proposals,
    proposeProjects,
    reasonText,
} from "@genesiscz/utils/meetings/proposals";
import type { MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import type { MeetingSourceId, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { type AskAnswer, type AssignInbox, type CreateAskFormInput, decisionInbox } from "./assign-inbox";
import { isMeetingSourceId, meetingSource, sourceRefOf } from "./sources";
import { readAuto } from "./watch-auto";

const { log } = logger.scoped("meetings-assign");

/** A failed post is tried again after this long, so a broken inbox is not hit on every look. */
const RETRY_FAILED_MS = 10 * 60_000;
/** A meeting waits this long for the owner to move it into a source folder; then the folder step ends. */
const FOLDER_WAIT_MS = 14 * 24 * 3_600_000;
/** Calendar entries that start this long before a meeting can still cover it. */
const ENTRY_LOOKBEHIND_MS = 3 * 3_600_000;

const OPEN_FILE = "assign-open.json";

/**
 * The meetings with an open assign step, so the watcher reads only those records: a question to read back (`ask`), a
 * meeting waiting to show up in a source folder (`folder-wait`), or a folder question (`folder-ask`).
 */
const openSchema = z.object({
    open: z.record(z.string(), z.enum(["ask", "folder-wait", "folder-ask"])).default({}),
});
type OpenSteps = z.infer<typeof openSchema>["open"];

/** What the assign flow reaches outside the meeting store: the inbox, the calendars, the source, the clock. */
export interface AssignDeps {
    inbox: AssignInbox;
    config: MeetingsConfigStore;
    /** Every calendar that can hold the meeting's entry, each answering for itself. */
    calendars: (range: { from: Date; to: Date }, source?: TranscriptSource) => Promise<CalendarLookup[]>;
    source: (record: MeetingRecord) => Promise<{ source: TranscriptSource; sourceMeetingId: string } | undefined>;
    now: () => number;
}

export function defaultAssignDeps(): AssignDeps {
    return {
        inbox: decisionInbox,
        config: new MeetingsConfigStore(),
        // The source's own calendar first: it names the attendees, so a merged entry keeps its people.
        calendars: async (range, source) =>
            Promise.all([...(source ? [source.calendarEntries(range)] : []), appleCalendarEntries(range)]),
        source: async (record) => {
            const ref = sourceRefOf(record);

            if (!ref || !isMeetingSourceId(ref.sourceId)) {
                return undefined;
            }

            return { source: await meetingSource(ref.sourceId), sourceMeetingId: ref.sourceMeetingId };
        },
        now: () => Date.now(),
    };
}

/** The proposals for one meeting, with the calendars that could not be read and why. */
export interface AssignView {
    record: MeetingRecord;
    proposals: Proposals;
    /** One line per calendar that did not answer: an unread calendar is never "no entries". */
    calendarNotes: string[];
    sourceId?: MeetingSourceId;
    folderWrite?: TranscriptSource["folderWrite"];
}

/** Reads the facts of one meeting and ranks its projects. Reads only. */
export async function viewProposals(store: MeetingStore, record: MeetingRecord, deps: AssignDeps): Promise<AssignView> {
    const config = await deps.config.read();
    const linked = await deps.source(record).catch((err: unknown) => {
        log.warn({ err, meeting: record.id }, "source not reachable; proposals without it");
        return undefined;
    });
    const folders = linked
        ? ((await linked.source.meetingFolders(linked.sourceMeetingId)) ?? blockFolders(record, linked.source.id))
        : [];
    const start = Date.parse(record.start);
    const end = record.end ? Date.parse(record.end) : start + 30 * 60_000;
    const slack = config.global.assign.calendarSlackMin * 60_000;
    const lookups = await deps.calendars(
        { from: new Date(start - Math.max(slack, ENTRY_LOOKBEHIND_MS)), to: new Date(end + slack) },
        linked?.source
    );
    const entries = mergeCalendarEntries(lookups.flatMap((lookup) => (lookup.ok ? [lookup.entries] : [])));
    const facts: MeetingFacts = {
        title: record.title,
        ...(linked ? { source: { id: linked.source.id, folders } } : {}),
        calendars: calendarCandidates({
            entries,
            start: record.start,
            end: record.end,
            slackMin: config.global.assign.calendarSlackMin,
        }),
        participants: record.participants.map((person) => ({ name: person.name, self: person.self })),
        history: store
            .list()
            .filter((other) => other.id !== record.id)
            .map((other) => ({ id: other.id, title: other.title, project: other.project, labels: other.labels })),
    };
    const calendarNotes = lookups.flatMap((lookup) =>
        lookup.ok ? [] : [`${lookup.from} not read: ${lookup.reason}${lookup.fix ? ` (fix: ${lookup.fix})` : ""}`]
    );
    log.debug(
        { meeting: record.id, entries: entries.length, candidates: facts.calendars.length, notes: calendarNotes },
        "assign facts"
    );

    return {
        record,
        proposals: proposeProjects(config, facts),
        calendarNotes,
        ...(linked ? { sourceId: linked.source.id, folderWrite: linked.source.folderWrite } : {}),
    };
}

function blockFolders(record: MeetingRecord, sourceId: string): string[] {
    const folders = record.sources[sourceId]?.folders;
    return Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === "string") : [];
}

function clock(iso: string): string {
    return formatLocalDateTimeStamp(iso, { seconds: false });
}

function entryLine(entry: CalendarEntry): string {
    const where = entry.calendar ? ` · ${entry.calendar}` : ` · ${entry.from}`;
    const people = entry.people.length > 0 ? ` · ${entry.people.length} people` : "";
    return `${entry.title} · ${clock(entry.start)}–${clock(entry.end).slice(11)}${where}${people}`;
}

/** The question for one meeting: the project item, the calendar entry item, the labels item and the folder item. */
export function buildQuestion(view: AssignView, config: MeetingsConfig): CreateAskFormInput {
    const { record, proposals } = view;
    const known = Object.keys(config.projects);
    const proposed = proposals.projects.map((proposal) => proposal.project);
    const lines = [
        `**Which project is the meeting "${record.title}"?** ${clock(record.start)}${record.end ? `–${clock(record.end).slice(11)}` : ""}`,
        `Show it: \`${toolCommand("meetings", "show", record.id)}\``,
        "",
        proposals.projects.length > 0
            ? "Proposals, best first:"
            : "No project rule, person or title word points anywhere.",
        ...proposals.projects.map(
            (proposal, i) =>
                `${i + 1}. **${proposal.project}** (${proposal.score}): ${proposal.reasons.map(reasonText).join("; ")}`
        ),
        ...view.calendarNotes.map((note) => `> ${note}`),
        ...folderLines(view, config),
        "",
        "Pick one, or write another known project or a new project's name in the text field.",
    ];
    const items: CreateAskFormInput["items"] = [
        {
            id: "project",
            promptMarkdown: lines.join("\n"),
            choices: [
                ...proposals.projects.map((proposal) => ({
                    id: `project:${proposal.project}`,
                    label: `${proposal.project}: ${reasonText(proposal.reasons[0]!)}`,
                })),
                ...known
                    .filter((name) => !proposed.includes(name))
                    .map((name) => ({ id: `project:${name}`, label: name })),
                { id: "project:none", label: "No project for this meeting" },
            ],
            allowFreeText: true,
        },
    ];

    if (proposals.calendars.length > 0) {
        items.push({
            id: "calendar",
            promptMarkdown:
                "**Which calendar entry is this meeting?** Its attendees are paired with the project you pick, so a " +
                "later meeting with them proposes it. A wrong pick is undone with " +
                `\`${toolCommand("meetings", "projects", "unpair", "--entry", "<entry id>")}\`.`,
            choices: [
                ...proposals.calendars.map((candidate, i) => ({
                    id: `calendar:${i}`,
                    label: `${entryLine(candidate.entry)} (${Math.round(candidate.share * 100)}% of the meeting)`,
                })),
                { id: "calendar:none", label: "None of these" },
            ],
        });
    }

    const labelChoices = mergeLabels(
        proposals.labels.map((proposal) => proposal.label),
        proposed.flatMap((project) => config.projects[project]?.labels ?? [])
    );
    items.push({
        id: "labels",
        promptMarkdown: [
            "**Labels** (any). Write new ones in the text field, separated by commas; they join the project's labels.",
            ...proposals.labels.map((proposal) => `- ${proposal.label} (${proposal.project}): ${proposal.reason}`),
        ].join("\n"),
        choices: labelChoices.map((label) => ({ id: `label:${label}`, label })),
        allowMultiple: true,
        allowFreeText: true,
    });

    if (proposals.folder?.kind === "pair") {
        items.push({
            id: "folder",
            promptMarkdown:
                `**Pair the ${proposals.folder.source} folder "${proposals.folder.folder}" with the project you pick?** ` +
                "Later meetings in that folder then go to the project without a question.",
            choices: [
                { id: "folder:yes", label: "Yes, pair the folder" },
                { id: "folder:no", label: "No" },
            ],
        });
    }

    return {
        source: "meetings",
        projectPath: record.id,
        items,
    };
}

function folderLines(view: AssignView, config: MeetingsConfig): string[] {
    const advice = view.proposals.folder;

    if (advice?.kind !== "move" || !view.folderWrite) {
        return [];
    }

    const targets = advice.folders.map(({ project, folders }) =>
        folders.length > 0 ? `${project} → "${folders.join('", "')}"` : `${project} → no folder yet (create one)`
    );
    const all = Object.keys(config.projects).length;
    return [
        "",
        `**${advice.source} folder:** the meeting is in no folder. ${view.folderWrite.reason}, so move it yourself: ` +
            `${view.folderWrite.manualStep}.`,
        ...(targets.length > 0 ? [`Folders of the proposed projects: ${targets.join("; ")}.`] : []),
        `The next sync sees the folder and asks to pair it with the project (${all} known projects).`,
    ];
}

/** The owner's answer, read from the form. `project` null is "no project"; undefined is "not answered". */
export interface AssignAnswer {
    project?: string | null;
    calendarIndex?: number;
    labels: string[];
    pairFolder?: boolean;
}

export function readAnswer(answers: Record<string, AskAnswer>): AssignAnswer {
    const pick = (itemId: string) => answers[itemId]?.selectedChoices ?? [];
    const typed = answers.project?.freeText?.trim();
    const chosen = pick("project")[0];
    const project = typed ? typed : chosen === "project:none" ? null : chosen?.replace(/^project:/, "");
    const calendar = pick("calendar")[0];
    const folder = pick("folder")[0];
    const labels = [
        ...pick("labels").map((id) => id.replace(/^label:/, "")),
        ...(answers.labels?.freeText ?? "")
            .split(",")
            .map((label) => label.trim())
            .filter((label) => label.length > 0),
    ];

    return {
        ...(project !== undefined ? { project } : {}),
        ...(calendar?.startsWith("calendar:") && calendar !== "calendar:none"
            ? { calendarIndex: Number(calendar.slice("calendar:".length)) }
            : {}),
        labels: mergeLabels([], labels),
        ...(folder ? { pairFolder: folder === "folder:yes" } : {}),
    };
}

function readOpen(store: MeetingStore): OpenSteps {
    const path = join(store.root, OPEN_FILE);

    if (!existsSync(path)) {
        return {};
    }

    const parsed = openSchema.safeParse(SafeJSON.parse(readFileSync(path, "utf8")));

    if (!parsed.success) {
        log.warn({ path, issues: parsed.error.issues.length }, "assign-open.json unreadable; starting empty");
        return {};
    }

    return parsed.data.open;
}

function writeOpen(store: MeetingStore, open: OpenSteps): void {
    atomicWriteFileSync(join(store.root, OPEN_FILE), SafeJSON.stringify({ open }, null, 2));
}

function setOpen(store: MeetingStore, meetingId: string, step: OpenSteps[string] | undefined): void {
    const open = readOpen(store);

    if (step) {
        open[meetingId] = step;
    } else {
        delete open[meetingId];
    }

    writeOpen(store, open);
}

/** Why a meeting is not asked about now; undefined when it should be. */
export function skipReason(record: MeetingRecord, store: MeetingStore, now: number): string | undefined {
    if (record.project) {
        return `has project ${record.project}`;
    }

    const ask = record.assign?.ask;

    if (ask && !(ask.outcome === "failed" && now - Date.parse(ask.askedAt) > RETRY_FAILED_MS)) {
        return `asked at ${ask.askedAt} (${ask.outcome})`;
    }

    if (!record.end && record.recording?.status !== "stopped") {
        return "not ended";
    }

    if (Object.keys(record.sources).length === 0 && !record.recording) {
        return "no source and no recording";
    }

    if (readAuto(store)?.meetingId === record.id) {
        return "the watcher still refreshes it from its source";
    }

    return undefined;
}

/**
 * Posts the one question of a meeting. The record claims the question first, under its lock, so two watchers never
 * ask twice; a failed post is marked and tried again after ten minutes. Returns the form id, or why it did not ask.
 */
export async function askMeeting(
    store: MeetingStore,
    record: MeetingRecord,
    deps: AssignDeps,
    options: { force?: boolean } = {}
): Promise<{ formId?: string; skipped?: string }> {
    const now = deps.now();
    const skipped = options.force ? undefined : skipReason(record, store, now);

    if (skipped) {
        return { skipped };
    }

    const config = await deps.config.read();
    const view = await viewProposals(store, record, deps);
    const formId = `meetings-assign-${record.id}-${now.toString(36)}`;
    let claimed = false;
    await store.update(record.id, { command: "assign ask", change: `asked for its project (${formId})` }, (current) => {
        if (!options.force && current.assign?.ask && current.assign.ask.outcome !== "failed") {
            return;
        }

        claimed = true;
        current.assign = {
            ...current.assign,
            ask: {
                formId,
                askedAt: new Date(now).toISOString(),
                outcome: "pending",
                proposals: view.proposals.projects.map((proposal) => ({
                    project: proposal.project,
                    score: proposal.score,
                    reasons: proposal.reasons.map(reasonText),
                })),
                calendars: view.proposals.calendars.map((candidate) => candidate.entry),
                ...(view.proposals.folder?.kind === "pair"
                    ? { folder: { source: view.proposals.folder.source, folder: view.proposals.folder.folder } }
                    : {}),
            },
        };
    });

    if (!claimed) {
        return { skipped: "another process asked first" };
    }

    try {
        await deps.inbox.post({ ...buildQuestion(view, config), id: formId, projectPath: store.folder(record.id) });
        setOpen(store, record.id, "ask");
        log.info({ meeting: record.id, formId, proposals: view.proposals.projects.length }, "asked for the project");
        return { formId };
    } catch (err) {
        log.warn({ err, meeting: record.id }, "posting the project question failed");
        await store.update(
            record.id,
            { command: "assign ask", change: "the question could not be posted" },
            (current) => {
                if (current.assign?.ask?.formId === formId) {
                    current.assign.ask.outcome = "failed";
                    current.assign.ask.error = err instanceof Error ? err.message : String(err);
                }
            }
        );
        return { skipped: `post failed: ${err instanceof Error ? err.message : err}` };
    }
}

/** What applying an answer changed, for messages and tests. */
export interface AppliedAnswer {
    project?: string;
    labels: string[];
    paired: string[];
    entry?: CalendarEntry;
    folderPaired?: string;
    waitsForFolder: boolean;
}

/**
 * Applies the owner's answer at once: the project (a new name joins the known ones), the labels (new ones join the
 * project's), the picked calendar entry (its attendees are paired with the project) and the folder pairing.
 */
export async function applyAnswer(options: {
    store: MeetingStore;
    record: MeetingRecord;
    answer: AssignAnswer;
    deps: AssignDeps;
    command?: string;
    /** The entries `answer.calendarIndex` points into; the question's own list by default. */
    entries?: CalendarEntry[];
}): Promise<AppliedAnswer> {
    const { store, record, answer, deps } = options;
    const command = options.command ?? "assign apply";
    const at = new Date(deps.now()).toISOString();
    const ask = record.assign?.ask;
    const project = answer.project ?? undefined;
    const entries = options.entries ?? ask?.calendars ?? [];
    const entry = answer.calendarIndex !== undefined ? entries[answer.calendarIndex] : undefined;
    const applied: AppliedAnswer = { labels: answer.labels, paired: [], waitsForFolder: false };

    if (project) {
        projectNameSchema.parse(project);
        await deps.config.addProject(project);
        applied.project = project;

        if (answer.labels.length > 0) {
            await deps.config.setProjectLabels(project, { add: answer.labels });
        }

        if (entry && entry.people.length > 0) {
            await deps.config.pairPeople({
                project,
                people: entry.people,
                by: {
                    kind: "calendar",
                    from: entry.from,
                    entryId: entry.entryId,
                    ...(entry.calendar ? { calendar: entry.calendar } : {}),
                    title: entry.title,
                    start: entry.start,
                    meetingId: record.id,
                    at,
                },
            });
            applied.paired = entry.people.filter((person) => !person.self).map((person) => person.name);
        }

        if (answer.pairFolder && ask?.folder && isMeetingSourceId(ask.folder.source)) {
            await deps.config.addSourceFolder(ask.folder.source, project, ask.folder.folder);
            applied.folderPaired = ask.folder.folder;
        }
    }

    const linked = project && !applied.folderPaired ? await deps.source(record).catch(() => undefined) : undefined;
    const inFolders = linked ? await linked.source.meetingFolders(linked.sourceMeetingId).catch(() => null) : null;
    applied.waitsForFolder = Boolean(linked && inFolders !== null && inFolders.length === 0);
    applied.entry = entry;
    const change = [
        project ? `project ${project}` : answer.project === null ? "no project" : "project unanswered",
        answer.labels.length > 0 ? `labels ${answer.labels.join(", ")}` : "",
        entry ? `calendar entry "${entry.title}", ${applied.paired.length} people paired` : "",
        applied.folderPaired ? `folder "${applied.folderPaired}" paired` : "",
    ]
        .filter(Boolean)
        .join("; ");

    await store.update(record.id, { command, change }, (current) => {
        if (project) {
            current.project = project;
        }

        current.labels = mergeLabels(current.labels, answer.labels);

        if (entry) {
            current.calendar = {
                from: entry.from,
                eventId: entry.entryId,
                ...(entry.calendar ? { calendar: entry.calendar } : {}),
                title: entry.title,
                start: entry.start,
                end: entry.end,
                attendees: entry.people.map((person) => person.name),
                people: entry.people,
                ...(entry.conferenceUrl ? { conferenceUrl: entry.conferenceUrl } : {}),
            };
        }

        if (current.assign?.ask) {
            current.assign.ask.outcome = "applied";
            current.assign.ask.answeredAt = at;
        }

        if (applied.waitsForFolder && linked && project) {
            current.assign = {
                ...current.assign,
                folder: { source: linked.source.id, project, state: "waiting", since: at },
            };
        }
    });

    setOpen(store, record.id, applied.waitsForFolder ? "folder-wait" : undefined);
    log.info({ meeting: record.id, project, labels: answer.labels, paired: applied.paired.length }, "answer applied");
    return applied;
}

/** One open step of one meeting: read the answer back, or look for the meeting in a source folder. */
async function advance(
    store: MeetingStore,
    meetingId: string,
    step: OpenSteps[string],
    deps: AssignDeps
): Promise<string> {
    const record = store.read(meetingId);

    if (!record) {
        setOpen(store, meetingId, undefined);
        return "gone";
    }

    if (step === "ask") {
        return advanceAsk(store, record, deps);
    }

    return advanceFolder(store, record, step, deps);
}

async function advanceAsk(store: MeetingStore, record: MeetingRecord, deps: AssignDeps): Promise<string> {
    const ask = record.assign?.ask;

    if (ask?.outcome !== "pending") {
        setOpen(store, record.id, undefined);
        return "closed";
    }

    if (record.project) {
        // A person set the project another way; the question is moot.
        await deps.inbox.cancel(ask.formId).catch((err: unknown) => log.warn({ err }, "cancel failed"));
        await store.update(
            record.id,
            { command: "assign sweep", change: "question withdrawn: project set" },
            (current) => {
                if (current.assign?.ask) {
                    current.assign.ask.outcome = "cancelled";
                }
            }
        );
        setOpen(store, record.id, undefined);
        return "withdrawn";
    }

    const form = await deps.inbox.read(ask.formId);

    if (!form || form.status === "pending") {
        return form ? "pending" : "missing";
    }

    if (form.status === "answered") {
        await applyAnswer({ store, record, answer: readAnswer(form.answers), deps, command: "assign answer" });
        return "applied";
    }

    await store.update(record.id, { command: "assign sweep", change: `question ${form.status}` }, (current) => {
        if (current.assign?.ask) {
            current.assign.ask.outcome = form.status === "timeout" ? "timeout" : "cancelled";
        }
    });
    setOpen(store, record.id, undefined);
    return form.status;
}

async function advanceFolder(
    store: MeetingStore,
    record: MeetingRecord,
    step: "folder-wait" | "folder-ask",
    deps: AssignDeps
): Promise<string> {
    const folder = record.assign?.folder;

    if (!folder || !isMeetingSourceId(folder.source)) {
        setOpen(store, record.id, undefined);
        return "closed";
    }

    if (step === "folder-ask") {
        const form = folder.formId ? await deps.inbox.read(folder.formId) : null;

        if (form?.status === "pending") {
            return "pending";
        }

        const yes = form?.status === "answered" && form.answers.folder?.selectedChoices?.[0] === "folder:yes";

        if (yes && folder.folder) {
            await deps.config.addSourceFolder(folder.source, folder.project, folder.folder);
        }

        await store.update(
            record.id,
            { command: "assign sweep", change: `folder ${yes ? "paired" : "not paired"}` },
            (current) => {
                if (current.assign?.folder) {
                    current.assign.folder.state = yes ? "paired" : "declined";
                }
            }
        );
        setOpen(store, record.id, undefined);
        return yes ? "folder paired" : "folder declined";
    }

    if (deps.now() - Date.parse(folder.since) > FOLDER_WAIT_MS) {
        setOpen(store, record.id, undefined);
        return "folder wait expired";
    }

    const linked = await deps.source(record).catch(() => undefined);
    const folders = linked ? await linked.source.meetingFolders(linked.sourceMeetingId) : null;

    if (!folders || folders.length === 0) {
        return "waiting";
    }

    const config = await deps.config.read();
    const paired = config.sources[folder.source].match[folder.project]?.folders ?? [];
    const known = folders.find((name) => paired.some((one) => one.toLowerCase() === name.toLowerCase()));

    if (known) {
        await store.update(record.id, { command: "assign sweep", change: `in paired folder "${known}"` }, (current) => {
            if (current.assign?.folder) {
                current.assign.folder.state = "paired";
                current.assign.folder.folder = known;
            }
        });
        setOpen(store, record.id, undefined);
        return "in paired folder";
    }

    const found = folders[0]!;
    const formId = `meetings-folder-${record.id}-${deps.now().toString(36)}`;
    await deps.inbox.post({
        id: formId,
        source: "meetings",
        projectPath: store.folder(record.id),
        items: [
            {
                id: "folder",
                promptMarkdown:
                    `**The meeting "${record.title}" (${folder.project}) is now in the ${folder.source} folder ` +
                    `"${found}".** Pair that folder with ${folder.project}, so later meetings in it go there without a question?`,
                choices: [
                    { id: "folder:yes", label: `Yes, pair "${found}" with ${folder.project}` },
                    { id: "folder:no", label: "No" },
                ],
            },
        ],
    });
    await store.update(record.id, { command: "assign sweep", change: `asked to pair folder "${found}"` }, (current) => {
        if (current.assign?.folder) {
            current.assign.folder.state = "asked";
            current.assign.folder.folder = found;
            current.assign.folder.formId = formId;
        }
    });
    setOpen(store, record.id, "folder-ask");
    return "folder asked";
}

/** Meeting ids carry their local start (`2026-11-04_15-08-…`): the folders that started after `since`. */
export function recentMeetingIds(store: MeetingStore, since: number): string[] {
    if (!existsSync(store.root)) {
        return [];
    }

    return readdirSync(store.root).filter((name) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(name);

        if (!match) {
            return false;
        }

        const [, y, mo, d, h, mi] = match.map(Number);
        return new Date(y!, mo! - 1, d, h, mi).getTime() >= since;
    });
}

export interface SweepResult {
    asked: string[];
    advanced: Array<{ meeting: string; outcome: string }>;
}

/**
 * One pass of "ask each time": read back every open question and folder step, then ask about each recent meeting
 * that ended with no project. Runs on each watcher look and as `tools meetings assign sweep`. Never throws for one
 * meeting: a failure is logged and the next look tries again.
 */
export async function assignSweep(store: MeetingStore, deps: AssignDeps = defaultAssignDeps()): Promise<SweepResult> {
    const result: SweepResult = { asked: [], advanced: [] };

    for (const [meetingId, step] of Object.entries(readOpen(store))) {
        try {
            const outcome = await advance(store, meetingId, step, deps);

            if (outcome !== "pending" && outcome !== "waiting") {
                result.advanced.push({ meeting: meetingId, outcome });
            }
        } catch (err) {
            log.warn({ err, meeting: meetingId, step }, "assign step failed");
        }
    }

    const config = await deps.config.read();

    if (!config.global.assign.ask) {
        return result;
    }

    const now = deps.now();

    for (const id of recentMeetingIds(store, now - config.global.assign.lookbackHours * 3_600_000)) {
        const record = store.read(id);

        if (!record || skipReason(record, store, now)) {
            continue;
        }

        try {
            const asked = await askMeeting(store, record, deps);

            if (asked.formId) {
                result.asked.push(id);
            }
        } catch (err) {
            log.warn({ err, meeting: id }, "asking for the project failed");
        }
    }

    return result;
}
