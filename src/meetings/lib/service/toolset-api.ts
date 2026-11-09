import { FINDING_KINDS, findingSchema } from "@app/meetings/lib/findings";
import { matchDraftSchema } from "@app/meetings/lib/match-preview";
import { SUGGEST_RULES } from "@app/meetings/lib/suggest";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { OCR_BOX_LEVELS } from "@genesiscz/utils/macos/ocr-boxes";
import { EXPORT_IF_EDITED } from "@genesiscz/utils/meetings/config";
import { ITEM_STATUSES } from "@genesiscz/utils/meetings/record";
import {
    RECORDER_SET_SETTINGS_DOC,
    RECORDER_SETTINGS_DOC,
    recorderSetSchema,
} from "@genesiscz/utils/repl/toolsets/recorder";
import { DEFAULT_SPAN_GAP_SEC } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

/**
 * The REPL `meetings` toolset's descriptor (src/node-repl/lib/toolsets/meetings.ts reads it), beside the Meetings
 * service's own (`api.ts`), so the two are edited in one place. It is a module of its own because its schemas load the
 * recorder's REPL settings: about 26 to 49 ms that every `tools meetings` read would pay if `api.ts` held it.
 */

export const ref = z.object({ ref: z.string().min(1) });
export const ids = z.array(z.string().min(1));
export const recordDoc =
    "{ id, title, start, project, labels, sources, speakers, items: { suggested, confirmed, rejected }, summary }";

