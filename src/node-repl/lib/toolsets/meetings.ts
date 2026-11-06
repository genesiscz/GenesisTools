import { prepareFindings } from "@app/meetings/lib/add-findings";
import { captureCost } from "@app/meetings/lib/capture-cost";
import { configValueAt, parseConfigPath, setConfigValue } from "@app/meetings/lib/config-edit";
import { decideItems, reopenItems } from "@app/meetings/lib/decide";
import { testPhrase } from "@app/meetings/lib/dictionary-test";
import { FINDING_KINDS, findingSchema } from "@app/meetings/lib/findings";
import { itemWhat } from "@app/meetings/lib/item-text";
import { matchDraftSchema, matchPreview } from "@app/meetings/lib/match-preview";
import { projectLabels, setMeetingFields } from "@app/meetings/lib/meeting-fields";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { meetingsOverview } from "@app/meetings/lib/overview";
import { questionLabel } from "@app/meetings/lib/questions";
import { meetingLiveId } from "@app/meetings/lib/recorder-shared";

import { isSuggestRule, SUGGEST_RULES } from "@app/meetings/lib/suggest";
import { runSuggest } from "@app/meetings/lib/suggest-run";
import { correctTranscript, outcomeText } from "@app/meetings/lib/transcript-corrections";
import { assertReach, defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { OCR_BOX_LEVELS } from "@genesiscz/utils/macos/ocr-boxes";
import { EXPORT_IF_EDITED, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import { ITEM_STATUSES, type MeetingItem, type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import {
    RECORDER_SET_SETTINGS_DOC,
    RECORDER_SETTINGS_DOC,
    recorderSetSchema,
    settingsPatchOf,
} from "@genesiscz/utils/repl/toolsets/recorder";
import { callRecorder, readLiveRecording } from "@genesiscz/utils/screen-recorder/live";
import { parseClock } from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

const { log } = logger.scoped("meetings-toolset");
// lazy: saves 13.8 ms cold import (tools ts imports lazy, 2026-11-05) — calendar assignment loads on its first call
const loadAssign = () => import("@app/meetings/lib/assign");

const ref = z.object({ ref: z.string().min(1) });
const ids = z.array(z.string().min(1));
const recordDoc =
    "{ id, title, start, project, labels, sources, speakers, items: { suggested, confirmed, rejected }, summary }";

const list = defineMethod({
    name: "list",
    params: z.object({ project: z.string().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, title, start, seconds, project, items, open }[]",
    effect: "read",
    doc: "The stored meetings, newest first, optionally of one project. `seconds` is the meeting's length (null while it has no end); `open` counts the suggested items nobody decided yet.",
});
const open = defineMethod({
    name: "open",
    params: ref,
    positional: ["ref"],
    result: z.unknown(),
    resultName: "Meeting",
    effect: "read",
    doc: 'Open a stored meeting by id, a unique prefix, "last", or wisprflow:<id>. meetings.open("last").',
});
const info = defineMethod({
    name: "info",
    params: z.object({}),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "read",
    doc: "The meeting as it is saved now: title, project, sources, speaker renames, item counts and a one-line summary.",
});
const evidence = defineMethod({
    name: "evidence",
    params: z.object({}),
    result: z.unknown(),
    effect: "read",
    doc: "Which voice each label's lines are, by audio channel and the platform's speaking indicator.",
});
const transcript = defineMethod({
    name: "transcript",
    params: z.object({}),
    result: z.unknown(),
    effect: "read",
    doc: "The linked source transcript as recorded, before any correction. lines() is the corrected one.",
});
const lines = defineMethod({
    name: "lines",
    params: z.object({ withSuggested: z.boolean().optional(), dictionary: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ lines: { at, speaker, text }[], speakers, unattributed, notApplied }",
    effect: "read",
    doc: "The transcript with the speaker renames, the confirmed items and the dictionary applied, as the transcript command prints it. withSuggested: true also applies the suggested items (a preview); dictionary: false leaves the dictionary out. `notApplied` names each correction that found no line.",
});
const itemsList = defineMethod({
    name: "items.list",
    // An enum, as the CLI's --kind: a misspelt kind answered no rows (R2-MC11).
    params: z.object({ status: z.enum(ITEM_STATUSES).optional(), kind: z.enum(FINDING_KINDS).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, question?, kind, status, confidence, what, rules }[]",
    effect: "read",
    doc: 'The meeting\'s items, optionally of one status ("suggested", "confirmed", "rejected") or kind ("speaker-range", "term", "question", "join", "label"). `what` is the one-line text the items command shows.',
});
const add = defineMethod({
    name: "items.add",
    params: z.object({ findings: z.array(findingSchema).min(1) }),
    result: z.unknown(),
    resultName: "{ added: items.list rows, warnings }",
    effect: "reversible",
    doc: "Add validated findings under the meeting store lock; answers the items it added (as items.list rows) and the warnings, never the whole meeting.",
});
const suggest = defineMethod({
    name: "items.suggest",
    params: z.object({ rules: z.array(z.string()).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ fresh: items.list rows, warnings }",
    effect: "reversible",
    doc: `Run the rules on the transcript and add what they find as suggested items, in one save. rules: any of ${SUGGEST_RULES.join(", ")} (default all). A word check that cannot run is a warning.`,
});
const decide = {
    result: z.unknown(),
    resultName: "{ decided: string[], skipped: { id, reason, needs }[], token }",
    effect: "reversible" as const,
};
const rejectParams = z.object({ ids: ids.optional(), minConfidence: z.number().min(0).max(1).optional() }).strict();
const confirm = defineMethod({
    name: "items.confirm",
    ...decide,
    // Only a confirm keeps a value; reject has its own schema, as in the CLI, so it refuses them (R2-MC12).
    params: rejectParams.extend({ speaker: z.string().optional(), proposed: z.string().optional() }).strict(),
    doc:
        'Confirm items (ids "i3", or a question\'s number "Q2"), or every suggested item at or above minConfidence (0..1). Transcripts apply confirmed items. A range nobody named needs `speaker`, a term with no spelling needs `proposed`; a question is answered by ear (' +
        toolCommand("meetings listen") +
        "). Those come back in `skipped` with the reason and what they need. `token` undoes it with items.reopen.",
});
const reject = defineMethod({
    name: "items.reject",
    ...decide,
    params: rejectParams,
    doc: "Reject items by id, or every suggested item at or above minConfidence: they are never suggested again. `token` undoes it with items.reopen.",
});
const reopen = defineMethod({
    name: "items.reopen",
    params: z.object({ ids: ids.min(1), token: z.string().min(1).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ reopened: string[], skipped: { id, reason }[] }",
    effect: "reversible",
    doc: "Undo a confirm or a reject: each item gets back what the decision changed. Pass the `token` the decision answered; an item decided again since is refused, and nothing is reopened (NR20).",
});
const speakers = defineMethod({
    name: "speakers.stats",
    params: z.object({ gapSeconds: z.number().positive().optional() }).strict(),
    result: z.unknown(),
    effect: "read",
    doc: `Each speaker label's statistics: lines, talk time and spans (a gap of gapSeconds, ${DEFAULT_SPAN_GAP_SEC} by default, starts a new span), with who was present.`,
});
const rename = defineMethod({
    name: "speakers.rename",
    params: z.object({ label: z.string().min(1), name: z.string().min(1) }).strict(),
    positional: ["label", "name"],
    result: z.unknown(),
    resultName: recordDoc,
    effect: "reversible",
    doc: 'Name a speaker label ("Speaker 2" → "Alice"): this meeting\'s transcripts use the name from now on. A label the linked transcript does not have is refused, with the labels it has.',
});
const set = defineMethod({
    name: "set",
    params: z
        .object({
            title: z.string().min(1).optional(),
            project: z.string().min(1).optional(),
            labels: z.array(z.string().min(1)).optional(),
            unlabel: z.array(z.string().min(1)).optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "reversible",
    doc: "Change the meeting's title, project and labels (a new project name joins the known projects; a new label joins the project's labels). unlabel removes labels.",
});

const person = z.object({ name: z.string().min(1), email: z.string().min(1).optional() });
const projectsLabels = defineMethod({
    name: "projects.labels",
    params: z
        .object({
            project: z.string().min(1),
            add: z.array(z.string()).optional(),
            remove: z.array(z.string()).optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "string[]",
    effect: "reversible",
    doc: 'A project\'s known labels; add and remove change them. A project nobody knows is refused, unless add makes it. meetings.projects.labels({ project: "shop", add: ["Checkout 2.0"] }).',
});
const projectsPair = defineMethod({
    name: "projects.pair",
    params: z
        .object({ project: z.string().min(1), people: z.array(person).min(1), note: z.string().optional() })
        .strict(),
    result: z.unknown(),
    resultName: "{ project, people }",
    effect: "reversible",
    doc: "Pair people with a project by hand (pairedBy manual). A later meeting with them proposes the project. One person can be in several projects.",
});
const projectsUnpair = defineMethod({
    name: "projects.unpair",
    params: z
        .object({
            entryId: z.string().min(1).optional(),
            project: z.string().min(1).optional(),
            person: person.optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ project, name, email?, left }[] | { removed: boolean }",
    effect: "reversible",
    doc: "With entryId: remove the pairings that calendar entry made, in every project; a person another source still pairs stays. With project and person: remove that person from the project.",
});
const projectsPeople = defineMethod({
    name: "projects.people",
    params: z.object({ project: z.string().min(1).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ project, name, email?, pairedBy }[]",
    effect: "read",
    doc: "The people paired with each project, each with its sources (pairedBy: calendar entries and manual pairings).",
});
const assignSweepMethod = defineMethod({
    name: "assign.sweep",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ asked: string[], advanced: { meeting, outcome }[] }",
    effect: "reversible",
    reaches: ["user"],
    doc: 'One "ask each time" pass, as the watcher runs it: read back answers and apply them, then post a decision-inbox question for each recent ended meeting without a project.',
});
const assignProposals = defineMethod({
    name: "assign.proposals",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ proposals: { projects, labels, calendars, folder }, calendarNotes, skipped }",
    effect: "read",
    doc: "The ranked project proposals of this meeting, each with its reasons (folder rule, calendar name, title rule, paired people of an overlapping entry, title words of earlier meetings), the overlapping calendar entries, label proposals and the Wispr folder step. calendarNotes names each calendar that could not be read.",
});
const assignAsk = defineMethod({
    name: "assign.ask",
    params: z.object({ force: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ formId?, skipped? }",
    effect: "reversible",
    reaches: ["user"],
    doc: "Post this meeting's project question to the decision inbox now (once per meeting; force asks again).",
});
const assignApply = defineMethod({
    name: "assign.apply",
    params: z
        .object({
            project: z.string().min(1).nullable(),
            labels: z.array(z.string().min(1)).optional(),
            entryId: z.string().min(1).optional(),
            pairFolder: z.boolean().optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ project?, labels, paired, entry?, folderPaired?, waitsForFolder }",
    effect: "reversible",
    doc: "Apply an answer without the inbox: the project (null: none), labels, the overlapping calendar entry whose attendees get paired with the project, and whether to pair the source folder the meeting is in.",
});

const overview = defineMethod({
    name: "overview",
    params: z.object({ days: z.number().positive().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ meetings: { id, title, day, project, badges }[], projects, needsYou }",
    effect: "read",
    doc: "The meetings of the last days (default 14) by day, each with its badges (no project, open questions, unclear speakers, recording only, transcript only, suggestions ready to confirm), and the meetings that wait for a person.",
});
const projectsPreview = defineMethod({
    name: "projects.preview",
    params: z.object({ draft: matchDraftSchema.optional(), limit: z.number().int().positive().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, title, project?, now: string[], draft: string[], changed }[]",
    effect: "read",
    doc: 'Which project each recent meeting matches by the saved rules, and with draft rules: { draft: { work: { titleWords: ["sync"], calendars: [], folders: { wisprflow: [] } } } }.',
});
const dictionaryTest = defineMethod({
    name: "dictionary.test",
    params: z.object({ phrase: z.string().min(1), project: z.string().min(1).optional() }).strict(),
    positional: ["phrase"],
    result: z.unknown(),
    resultName: "{ text, fired: DictionaryEntry[], suggestions, counts }",
    effect: "read",
    doc: "What the dictionary (global, then the project) does to one phrase, and which entries fired.",
});
const configGet = defineMethod({
    name: "config.get",
    params: z.object({ path: z.string().min(1).optional() }).strict(),
    positional: ["path"],
    result: z.unknown(),
    effect: "read",
    doc: 'The meetings settings with their defaults, or the value at one path ("global.capture.activeFps", or a JSON array of keys).',
});
const configSet = defineMethod({
    name: "config.set",
    params: z.object({ path: z.string().min(1), value: z.unknown() }).strict(),
    positional: ["path", "value"],
    result: z.unknown(),
    effect: "reversible",
    doc: "Write one meetings setting; the whole config is validated first and nothing is written when it fails.",
});
const captureCostMethod = defineMethod({
    name: "captureCost",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ keptFrameCpuMs, observed?, displays, activeFps, idleFps, threshold }",
    effect: "read",
    doc: "The CPU each capture choice costs: the bench's cost per kept frame and the newest real recording's frame rate.",
});
const screenTimelineMethod = defineMethod({
    name: "screenTimeline",
    params: z.object({ all: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ displays, frames: { file, path, meetingSec, displayId, changed: OcrBox[] }[] }",
    effect: "read",
    doc: "Every frame of the screen recording in time order with the OCR lines that changed since the display's earlier frame (all: every line too).",
});
const exportMethod = defineMethod({
    name: "export",
    params: z
        .object({
            to: z.string().min(1).optional(),
            dryRun: z.boolean().optional(),
            ifEdited: z.enum(EXPORT_IF_EDITED).optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ path, folder, bytes, action, replaced, kept?, written }",
    effect: "reversible",
    doc: "Write the polished transcript (play links, dictionary, confirmed items) into the project's export folder, or into the folder `to` (a folder, never a file name: the file is written inside it). An edited note is kept: ifEdited beside (the config's default), refuse or replace.",
});

const recordingSettings = defineMethod({
    name: "settings",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ settings, audio }",
    effect: "read",
    doc: `${RECORDER_SETTINGS_DOC} Only while this meeting is being recorded.`,
});
const setRecordingSettings = defineMethod({
    name: "setSettings",
    params: recorderSetSchema,
    result: z.unknown(),
    resultName: "{ settings, audio, applied }",
    effect: "reversible",
    doc: `${RECORDER_SET_SETTINGS_DOC} Only while this meeting is being recorded.`,
});
const recordingMark = defineMethod({
    name: "mark",
    params: z.object({ label: z.string().min(1).max(80) }),
    positional: ["label"],
    result: z.unknown(),
    resultName: "{ atMs, label }",
    effect: "reversible",
    doc: 'Marks this moment of the screen recording with a label ("demo starts"); the meeting\'s editor project lists it at its time in the movie. Only while this meeting is being recorded.',
});
const screen = defineMethod({
    name: "screen",
    params: z
        .object({
            /** A transcript time: seconds, or "1:23:50" / "23:50". */
            at: z.union([z.number().nonnegative(), z.string().min(1)]).optional(),
            windowSec: z.number().positive().optional(),
            match: z.string().min(1).optional(),
            limit: z.number().int().positive().optional(),
            boxes: z
                .object({
                    level: z.enum(OCR_BOX_LEVELS).optional(),
                    outDir: z.string().min(1),
                    pad: z.number().int().nonnegative().optional(),
                    maxCrops: z.number().int().positive().optional(),
                })
                .strict()
                .optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName:
        "{ zeroMs, recorded, frames: { file, at, displayId, text, meetingSec }[], boxes?: { file, selection, boxes: { text, x, y, width, height }[], annotated, crops }[] }",
    effect: "reversible",
    doc: 'The screen frames at a transcript time (at, windowSec) or that show a text (match, limit), from the recording\'s ocr.jsonl. With boxes: { outDir }, each frame\'s OCR boxes in frame pixels (level "block" default, or "line"): the ones holding match, or without match the ones that changed since the display\'s earlier frame, drawn numbered on the frame plus one PNG crop each in outDir.',
});
const editorProject = defineMethod({
    name: "editorProject",
    params: z
        .object({
            /** "most-change" (default) or a display id. */
            display: z.union([z.literal("most-change"), z.number().int().nonnegative()]).optional(),
            windowSec: z.number().positive().optional(),
            /** Ranges in recording seconds that show a given display whatever the policy picks. */
            switches: z
                .array(
                    z.object({ from: z.number().nonnegative(), to: z.number().positive(), display: z.number().int() })
                )
                .optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ folder, proxy: { path, frames, plan }, transcript, captions }",
    effect: "reversible",
    doc: "Makes the meeting's screen recording an editor project in its folder: recording.json, proxy.mp4 (per 10 s window the display that changed most, or one display) and proxy.transcript.json, the transcript as captions with the speakers' names. Then movies.open(folder) edits it, and its findOnScreen(text) searches the OCR.",
});

/** The meeting as an agent reads it: the record's facts, the item counts and a one-line summary. */
function describe(record: MeetingRecord) {
    const count = (status: MeetingItem["status"]) => record.items.filter((item) => item.status === status).length;
    const items = { suggested: count("suggested"), confirmed: count("confirmed"), rejected: count("rejected") };
    const renamed = Object.keys(record.speakers.labels).length;
    return {
        id: record.id,
        title: record.title,
        start: record.start,
        project: record.project ?? null,
        labels: record.labels,
        sources: Object.keys(record.sources),
        speakers: record.speakers.labels,
        items,
        summary: `"${record.title || "Untitled meeting"}"${record.project ? ` (${record.project})` : ""}: ${record.items.length} items (${items.suggested} open, ${items.confirmed} confirmed), ${renamed} speaker${renamed === 1 ? "" : "s"} named, sources ${Object.keys(record.sources).join(", ") || "none"}`,
    };
}

function itemRow(record: MeetingRecord, item: MeetingItem) {
    return {
        id: item.id,
        ...(item.kind === "question" ? { question: questionLabel(record, item.id) } : {}),
        kind: item.kind,
        status: item.status,
        confidence: item.confidence ?? null,
        what: itemWhat(item),
        rules: item.rules,
    };
}

export class MeetingsToolset extends ReplToolset {
    readonly api = defineApi({
        id: "meetings",
        global: "meetings",
        title: "Meetings",
        summary:
            "List and open meetings; read their corrected transcript, evidence and items; suggest, confirm and reject items; name speakers.",
        methods: [
            list,
            open,
            overview,
            projectsLabels,
            projectsPair,
            projectsUnpair,
            projectsPeople,
            projectsPreview,
            dictionaryTest,
            configGet,
            configSet,
            captureCostMethod,
            assignSweepMethod,
        ],
        handles: [
            {
                name: "Meeting",
                summary: "An opened meeting; `id` and `title` name it. Every call reads the meeting as saved now.",
                methods: [
                    info,
                    lines,
                    transcript,
                    evidence,
                    itemsList,
                    add,
                    suggest,
                    confirm,
                    reject,
                    reopen,
                    speakers,
                    rename,
                    set,
                    recordingSettings,
                    setRecordingSettings,
                    recordingMark,
                    screen,
                    editorProject,
                    screenTimelineMethod,
                    exportMethod,
                    assignProposals,
                    assignAsk,
                    assignApply,
                ],
            },
        ],
    });

    async bootstrap(): Promise<Record<string, unknown>> {
        const store = new MeetingStore();
        return {
            meetings: {
                list: (input: z.input<typeof list.params> = {}) => {
                    const { project } = list.params.parse(input);
                    return store
                        .list()
                        .filter((record) => !project || record.project === project)
                        .map((record) => ({
                            id: record.id,
                            title: record.title,
                            start: record.start,
                            // An agent that wants a short meeting had to open each one (NR33).
                            seconds: record.end
                                ? Math.round((Date.parse(record.end) - Date.parse(record.start)) / 1000)
                                : null,
                            project: record.project ?? null,
                            items: record.items.length,
                            open: record.items.filter((item) => item.status === "suggested").length,
                        }));
                },
                open: (refText: string) => this.meeting(store, ref.parse({ ref: refText }).ref),
                overview: async (input: z.input<typeof overview.params> = {}) => {
                    const { days } = overview.params.parse(input);
                    return meetingsOverview({
                        records: store.list(),
                        config: await new MeetingsConfigStore().read(),
                        now: new Date(),
                        days: days ?? 14,
                    });
                },
                dictionary: {
                    test: async (phrase: string, input: { project?: string } = {}) => {
                        const parsed = dictionaryTest.params.parse({ phrase, ...input });
                        return testPhrase(await new MeetingsConfigStore().read(), parsed);
                    },
                },
                config: {
                    get: async (path?: string) => {
                        const parsed = configGet.params.parse(path === undefined ? {} : { path });
                        const config = await new MeetingsConfigStore().read();

                        if (!parsed.path) {
                            return config;
                        }

                        const value = configValueAt(config, parseConfigPath(parsed.path));

                        // An unknown path printed nothing, the same as a value it could not find (NR20).
                        if (value === undefined) {
                            throw new Error(
                                `"${parsed.path}" is not set and has no default; config.get() shows every setting with its default`
                            );
                        }

                        return value;
                    },
                    set: async (path: string, value: unknown) => {
                        const parsed = configSet.params.parse({ path, value });
                        const config = await setConfigValue(new MeetingsConfigStore(), parsed.path, parsed.value);
                        return configValueAt(config, parseConfigPath(parsed.path));
                    },
                },
                captureCost: async () =>
                    captureCost({ store, records: store.list(), config: await new MeetingsConfigStore().read() }),
                projects: {
                    preview: async (input: z.input<typeof projectsPreview.params> = {}) => {
                        const parsed = projectsPreview.params.parse(input);
                        return matchPreview({
                            records: store.list(),
                            config: await new MeetingsConfigStore().read(),
                            ...(parsed.draft ? { draft: parsed.draft } : {}),
                            limit: parsed.limit ?? 20,
                        });
                    },
                    // The CLI's lookup: a project nobody knows is refused, not answered with no labels (R2-MC10).
                    labels: async (input: z.input<typeof projectsLabels.params>) =>
                        projectLabels({ config: new MeetingsConfigStore(), ...projectsLabels.params.parse(input) }),
                    pair: async (input: z.input<typeof projectsPair.params>) => {
                        const parsed = projectsPair.params.parse(input);
                        const config = await new MeetingsConfigStore().pairPeople({
                            project: parsed.project,
                            people: parsed.people,
                            by: {
                                kind: "manual",
                                at: new Date().toISOString(),
                                ...(parsed.note ? { note: parsed.note } : {}),
                            },
                        });
                        return {
                            project: parsed.project,
                            people: config.projects[parsed.project]?.match?.people ?? [],
                        };
                    },
                    unpair: async (input: z.input<typeof projectsUnpair.params>) => {
                        const parsed = projectsUnpair.params.parse(input);
                        const config = new MeetingsConfigStore();

                        if (parsed.entryId) {
                            return config.unpairEntry(parsed.entryId);
                        }

                        if (!parsed.project || !parsed.person) {
                            throw new Error("Give entryId, or project and person");
                        }

                        return { removed: await config.unpairPerson(parsed.project, parsed.person) };
                    },
                    people: async (input: z.input<typeof projectsPeople.params> = {}) => {
                        const { project } = projectsPeople.params.parse(input);
                        const config = await new MeetingsConfigStore().read();
                        return Object.entries(config.projects)
                            .filter(([name]) => !project || name === project)
                            .flatMap(([name, settings]) =>
                                (settings.match?.people ?? []).map((one) => ({ project: name, ...one }))
                            );
                    },
                },
                assign: {
                    sweep: async () => {
                        assertReach("user", "post questions to the decision inbox");
                        return (await loadAssign()).assignSweep(store);
                    },
                },
            },
        };
    }

    private meeting(store: MeetingStore, refText: string) {
        const found = store.resolve(refText);

        if (!found) {
            throw new Error(`No meeting "${refText}". meetings.list() names them.`);
        }

        const id = found.id;
        // Every call reads the saved record again, so a CLI or window change in between is seen.
        const current = (): MeetingRecord => {
            const record = store.read(id);

            if (!record) {
                throw new Error(`The meeting ${id} is gone from the store`);
            }

            return record;
        };
        const opened = () => OpenedMeeting.of(store, current());
        const liveId = meetingLiveId(id);
        const callLive = (method: "settings.get" | "settings.set" | "marker.add", params?: unknown) => {
            if (!readLiveRecording(liveId)) {
                throw new Error(`The meeting ${id} is not being recorded now (no live recording ${liveId})`);
            }

            return callRecorder({ id: liveId, method, params });
        };
        const decideWith = (status: "confirmed" | "rejected") => async (input: z.input<typeof confirm.params>) => {
            const options = (status === "confirmed" ? confirm : reject).params.parse(input);
            const result = await decideItems({ store, record: current(), status, ids: options.ids ?? [], ...options });
            log.info(
                { meeting: id, status, decided: result.decided.length, skipped: result.skipped.length },
                "items decided"
            );
            return result;
        };

        return {
            id,
            get title() {
                return current().title;
            },
            // Read again on each access, so the findings items.add stores show at once.
            get record() {
                return current();
            },
            info: () => describe(current()),
            evidence: () => opened().evidence(),
            transcript: async () => (await opened().meeting()).transcript,
            lines: async (input: z.input<typeof lines.params> = {}) => {
                const options = lines.params.parse(input);
                const record = current();
                const meeting = await opened().meeting();
                const config = await new MeetingsConfigStore().read();
                const applied = correctTranscript({
                    ...options,
                    record,
                    transcript: meeting.transcript,
                    config,
                    format: "json",
                });
                return {
                    lines: applied.entries.map((entry) => ({
                        at: entry.startSec ?? null,
                        speaker: entry.speaker,
                        text: entry.text,
                    })),
                    speakers: applied.speakers,
                    unattributed: applied.unattributed,
                    notApplied: applied.outcomes.map(outcomeText).filter((text): text is string => Boolean(text)),
                };
            },
            items: {
                list: (input: z.input<typeof itemsList.params> = {}) => {
                    const { status, kind } = itemsList.params.parse(input);
                    const record = current();
                    return record.items
                        .filter((item) => (!status || item.status === status) && (!kind || item.kind === kind))
                        .map((item) => itemRow(record, item));
                },
                add: async (input: z.input<typeof add.params>) => {
                    const { findings } = add.params.parse(input);
                    // The same anchors as `items add`; with no transcript at hand, the items are added as given.
                    const source = await opened()
                        .meeting()
                        .catch((error: unknown) => {
                            log.debug({ error, meeting: id }, "no transcript to check the finding anchors against");
                            return undefined;
                        });
                    // NR5 (2026-11-06): this answered the whole meeting record, 88 KB with the calendar attendees.
                    let added: MeetingItem[] = [];
                    let warnings: string[] = [];
                    const record = await store.update(
                        id,
                        { command: "items add", change: `${findings.length} findings` },
                        (current) => {
                            const prepared = prepareFindings({
                                findings,
                                items: current.items,
                                transcript: source?.transcript,
                            });

                            for (const warning of prepared.warnings) {
                                log.warn({ meeting: id }, warning);
                            }

                            current.items.push(...prepared.added);
                            added = prepared.added;
                            warnings = prepared.warnings;
                        }
                    );
                    return { added: added.map((item) => itemRow(record, item)), warnings };
                },
                suggest: async (input: z.input<typeof suggest.params> = {}) => {
                    const asked = suggest.params.parse(input).rules ?? [...SUGGEST_RULES];
                    const unknown = asked.filter((rule) => !isSuggestRule(rule));

                    if (unknown.length > 0) {
                        throw new Error(`Unknown rule set ${unknown.join(", ")}. Known: ${SUGGEST_RULES.join(", ")}`);
                    }

                    const { fresh, warnings } = await runSuggest({
                        store,
                        record: current(),
                        rules: asked.filter(isSuggestRule),
                    });
                    const record = current();
                    return { fresh: fresh.map((item) => itemRow(record, item)), warnings };
                },
                confirm: decideWith("confirmed"),
                reject: decideWith("rejected"),
                reopen: async (input: z.input<typeof reopen.params>) => {
                    const options = reopen.params.parse(input);
                    const result = await reopenItems({ store, record: current(), ...options });
                    log.info({ meeting: id, reopened: result.reopened.length }, "items reopened");
                    return result;
                },
            },
            speakers: {
                stats: async (input: z.input<typeof speakers.params> = {}) => {
                    const { gapSeconds } = speakers.params.parse(input);
                    const meeting = await opened().meeting();
                    return speakerStats(meeting.transcript, {
                        gapSec: gapSeconds ?? DEFAULT_SPAN_GAP_SEC,
                        participants: meeting.speakers,
                        presence: await opened().presence(),
                    });
                },
                rename: async (label: string, name: string) => {
                    const parsed = rename.params.parse({ label, name });
                    // A label the transcript does not have was stored as a rename of nobody (NR20).
                    const transcript = await opened()
                        .meeting()
                        .then((meeting) => meeting.transcript)
                        .catch((error: unknown) => {
                            log.debug({ error, meeting: id }, "no transcript to check the speaker label against");
                            return undefined;
                        });
                    const labels = [
                        ...new Set(transcript?.flatMap((entry) => (entry.speaker ? [entry.speaker] : [])) ?? []),
                    ];

                    if (transcript && !labels.includes(parsed.label)) {
                        throw new Error(
                            `the transcript has no speaker label "${parsed.label}"; its labels: ${labels.join(", ") || "none"}`
                        );
                    }

                    return describe(await store.renameSpeaker(id, parsed.label, parsed.name));
                },
            },
            assign: {
                proposals: async () => {
                    const { defaultAssignDeps, skipReason, viewProposals } = await loadAssign();
                    const deps = defaultAssignDeps();
                    const record = current();
                    const view = await viewProposals(store, record, deps);
                    const { assign } = (await deps.config.read()).global;
                    return {
                        proposals: view.proposals,
                        calendarNotes: view.calendarNotes,
                        skipped:
                            skipReason({ record, store, now: deps.now(), retryFailedMin: assign.retryFailedMin }) ??
                            null,
                    };
                },
                ask: async (input: z.input<typeof assignAsk.params> = {}) => {
                    assertReach("user", "post a question to the decision inbox");
                    const { askMeeting, defaultAssignDeps } = await loadAssign();
                    return askMeeting(store, current(), defaultAssignDeps(), assignAsk.params.parse(input));
                },
                apply: async (input: z.input<typeof assignApply.params>) => {
                    const parsed = assignApply.params.parse(input);
                    const { applyAnswer, defaultAssignDeps, viewProposals } = await loadAssign();
                    const deps = defaultAssignDeps();
                    const record = current();
                    const entries =
                        record.assign?.ask?.calendars ??
                        (await viewProposals(store, record, deps)).proposals.calendars.map((one) => one.entry);
                    const calendarIndex = parsed.entryId
                        ? entries.findIndex((entry) => entry.entryId === parsed.entryId)
                        : undefined;

                    if (calendarIndex === -1) {
                        throw new Error(
                            `No overlapping calendar entry ${parsed.entryId}; assign.proposals() lists them`
                        );
                    }

                    return applyAnswer({
                        store,
                        record,
                        deps,
                        entries,
                        answer: {
                            project: parsed.project,
                            labels: parsed.labels ?? [],
                            ...(calendarIndex !== undefined ? { calendarIndex } : {}),
                            ...(parsed.pairFolder !== undefined ? { pairFolder: parsed.pairFolder } : {}),
                        },
                    });
                },
            },
            settings: async () => callLive("settings.get"),
            setSettings: async (input: z.input<typeof recorderSetSchema>) =>
                callLive("settings.set", settingsPatchOf(input)),
            mark: async (label: string) => callLive("marker.add", recordingMark.params.parse({ label })),
            set: async (input: z.input<typeof set.params>) => {
                // The CLI's set: it refuses a label to remove that the meeting does not carry, before any write (R2-MC9).
                const { record } = await setMeetingFields({
                    store,
                    config: new MeetingsConfigStore(),
                    record: current(),
                    change: set.params.parse(input),
                    quiet: true,
                });
                return describe(record);
            },
            editorProject: async (input: z.input<typeof editorProject.params> = {}) => {
                const options = editorProject.params.parse(input);
                // lazy: saves 5.5 ms cold import (tools ts imports lazy, 2026-11-05) — only an editor project needs it
                const { meetingEditorSource } = await import("@app/meetings/lib/editor-project");
                return meetingEditorSource({
                    store,
                    record: current(),
                    ...(options.display !== undefined ? { display: options.display } : {}),
                    ...(options.windowSec !== undefined ? { windowSec: options.windowSec } : {}),
                    ...(options.switches
                        ? {
                              overrides: options.switches.map((one) => ({
                                  fromUs: Math.round(one.from * 1_000_000),
                                  toUs: Math.round(one.to * 1_000_000),
                                  displayId: one.display,
                              })),
                          }
                        : {}),
                });
            },
            screenTimeline: async (input: z.input<typeof screenTimelineMethod.params> = {}) => {
                const { all } = screenTimelineMethod.params.parse(input);
                // lazy, like meetingScreen: the timeline reads frame sizes and OCR boxes only on use
                const { screenTimeline } = await import("@app/meetings/lib/screen-timeline");
                return screenTimeline({ store, record: current(), all: all === true });
            },
            export: async (input: z.input<typeof exportMethod.params> = {}) => {
                const parsed = exportMethod.params.parse(input);
                // lazy: the transcript renderer loads only for an export
                const { exportMeeting } = await import("@app/meetings/lib/export");
                return exportMeeting({
                    store,
                    record: current(),
                    config: await new MeetingsConfigStore().read(),
                    ...(parsed.to ? { to: parsed.to } : {}),
                    ...(parsed.ifEdited ? { ifEdited: parsed.ifEdited } : {}),
                    dryRun: parsed.dryRun === true,
                });
            },
            screen: async (input: z.input<typeof screen.params>) => {
                const options = screen.params.parse(input);
                const atSec = typeof options.at === "string" ? parseClock(options.at) : options.at;

                if (typeof options.at === "string" && atSec === undefined) {
                    throw new Error(`at "${options.at}" is no transcript time: use seconds, 1:23:50 or 23:50`);
                }

                // lazy: saves 89.9 ms cold import (tools ts imports lazy, 2026-11-05) — the OCR box renderer loads on use
                const { meetingScreen } = await import("@app/meetings/lib/screen-boxes");
                const {
                    displays: _displays,
                    spans: _spans,
                    ...result
                } = await meetingScreen({
                    store,
                    record: current(),
                    ...(atSec !== undefined ? { atSec } : {}),
                    ...(options.windowSec !== undefined ? { windowSec: options.windowSec } : {}),
                    ...(options.match ? { match: options.match } : {}),
                    ...(options.limit !== undefined ? { limit: options.limit } : {}),
                    ...(options.boxes ? { boxes: options.boxes } : {}),
                });
                return result;
            },
        };
    }
}