export const list = defineMethod({
    name: "list",
    params: z.object({ project: z.string().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, title, start, seconds, project, items, open }[]",
    effect: "read",
    doc: "The stored meetings, newest first, optionally of one project. `seconds` is the meeting's length (null while it has no end); `open` counts the suggested items nobody decided yet.",
});
export const open = defineMethod({
    name: "open",
    params: ref,
    positional: ["ref"],
    result: z.unknown(),
    resultName: "Meeting",
    effect: "read",
    doc: 'Open a stored meeting by id, a unique prefix, "last", or wisprflow:<id>. meetings.open("last").',
});
export const info = defineMethod({
    name: "info",
    params: z.object({}),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "read",
    doc: "The meeting as it is saved now: title, project, sources, speaker renames, item counts and a one-line summary.",
});
export const evidence = defineMethod({
    name: "evidence",
    params: z.object({}),
    result: z.unknown(),
    effect: "read",
    doc: "Which voice each label's lines are, by audio channel and the platform's speaking indicator.",
});
export const transcript = defineMethod({
    name: "transcript",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ id?, startSec?, speakerId?, speaker, text }[]",
    effect: "read",
    doc: "The linked source transcript as recorded, before any correction. startSec is seconds from the recording's start, when the source has it. lines() is the corrected one.",
});
export const lines = defineMethod({
    name: "lines",
    params: z.object({ withSuggested: z.boolean().optional(), dictionary: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ lines: { at, speaker, text }[], speakers, unattributed, notApplied }",
    effect: "read",
    doc: "The transcript with the speaker renames, the confirmed items and the dictionary applied, as the transcript command prints it. withSuggested: true also applies the suggested items (a preview); dictionary: false leaves the dictionary out. `notApplied` names each correction that found no line.",
});
export const itemsList = defineMethod({
    name: "items.list",
    // An enum, as the CLI's --kind: a misspelt kind answered no rows (R2-MC11).
    params: z.object({ status: z.enum(ITEM_STATUSES).optional(), kind: z.enum(FINDING_KINDS).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, question?, kind, status, confidence, what, rules }[]",
    effect: "read",
    doc: 'The meeting\'s items, optionally of one status ("suggested", "confirmed", "rejected") or kind ("speaker-range", "term", "question", "join", "label"). `what` is the one-line text the items command shows.',
});
export const itemsRows = defineMethod({
    name: "items.rows",
    params: z.object({ lowPriority: z.enum(["hide", "show"]).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ meeting, rows: ReviewRow[], hidden }",
    effect: "read",
    doc: 'The review rows, as `tools meetings rows --json` prints them: each item in the order listen asks, with its question as parts, its typed choices with confidence, its edit kind, sources, Moment and last decision. lowPriority: "show" keeps the open questions under the priority line.',
});
export const add = defineMethod({
    name: "items.add",
    params: z.object({ findings: z.array(findingSchema).min(1) }),
    result: z.unknown(),
    resultName: "{ added: items.list rows, warnings }",
    effect: "reversible",
    doc: "Add validated findings under the meeting store lock; answers the items it added (as items.list rows) and the warnings, never the whole meeting.",
});
export const suggest = defineMethod({
    name: "items.suggest",
    params: z.object({ rules: z.array(z.string()).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ fresh: items.list rows, warnings }",
    effect: "reversible",
    doc: `Run the rules on the transcript and add what they find as suggested items, in one save. rules: any of ${SUGGEST_RULES.join(", ")} (default all). A word check that cannot run is a warning.`,
});
export const decide = {
    result: z.unknown(),
    resultName: "{ decided: string[], skipped: { id, reason, needs }[], token }",
    effect: "reversible" as const,
};
export const rejectParams = z
    .object({ ids: ids.optional(), minConfidence: z.number().min(0).max(1).optional() })
    .strict();
export const confirm = defineMethod({
    name: "items.confirm",
    ...decide,
    // Only a confirm keeps a value; reject has its own schema, as in the CLI, so it refuses them (R2-MC12).
    params: rejectParams.extend({ speaker: z.string().optional(), proposed: z.string().optional() }).strict(),
    doc:
        'Confirm items (ids "i3", or a question\'s number "Q2"), or every suggested item at or above minConfidence (0..1). Transcripts apply confirmed items. A range nobody named needs `speaker`, a term with no spelling needs `proposed`; a question is answered by ear (' +
        toolCommand("meetings listen") +
        "). Those come back in `skipped` with the reason and what they need. `token` undoes it with items.reopen.",
});
export const reject = defineMethod({
    name: "items.reject",
    ...decide,
    params: rejectParams,
    doc: "Reject items by id, or every suggested item at or above minConfidence: they are never suggested again. `token` undoes it with items.reopen.",
});
export const reopen = defineMethod({
    name: "items.reopen",
    params: z.object({ ids: ids.min(1), token: z.string().min(1).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ reopened: string[], skipped: { id, reason }[] }",
    effect: "reversible",
    doc: "Undo a confirm or a reject: each item gets back what the decision changed. Pass the `token` the decision answered; an item decided again since is refused, and nothing is reopened (NR20).",
});
export const speakers = defineMethod({
    name: "speakers.stats",
    params: z.object({ gapSeconds: z.number().positive().optional() }).strict(),
    result: z.unknown(),
    effect: "read",
    doc: `Each speaker label's statistics: lines, talk time and spans (a gap of gapSeconds, ${DEFAULT_SPAN_GAP_SEC} by default, starts a new span), with who was present.`,
});
export const rename = defineMethod({
    name: "speakers.rename",
    params: z.object({ label: z.string().min(1), name: z.string().min(1) }).strict(),
    positional: ["label", "name"],
    result: z.unknown(),
    resultName: recordDoc,
    effect: "reversible",
    doc: 'Name a speaker label ("Speaker 2" → "Alice"): this meeting\'s transcripts use the name from now on. A label the linked transcript does not have is refused, with the labels it has.',
});
export const set = defineMethod({
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

export const person = z.object({ name: z.string().min(1), email: z.string().min(1).optional() });
export const projectsLabels = defineMethod({
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
export const projectsPair = defineMethod({
    name: "projects.pair",
    params: z
        .object({ project: z.string().min(1), people: z.array(person).min(1), note: z.string().optional() })
        .strict(),
    result: z.unknown(),
    resultName: "{ project, people }",
    effect: "reversible",
    doc: "Pair people with a project by hand (pairedBy manual). A later meeting with them proposes the project. One person can be in several projects.",
});
export const projectsUnpair = defineMethod({
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
export const projectsPeople = defineMethod({
    name: "projects.people",
    params: z.object({ project: z.string().min(1).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ project, name, email?, pairedBy }[]",
    effect: "read",
    doc: "The people paired with each project, each with its sources (pairedBy: calendar entries and manual pairings).",
});
export const assignSweepMethod = defineMethod({
    name: "assign.sweep",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ asked: string[], advanced: { meeting, outcome }[] }",
    effect: "reversible",
    reaches: ["user"],
    doc: 'One "ask each time" pass, as the watcher runs it: read back answers and apply them, then post a decision-inbox question for each recent ended meeting without a project.',
});
export const assignProposals = defineMethod({
    name: "assign.proposals",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ proposals: { projects, labels, calendars, folder }, calendarNotes, skipped }",
    effect: "read",
    doc: "The ranked project proposals of this meeting, each with its reasons (folder rule, calendar name, title rule, paired people of an overlapping entry, title words of earlier meetings), the overlapping calendar entries, label proposals and the Wispr folder step. calendarNotes names each calendar that could not be read.",
});
export const assignAsk = defineMethod({
    name: "assign.ask",
    params: z.object({ force: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ formId?, skipped? }",
    effect: "reversible",
    reaches: ["user"],
    doc: "Post this meeting's project question to the decision inbox now (once per meeting; force asks again).",
});
export const assignApply = defineMethod({
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

export const overview = defineMethod({
    name: "overview",
    params: z.object({ days: z.number().positive().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ meetings: { id, title, day, project, badges }[], projects, needsYou }",
    effect: "read",
    doc: "The meetings of the last days (default 14) by day, each with its badges (no project, open questions, unclear speakers, recording only, transcript only, suggestions ready to confirm), and the meetings that wait for a person.",
});
export const projectsPreview = defineMethod({
    name: "projects.preview",
    params: z.object({ draft: matchDraftSchema.optional(), limit: z.number().int().positive().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, title, project?, now: string[], draft: string[], changed }[]",
    effect: "read",
    doc: 'Which project each recent meeting matches by the saved rules, and with draft rules: { draft: { work: { titleWords: ["sync"], calendars: [], folders: { wisprflow: [] } } } }.',
});
export const dictionaryTest = defineMethod({
    name: "dictionary.test",
    params: z.object({ phrase: z.string().min(1), project: z.string().min(1).optional() }).strict(),
    positional: ["phrase"],
    result: z.unknown(),
    resultName: "{ text, fired: DictionaryEntry[], suggestions, counts }",
    effect: "read",
    doc: "What the dictionary (global, then the project) does to one phrase, and which entries fired.",
});
export const configGet = defineMethod({
    name: "config.get",
    params: z.object({ path: z.string().min(1).optional() }).strict(),
    positional: ["path"],
    result: z.unknown(),
    effect: "read",
    doc: 'The meetings settings with their defaults, or the value at one path ("global.capture.activeFps", or a JSON array of keys).',
});
export const configSet = defineMethod({
    name: "config.set",
    params: z.object({ path: z.string().min(1), value: z.unknown() }).strict(),
    positional: ["path", "value"],
    result: z.unknown(),
    effect: "reversible",
    doc: "Write one meetings setting; the whole config is validated first and nothing is written when it fails.",
});
export const captureCostMethod = defineMethod({
    name: "captureCost",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ keptFrameCpuMs, observed?, displays, activeFps, idleFps, threshold }",
    effect: "read",
    doc: "The CPU each capture choice costs: the bench's cost per kept frame and the newest real recording's frame rate.",
});
export const screenTimelineMethod = defineMethod({
    name: "screenTimeline",
    params: z.object({ all: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ displays, frames: { file, path, meetingSec, displayId, changed: OcrBox[] }[] }",
    effect: "read",
    doc: "Every frame of the screen recording in time order with the OCR lines that changed since the display's earlier frame (all: every line too).",
});
export const exportMethod = defineMethod({
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

export const recordingSettings = defineMethod({
    name: "settings",
    params: z.object({}),
    result: z.unknown(),
    resultName: "{ settings, audio }",
    effect: "read",
    doc: `${RECORDER_SETTINGS_DOC} Only while this meeting is being recorded.`,
});
export const setRecordingSettings = defineMethod({
    name: "setSettings",
    params: recorderSetSchema,
    result: z.unknown(),
    resultName: "{ settings, audio, applied }",
    effect: "reversible",
    doc: `${RECORDER_SET_SETTINGS_DOC} Only while this meeting is being recorded.`,
});
export const recordingMark = defineMethod({
    name: "mark",
    params: z.object({ label: z.string().min(1).max(80) }),
    positional: ["label"],
    result: z.unknown(),
    resultName: "{ atMs, label }",
    effect: "reversible",
    doc: 'Marks this moment of the screen recording with a label ("demo starts"); the meeting\'s editor project lists it at its time in the movie. Only while this meeting is being recorded.',
});
export const screen = defineMethod({
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
export const editorProject = defineMethod({
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

export const meetingsToolsetApi = defineApi({
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
                itemsRows,
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
