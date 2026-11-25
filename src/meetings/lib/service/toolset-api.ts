import { meetingCommentSchema } from "@app/meetings/lib/comment-schema";
import { FINDING_KINDS, findingSchema } from "@app/meetings/lib/findings";
import { matchDraftSchema } from "@app/meetings/lib/match-preview";
import { SUGGEST_RULES } from "@app/meetings/lib/suggest";
import { WORD_CHECKS } from "@app/meetings/lib/word-check";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { OCR_BOX_LEVELS } from "@genesiscz/utils/macos/ocr-boxes";
import { EXPORT_IF_EDITED, MEETING_PLAYERS } from "@genesiscz/utils/meetings/config";
import { ITEM_STATUSES } from "@genesiscz/utils/meetings/record";
import {
    RECORDER_SET_SETTINGS_DOC,
    RECORDER_SETTINGS_DOC,
    recorderSetSchema,
} from "@genesiscz/utils/repl/toolsets/recorder";
import { dictionaryEntrySchema } from "@genesiscz/utils/transcribe/dictionary";
import { DEFAULT_SPAN_GAP_SEC } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";
import { meetingTimeRangeSchema } from "../moment-schema";
import { sourceAudioPlanSchema } from "../source-audio-discovery";
import {
    listenPrepare,
    meetingPeopleEdit,
    meetingsMethod,
    meetingVoice,
    momentSave,
    voiceBackfill,
    voiceEnrol,
    voicesApply,
    voicesDedupe,
    voicesJobs,
    voicesJobsCancel,
    voicesList,
    voicesMove,
    voicesQuality,
    voicesReject,
    voicesRemove,
    voicesRename,
    voicesSample,
    voicesUndo,
} from "./api";

/**
 * The REPL `meetings` toolset's descriptor (src/node-repl/lib/toolsets/meetings.ts reads it), beside the Meetings
 * service's own (`api.ts`), so the two are edited in one place. It is a module of its own because its schemas load the
 * recorder's REPL settings: about 26 to 49 ms that every `tools meetings` read would pay if `api.ts` held it.
 */

import { meetingSeatsSchema } from "@genesiscz/utils/meetings/seats";
import { byChannelOptionsSchema } from "../by-channel";

export const byChannel = defineMethod({
    name: "items.byChannel",
    params: byChannelOptionsSchema,
    result: z.unknown(),
    effect: "reversible",
    doc: "Read screen --at before attributing an idea shown on screen. Plan speaker ranges from microphone shares and explicit seats. dryRun defaults to true and writes nothing.",
});

export const ref = z.object({ ref: z.string().min(1) });
export const levels = defineMethod({
    name: "levels",
    params: z
        .object({ meeting: z.string().min(1).optional(), seconds: z.number().int().min(1).max(60).optional() })
        .strict()
        .refine(
            (input) => input.meeting === undefined || input.seconds === undefined,
            "seconds applies only to the live microphone test"
        ),
    result: z.unknown(),
    effect: "read",
    doc: `Read saved dBFS, share, calibration, devices and mute rows with {meeting} (${toolCommand("meetings evidence")} <meeting> --levels). Without a meeting, sample live inputs for 1–60 seconds (default 3) and return the final reading and warnings (${toolCommand("meetings levels")} --seconds <n>). No test audio is saved.`,
});
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
export const look = defineMethod({
    name: "look",
    params: meetingTimeRangeSchema,
    result: z.unknown(),
    resultName: "{ meeting, fromSec, toSec, lines, attendance, questions, items, screen }",
    effect: "read",
    doc: `Read the transcript lines, speaker and voice evidence, attendance stays, open questions, items and screen text changes within inclusive transcript times (seconds, MM:SS or H:MM:SS). Same result as ${toolCommand("meetings", "look")} <meeting> --from <time> --to <time> --json.`,
});
export const measure = defineMethod({
    name: "measure",
    params: z.strictObject({ meeting: ref.shape.ref }),
    result: z.unknown(),
    resultName: "RoomCallReport",
    effect: "read",
    doc: "Return the held-out room/call report with baseline and candidate speaker counts, per-line outcomes, cohort changes and quality targets. Read reference.json, holdout.json, baseline.json and candidate.json from the room-call/ folder beside the meeting record. CLI: bun scripts/benchmarks/meetings/room-call.ts --reference <dir>/reference.json --holdout <dir>/holdout.json --baseline <dir>/baseline.json --candidate <dir>/candidate.json --out <new-file>.",
});
export const info = defineMethod({
    name: "info",
    params: z.object({}),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "read",
    doc: "The meeting as it is saved now: title, project, sources, speaker renames, item counts and a one-line summary.",
});
export const voice = defineMethod({
    ...meetingVoice,
    name: "voice",
    params: meetingVoice.params.omit({ meeting: true }),
});
export const editPerson = defineMethod({
    ...meetingPeopleEdit,
    name: "editPerson",
    params: meetingPeopleEdit.params.omit({ meeting: true }),
});
export const acousticCollect = defineMethod({
    name: "acousticCollect",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ blocks, layout }",
    effect: "reversible",
    doc: "Explicitly collect acoustic evidence into this meeting's sandbox/store.",
});
export const voiceCollect = defineMethod({
    name: "voiceCollect",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ lines, matched }",
    effect: "reversible",
    doc: "Explicitly collect voice scores from confirmed enrolments for attribution.",
});
export const voiceEnroll = defineMethod({
    name: "voiceEnroll",
    params: z
        .object({
            fromSec: z.number().nonnegative(),
            toSec: z.number().positive(),
            channel: z.union([z.literal(0), z.literal(1)]),
            person: z.string().min(1),
            confirmed: z.literal(true),
        })
        .strict(),
    result: z.unknown(),
    resultName: "VoiceMatch",
    effect: "reversible",
    doc: `Enrol a confirmed single-speaker interval, retaining model and channel provenance. An agent's call asks the user in a confirmation window first and throws the FOR AGENTS block until the user confirmed there; the same call again then saves. CLI twin: ${toolCommand("meetings voices enroll")} <meeting> --from <s> --to <s> --channel <0|1> --person <name> --confirmed.`,
});
export const acousticInspect = defineMethod({
    name: "acousticInspect",
    params: z.object({ fromSec: z.number().nonnegative(), toSec: z.number().positive() }).strict(),
    result: z.unknown(),
    resultName: "{ quality, reason, layout?, metric? }",
    effect: "read",
    doc: "Read cached correlation, lag, raw and residual mic evidence for an interval.",
});
export const acousticClip = defineMethod({
    name: "acousticClip",
    params: acousticInspect.params,
    result: z.unknown(),
    resultName: "{ tracks, metric, quality }",
    effect: "reversible",
    doc: "Retain raw mic, isolated call and linear cleaned estimate for at most 60 seconds.",
});
export const voiceScore = defineMethod({
    name: "voiceScore",
    params: z
        .object({
            fromSec: z.number().nonnegative(),
            toSec: z.number().positive(),
            channel: z.union([z.literal(0), z.literal(1)]),
        })
        .strict(),
    result: z.unknown(),
    resultName: "VoiceMatch",
    effect: "read",
    doc: "Offline confirmed-enrolment speaker match; unknown without enough evidence. Never downloads a model.",
});

export const evidence = defineMethod({
    name: "evidence",
    params: z
        .object({
            table: z.boolean().optional(),
            raw: z.boolean().optional(),
            from: z.number().nonnegative().optional(),
            to: z.number().nonnegative().optional(),
            /** raw without from/to: the word check of the term part, as `--word-check`. */
            wordCheck: z.enum(WORD_CHECKS).optional(),
            /** raw without from/to: screen lines per term lead, as `--screen-lines` (0 = none). */
            screenLines: z.number().int().nonnegative().optional(),
        })
        .strict()
        .refine((options) => options.to === undefined || options.to >= (options.from ?? 0), {
            message: "to must be at or after from",
        }),
    result: z.unknown(),
    effect: "read",
    doc: `Read screen --at before attributing an idea shown on screen. Channel evidence; table (or raw with from/to) returns the per-line evidence of that window. raw without from/to is ${toolCommand("meetings", "evidence")} <meeting> --raw: seats, project roles, the terms (each unknown word, vocabulary run and spoken identifier with the screen OCR lines near it that sound like it: atSec, frame, form, text, score) and screen, the screen record they come from (or recorded false). wordCheck and screenLines are its --word-check and --screen-lines.`,
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
    params: z
        .object({
            withSuggested: z.boolean().optional(),
            dictionary: z.boolean().optional(),
            applyAbove: z.number().min(0).max(1).optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ lines: { at, speaker, text }[], speakers, guesses, unattributed, notApplied }",
    effect: "read",
    doc: "The transcript with the speaker renames, the confirmed items and the dictionary applied, as the transcript command prints it. withSuggested: true also applies the suggested items (a preview); dictionary: false leaves the dictionary out. `speakers` counts the lines of each named person, `guesses` the lines shown as a guess `[Name: NN %]` per person guessed, `unattributed` the source labels nobody named. `notApplied` names each correction that found no line.",
});
export const voiceFeatures = defineMethod({
    name: "voiceFeatures",
    params: meetingVoice.params.omit({ meeting: true }),
    result: meetingVoice.result,
    effect: meetingVoice.effect,
    doc: meetingVoice.doc,
});
export const prepareListen = defineMethod({
    name: "prepareListen",
    params: listenPrepare.params.omit({ meeting: true }),
    result: listenPrepare.result,
    effect: listenPrepare.effect,
    doc: listenPrepare.doc,
});
export const enrolVoices = defineMethod({
    name: "enrolVoices",
    params: voiceEnrol.params.omit({ meeting: true }),
    result: voiceEnrol.result,
    effect: voiceEnrol.effect,
    doc: voiceEnrol.doc,
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
    params: z
        .object({ lowPriority: z.enum(["hide", "show"]).optional(), applyAbove: z.number().min(0).max(1).optional() })
        .strict(),
    result: z.unknown(),
    resultName:
        "{ meeting, rows: ReviewRow[], hidden, attendanceWarning?, attendanceDetail?, lineEvidence?, questionDetails? }",
    effect: "read",
    doc: `The review rows, as \`${toolCommand("meetings", "rows", "--json")}\` prints them: each item in the order listen asks, with its question as parts, its typed choices with confidence, its edit kind, sources, Moment and last decision. Optional attendanceWarning and attendanceDetail, lineEvidence (per source line) and questionDetails (per question); a missing field was not available, never a negative result. lowPriority: "show" keeps the open questions under the priority line.`,
});
export const add = defineMethod({
    name: "items.add",
    params: z.object({
        findings: z.array(findingSchema).min(1),
        allowDuplicates: z.boolean().optional(),
        force: z.boolean().optional(),
    }),
    result: z.unknown(),
    resultName: "{ added: items.list rows, duplicates: string[], warnings }",
    effect: "reversible",
    doc: "Add validated findings under the meeting store lock. Equal open findings are retained and reported as duplicate ids; allowDuplicates appends deliberately. Answers added items.list rows, duplicate ids and warnings. An all-duplicate retry writes nothing.",
});
export const suggest = defineMethod({
    name: "items.suggest",
    params: z
        .object({
            rules: z.array(z.string()).optional(),
            attendance: z.string().min(1).optional(),
            attendanceId: z.string().trim().min(1).optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ fresh: items.list rows, retired: string[], warnings: string[], deviceOffers? }",
    effect: "reversible",
    doc: `Run ${toolCommand("meetings", "suggest")} with any of ${SUGGEST_RULES.join(", ")} (default all). Returns fresh items, retired item IDs and warnings, including an unavailable word check. With attendance "teams", a warning lists up to three matching chats by last call. Pass attendanceId to select one.`,
});
export const preview = defineMethod({
    name: "items.preview",
    params: z.object({ rules: z.array(z.enum(SUGGEST_RULES)).optional() }).strict(),
    result: z.unknown(),
    resultName: "{ changes: { meeting, fresh, updated, stays }, warnings }",
    effect: "read",
    doc: `Preview the next ${toolCommand("meetings", "suggest")} on saved evidence. Returns new items, existing item edits with before values, and participant stay edits. To save, call items.suggest with the same rules.`,
});
export const decide = {
    result: z.unknown(),
    resultName: "{ decided: string[], skipped: { id, reason, needs }[], token }",
    effect: "reversible" as const,
};
export const rejectParams = z
    .object({
        ids: ids.optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        kind: z.enum(FINDING_KINDS).optional(),
        where: z.string().optional(),
    })
    .strict();
export const confirm = defineMethod({
    name: "items.confirm",
    ...decide,
    // Only a confirm keeps a value; reject has its own schema, as in the CLI, so it refuses them (R2-MC12).
    params: rejectParams
        .omit({ kind: true, where: true })
        .extend({ speaker: z.string().optional(), proposed: z.string().optional() })
        .strict(),
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
    params: z
        .object({ ids: ids.optional(), token: z.string().min(1).optional() })
        .strict()
        .refine((params) => (params.ids?.length ?? 0) > 0 || params.token !== undefined, {
            message: "items.reopen needs ids, or the token of the decision to undo",
        }),
    result: z.unknown(),
    resultName: "{ reopened: string[], skipped: { id, reason }[] }",
    effect: "reversible",
    doc: "Undo a confirm, a reject or a speaker rename: each item gets back what the decision changed. Pass the `token` the decision answered; an item decided again since is refused, and nothing is reopened (NR20). A token with no ids undoes its whole decision, a rename's labels included.",
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
            seats: meetingSeatsSchema.optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "reversible",
    doc: "Change the meeting's title, project, labels or seats. Room and remote seats accept names or half-open intervals {name, fromSec?, toSec?}. A new project or label joins the known ones. unlabel removes labels.",
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

export const locate = defineMethod({
    name: "locate",
    params: ref,
    positional: ["ref"],
    result: z.unknown(),
    resultName: "{ store, setting? } | null",
    effect: "read",
    doc: `Which meetings store holds this exact id: this one (no setting), the ordinary home or an agent scratch home (setting names the GENESIS_TOOLS_HOME to use), or null. A missing meeting never searches the other stores by itself. CLI: ${toolCommand("meetings", "locate")} <id>.`,
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
const polishResult =
    "{ file, outPath, mode, outcome?, check: { verdict, message, diff? } | null, carried, warnings, parts: { record, lines, terms, questions }[] }";

export const polishBuild = defineMethod({
    name: "polish.build",
    params: z.object({ file: z.string().min(1), force: z.boolean().optional() }).strict(),
    positional: ["file", "force"],
    result: z.unknown(),
    resultName: polishResult,
    effect: "reversible",
    doc: `Write a meeting's polished markdown from its .polished.ts (export default defineMeetingsPolished({ … })) and the live records: each part's transcript with suggestions applied, speaker and term diffs, lines per person, open questions. Refuses (outcome "refused") when the markdown was edited by hand since the last build; force overwrites. Never writes the .ts or a record. Same as ${toolCommand("meetings polish build")} <file> [--force].`,
});
export const polishCheck = defineMethod({
    name: "polish.check",
    params: z.object({ file: z.string().min(1) }).strict(),
    positional: ["file"],
    result: z.unknown(),
    resultName: polishResult,
    effect: "read",
    doc: `Compare a polished markdown with what its .polished.ts and the records produce now, without writing: check.verdict is clean, stale, hand-edited or unstamped, with the diff. Same as ${toolCommand("meetings polish build")} <file> --check.`,
});
export const polishInit = defineMethod({
    name: "polish.init",
    params: z.object({ from: z.string().min(1), out: z.string().min(1).optional() }).strict(),
    positional: ["from", "out"],
    result: z.unknown(),
    resultName: "{ path, report: { mapped, kept, notes }, unlinkedDir }",
    effect: "reversible",
    doc: `Write a NEW .polished.ts from a draft polished JSON, once: every draft field becomes a config field or is kept under extras and reported. Refuses an existing file. Same as ${toolCommand("meetings polish init")} --from <json> [--out <file>].`,
});

export const dictionaryTest = defineMethod({
    name: "dictionary.test",
    params: z
        .object({
            phrase: z.string().min(1),
            project: z.string().min(1).optional(),
            entry: dictionaryEntrySchema.optional(),
            meeting: z.string().min(1).optional(),
            limit: z.number().int().positive().optional(),
        })
        .strict(),
    positional: ["phrase", "project", "entry", "meeting", "limit"],
    result: z.unknown(),
    resultName: "{ text, fired: DictionaryEntry[], suggestions, counts, lines?, totalChanged?, truncated? }",
    effect: "read",
    doc: `What the dictionary (global, then the project) does to one phrase, and which entries fired, as ${toolCommand("meetings", "dictionary", "test")} --json prints it. With a draft entry and a meeting, also the first limit (default 200) lines of that meeting the entry would change, before and after, with totalChanged and truncated: true when more changed. Reads only.`,
});
export const audioPlan = defineMethod({
    name: "audio.plan",
    params: z.object({}).strict(),
    result: sourceAudioPlanSchema,
    effect: "read",
    doc: "Read-only reconciliation of permanent local audio, provider files and legacy archive files.",
});
export const audioApply = defineMethod({
    name: "audio.apply",
    params: z.object({ plan: sourceAudioPlanSchema }).strict(),
    positional: ["plan"],
    result: z.unknown(),
    effect: "reversible",
    doc: "Explicitly preserve a revalidated audio plan. Leaves originals untouched.",
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
export const recordStart = defineMethod({
    name: "recordStart",
    params: z
        .object({
            meeting: z.string().optional(),
            source: z.string().optional(),
            title: z.string().optional(),
            project: z.string().optional(),
            display: z.string().optional(),
            audio: z.string().optional(),
        })
        .strict(),
    result: z.unknown(),
    effect: "reversible",
    doc: `Start a recording (${toolCommand("meetings", "record", "start")}). Returns the meeting id, capturing identity, whether frames were omitted, and any partial-start reason.`,
});
export const watchOnceMethod = defineMethod({
    name: "watchOnce",
    params: z.object({}).strict(),
    result: z.string(),
    effect: "reversible",
    doc: `Run one ${toolCommand("meetings", "watch", "--once")} tick, including recording permission preflight, and return its outcome.`,
});
export const autostartMethod = defineMethod({
    name: "autostart",
    params: z.object({ mode: z.enum(["on", "off", "status"]).optional() }).strict(),
    positional: ["mode"],
    result: z.unknown(),
    effect: "reversible",
    doc: `Read or change ${toolCommand("meetings", "autostart")}. Returns enabled, running and the last failed or partial start with its time and delivery receipts.`,
});
export const captureCostMethod = defineMethod({
    name: "captureCost",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ keptFrameCpuMs, observed?, displays, activeFps, idleFps, threshold, neverCapture }",
    effect: "read",
    doc: `The CPU each capture choice costs: the bench's cost per kept frame and the newest real recording's frame rate, and neverCapture: a fresh read of the never-capture windows (as captureBlockers()). CLI twin: ${toolCommand("meetings", "record", "cost")}.`,
});
export const captureBlockersMethod = defineMethod({
    name: "captureBlockers",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName:
        "{ listed, reason?, apps?: { pid, name, bundleId?, windows, displays, allowListed }[], action, quitApps, relaunch }",
    effect: "read",
    doc: `The apps that keep a never-capture window on a display (each capture stream there slows the whole screen), read fresh, and the capture.recorders.native.neverCapture setting. listed false: the recorder cannot list them, which is not none. CLI twin: ${toolCommand("meetings", "record", "blockers")}.`,
});
export const quitCaptureBlockersMethod = defineMethod({
    name: "quitCaptureBlockers",
    params: z.object({}).strict(),
    result: z.unknown(),
    resultName: "{ listed, reason?, quit, stayed, outside, configKey }",
    effect: "reversible",
    doc: `Quits the never-capture apps of the allow list (capture.recorders.native.neverCapture.quitApps) now; an app outside it is never quit and comes back in outside, with configKey naming the list. CLI twin: ${toolCommand("meetings", "record", "blockers", "--quit")}.`,
});
export const screenTimelineMethod = defineMethod({
    name: "screenTimeline",
    params: z.object({ all: z.boolean().optional() }).strict(),
    result: z.unknown(),
    resultName:
        "{ displays, focusSpans?, frames: { file, path, meetingSec, displayId, focusedDisplayId?, changed: OcrBox[] }[] }",
    effect: "read",
    doc: "Every frame in time order with changed OCR lines (all: every line too), the focused display when recorded, and its focusSpans. Older recordings have no focus history.",
});
export const saveClip = defineMethod({
    name: "saveClip",
    params: momentSave.params.omit({ meeting: true }),
    result: momentSave.result,
    resultName: momentSave.resultName,
    effect: "reversible",
    doc: "Save selected audio in this meeting's clips folder and Context, without playing. By default it has no tone or padding. Repeating the same cut returns its existing Context entry.",
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

export const commentsList = defineMethod({
    name: "comments",
    params: z.object({}).strict(),
    result: z.array(meetingCommentSchema),
    resultName: "MeetingComment[]",
    effect: "read",
    doc: "List this meeting's staged and sent comments, with read receipts and withdrawals.",
});
export const commentRead = defineMethod({
    name: "readComment",
    params: z.object({ id: z.string().min(1) }).strict(),
    positional: ["id"],
    result: meetingCommentSchema,
    resultName: "MeetingComment",
    effect: "destructive",
    doc: "Acknowledge a sent comment before acting on it. Refuses a comment withdrawn before acknowledgement.",
});
export const commentWithdraw = defineMethod({
    name: "withdrawComment",
    params: z.object({ id: z.string().min(1) }).strict(),
    positional: ["id"],
    result: meetingCommentSchema,
    resultName: "MeetingComment",
    effect: "destructive",
    doc: "Withdraw an unread comment. Refuses a comment the receiver has already acknowledged.",
});

const seatsRpc = meetingsMethod("meeting.seats.suggest");
export const roomDevices = defineMethod({
    ...meetingsMethod("people.devices.list"),
    name: "roomDevices",
    doc: `Return devices and, with {offers: true} or {meeting}, questions with their supporting meeting IDs and available titles. CLI: ${toolCommand("meetings people devices list")} [--offers] [--meeting <id>].`,
});
export const decideRoomDevice = defineMethod({
    ...meetingsMethod("people.devices.decide"),
    name: "decideRoomDevice",
    doc: `Return {changed, device, token?} for the owner's map, unmap, undo or yes/no answer. Answer with account, group and meetings from the offer, and the selected meeting when scoped. Undo sends {action: "undo", account, reverses: token}. Agent callers can read offers. CLI: ${toolCommand("meetings people devices")} map|unmap|answer.`,
});
const thresholdsRpc = meetingsMethod("meeting.thresholds.preview");
export const applySeats = defineMethod({
    name: "applySeats",
    params: seatsRpc.params.extend({ replace: z.boolean().optional() }),
    result: seatsRpc.result.extend({ saved: z.boolean() }),
    effect: "reversible",
    doc: `Return the seat preview and saved flag. Accept names or timed room and remote entries. Save when seats are absent, or replace them with replace: true. CLI: ${toolCommand("meetings", "seats")} <meeting> --apply --json.`,
});
export const voiceJobs = defineMethod({
    ...voicesJobs,
    name: "voiceJobs",
    doc: `Return current and recent voice jobs with progress, counts, errors and warnings (a naming pass that left a person with too few samples out of a split). CLI: ${toolCommand("meetings voices jobs")} [--project <p>] --json.`,
});
export const cancelVoiceJob = defineMethod({
    ...voicesJobsCancel,
    name: "cancelVoiceJob",
    positional: ["id"],
    doc: `Return the cancelled or terminal voice job, or null for an unknown id. CLI: ${toolCommand("meetings voices jobs cancel")} <id>.`,
});

export const backfillVoices = defineMethod({
    ...voiceBackfill,
    name: "backfillVoices",
    doc: `Return added, already-present and skipped counts for human-confirmed samples, by meeting and person. dryRun counts without saving. CLI: ${toolCommand("meetings", "voices", "backfill")} [meetings...] [--project <p>] [--dry-run] --json.`,
});
export const dedupeVoices = defineMethod({
    ...voicesDedupe,
    name: "dedupeVoices",
    doc: `Remove the voice samples that repeat a line the same person already holds (a backfill after a join learned it again under the joined record's id); the first saved sample of each line stays. Returns the rows, each with the id it keeps, and the token of the correction receipt that keeps the removed rows; undo is refused while the kept sample holds the line. dryRun lists them and saves nothing. The meetings service writes it, so an open Voices pane refreshes. CLI twin: ${toolCommand("meetings", "voices", "dedupe")} [--dry-run] --json.`,
});
export const seats = defineMethod({
    ...seatsRpc,
    name: "seats",
    doc: `Return the current seats, suggested seats and the reason and confidence for each person. Room and remote accept names or half-open stays { name, fromSec?, toSec? }. CLI: ${toolCommand("meetings", "seats")} <meeting> --json.`,
});
export const thresholds = defineMethod({
    name: "thresholds",
    params: thresholdsRpc.params.omit({ values: true }).extend({
        set: thresholdsRpc.params.shape.values.optional(),
        preview: z.boolean().optional(),
    }),
    result: thresholdsRpc.result,
    effect: "reversible",
    doc: `Return thresholds, changes, counts and warnings. Pass a meeting and set (name to number) to save globally, or preview: true to compare without saving. CLI: ${toolCommand("meetings", "thresholds")} [meeting] [--set name=value] [--preview] --json.`,
});
export const voiceReadiness = defineMethod({
    name: "voiceReadiness",
    params: seatsRpc.params.pick({ meeting: true }),
    result: z.object({
        seats: z.boolean(),
        samples: z.number(),
        people: z.record(z.string(), z.number()),
        ready: z.boolean(),
        hints: z.array(z.string()),
    }),
    effect: "read",
    doc: `Return the voice field of ${toolCommand("meetings", "show")} <meeting> --json, including seat coverage, per-person sample counts, readiness and next commands.`,
});

const browsePerson = voicesList.params.pick({ person: true });
export const voices = defineMethod({
    ...voicesList,
    name: "voices",
    params: z.discriminatedUnion("scope", [
        browsePerson.extend({ scope: z.literal("meeting"), meeting: seatsRpc.params.shape.meeting }),
        browsePerson.extend({ scope: z.literal("project"), project: voicesList.params.shape.project.unwrap() }),
        browsePerson.extend({ scope: z.literal("global") }),
    ]),
    doc: `Return people, samples, learnt voice quality and conflicts for one meeting ID, project or the global library. CLI: ${toolCommand("meetings", "voices")} --json.`,
});

export const lineEligibility = defineMethod({
    name: "lineEligibility",
    params: seatsRpc.params.pick({ meeting: true }).extend({ line: z.number().int().nonnegative() }),
    result: z.object({
        channel: z.object({
            side: z.enum(["mic", "call", "mixed", "unknown"]),
            strong: z.boolean(),
            source: z.enum(["segments", "energy", "both", "none"]).optional(),
        }),
        choices: z.array(z.string()),
        excluded: z.array(z.object({ person: z.string(), reason: z.string() })),
        reviewOnly: z.boolean(),
    }),
    effect: "read",
    doc: `Return the channel, eligible people, exclusions with reasons and reviewOnly flag for a zero-based source transcript line. CLI: ${toolCommand("meetings", "evidence")} <meeting> --line-eligibility <index> --json.`,
});

export const play = defineMethod({
    name: "play",
    params: z
        .object({
            meeting: z.string().min(1),
            /** The transcript second to play from. */
            atSec: z.number().nonnegative(),
            /** With track: the range from atSec to here, as one cut, instead of on from atSec. */
            toSec: z.number().positive().optional(),
            /** Start this many seconds earlier; default playback.beforeSec, 0 for a range. */
            beforeSec: z.number().nonnegative().optional(),
            /** source-mic, source-call, mic-raw or system; absent: the best track of the line's seat. */
            track: z.string().min(1).optional(),
            player: z.enum(MEETING_PLAYERS).optional(),
            /** false: plan only; nothing is cut, written or started. */
            start: z.boolean().optional(),
        })
        .refine((params) => params.toSec === undefined || (params.track !== undefined && params.toSec > params.atSec), {
            message: "toSec needs track and must be after atSec; a range without a track is a Moment (play --to).",
        }),
    result: z.unknown(),
    resultName:
        "{ track, path, channel?, fileFromSec, fileToSec, clock, fromSec, audioPath, startSec, cut, cutParts?, parts, list?, player, argv, pid? }",
    effect: "reversible",
    doc: `Play the meeting's sound from atSec (transcript seconds) in VLC or ffplay, on through the track's later pieces, or with toSec and track that range as one cut. Returns what plays (parts with their file seconds), the player's command line and, once started, its pid; start: false plans only and cuts, writes and starts nothing. CLI twin: ${toolCommand("meetings", "play")} <meeting> <time> [--to <time> --track <kind>] --json [--no-start].`,
});

export const join = defineMethod({
    name: "join",
    params: z.object({
        /** The two records of one meeting that its source recorded as two, in any order. */
        meetings: z.array(z.string().min(1)).length(2),
        /** true: say what would join; nothing changes. */
        dryRun: z.boolean().optional(),
    }),
    result: z.unknown(),
    resultName:
        "{ into, dryRun, parts: [{ record, title, source, offsetMs, lines, items, renumbered, endSec }], gaps, rounded, backup?, withdrawn? }",
    effect: "reversible",
    doc: `Join two recordings of one meeting into one record: the earlier one's id and clock, the later one's lines, items and journal at their own wall time, the gap between them kept empty, both folders cloned into a backup first (its README restores them). Returns the parts, their place on the joined clock and the gaps. CLI twin: ${toolCommand("meetings", "join")} <meeting> <other> [--dry-run] --json.`,
});

export const joinRepair = defineMethod({
    name: "joinRepair",
    params: z.object({
        /** A meeting joined before 2026-11-25 (its later recording's sound still in that recording's folder). */
        meeting: z.string().min(1),
        /** true: say what would move; nothing changes. */
        dryRun: z.boolean().optional(),
    }),
    result: z.unknown(),
    resultName:
        "{ meeting, dryRun, repaired, reason?, sound?: { pieces, rows, levels, recordings: [{ record, offsetMs }] }, joinedFile?, backup? }",
    effect: "reversible",
    doc: `Move the later recording's sound of a meeting joined before 2026-11-25 into the joined record's folder, as join does now: its recorder files and rows, its measured clock as its own entry, its source recording as a piece of one source file of the whole meeting (the gap silence). Every folder it touches is cloned into a backup first; a second run changes nothing (repaired: false). CLI twin: ${toolCommand("meetings", "join")} <meeting> --repair [--dry-run] --json.`,
});

export const confirmRelayed = defineMethod({
    name: "confirmRelayed",
    params: z
        .object({
            meeting: z.string().min(1),
            /** Item ids (i42) or question labels (Q12) an agent answered from what the user said. */
            items: z.array(z.string().min(1)).min(1),
            /** Items of other meetings, shown in the same window. */
            also: z
                .array(z.object({ meeting: z.string().min(1), items: z.array(z.string().min(1)).min(1) }))
                .optional(),
            /** The user asked to see the window again after answering Not now: a new one is posted. */
            askAgain: z.boolean().optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ request?, adopted: [{ meeting, items, token }], left, skipped }",
    effect: "reversible",
    doc: `Ask the user, in one confirmation window, whether answers an agent relayed from chat are the user's own: each row is the item with its decision, the user's quoted words, a Play button for its range and its own tick. Each ticked answer becomes the user's decision (journal actor request, relayedBy the agent), so voice samples and learning use it; Undo brings the agent's back. An agent's first call posts the window and throws the FOR AGENTS block; the same call again after the user answered records the ticked rows. A request that ended without the user's answer (withdrawn, timed out, unreachable) or whose window no longer shows it is posted again as a new attempt with the current rows; after the user's Not now it throws the block until askAgain: true says the user asked for the window again. CLI twin: ${toolCommand("meetings listen")} <meeting> --confirm-relayed <items...> [--ask-again] (another meeting's item as <meeting>:<item>) --json.`,
});

export const voiceLibraryMethods = {
    add: defineMethod({
        name: "voices.add",
        params: z
            .object({
                meeting: z.string().min(1),
                fromSec: z.number().nonnegative(),
                toSec: z.number().positive(),
                person: z.string().min(1),
                confirmed: z.boolean().optional(),
            })
            .strict(),
        result: z.unknown(),
        resultName: "{ samples, skipped?, confirmedBy }",
        effect: "reversible",
        doc: `Save the complete lines of the interval as the person's voice samples. Only the user confirms a sample: an agent's call with confirmed: true asks the user in a confirmation window and throws the FOR AGENTS block until the user confirmed there; the same call again then saves. Without confirmed it throws the block that says to ask the user first. CLI twin: ${toolCommand("meetings voices add")} <meeting> --from <time> --to <time> --person <name> --confirmed --json.`,
    }),
    list: defineMethod({
        ...voicesList,
        doc: `Return people, confirmed samples, learnt voices and conflicts in the requested scope, as in ${toolCommand("meetings voices")} [--project <p> | --meeting <id> | --all] --json.`,
    }),
    sample: defineMethod({
        ...voicesSample,
        doc: `Return a hash-verified track, file, channel and playback interval by stable ID or scoped sample number. CLI: ${toolCommand("meetings voices play")} <person> --sample <id|number> --no-start --json.`,
    }),
    samples: defineMethod({
        ...voicesList,
        name: "voices.samples",
        params: voicesList.params.required({ person: true }),
        doc: `Return the person's stable sample IDs and source details, as in ${toolCommand("meetings voices samples")} <person>.`,
    }),
    quality: defineMethod({
        ...voicesQuality,
        doc: `Return independent sample counts, neighbors and advisory outliers for each learnt voice, as in ${toolCommand("meetings voices quality")}.`,
    }),
    play: defineMethod({
        ...voicesSample,
        name: "voices.play",
        params: voicesSample.params.extend({ start: z.boolean().optional(), player: z.string().optional() }),
        effect: "reversible",
        doc: `Play the clip and return its verified path, track, channel and interval. Set start to false to resolve the clip as in ${toolCommand("meetings voices play")} <person> --sample <id> --no-start.`,
    }),
    move: defineMethod({
        ...voicesMove,
        doc: `Move a sample to the given owner and block the former owner from relearning it. Return the receipt or refusal from ${toolCommand("meetings voices move")}.`,
    }),
    reject: defineMethod({
        ...voicesReject,
        doc: `Reject the owner or source by sample ID. Return the receipt or refusal from ${toolCommand("meetings voices reject")}.`,
    }),
    remove: defineMethod({
        ...voicesRemove,
        doc: `Return the IDs and suggestions affected by ${toolCommand("meetings voices remove")}. Set preview to true for a planToken to pass when confirming.`,
    }),
    apply: defineMethod({
        ...voicesApply,
        doc: `Run the meeting's naming pass (its speaker suggestions from voices and seats) and return { meeting, added, warnings }. Names stay suggested; nothing is confirmed. One pass per meeting runs at a time in every process: this waits for one already running, then runs on what it left. A pass that a newer write overtook plans again from the record as it is now; a pass that changes nothing leaves the record as it was. CLI twin: ${toolCommand("meetings voices apply")} <meeting> --json.`,
    }),
    undo: defineMethod({
        ...voicesUndo,
        doc: `Undo a correction by token. Return the receipt or refusal from ${toolCommand("meetings voices undo")}.`,
    }),
    rename: defineMethod({
        ...voicesRename,
        doc: `Name a person's voice samples again with no wrong-person refusal: a target the people list knows becomes a people merge (undo.method people.unmerge), a new name re-keys the samples (undo.method voices.undo). Set preview to true for the mechanism, sample IDs and planToken to pass when confirming. CLI: ${toolCommand("meetings voices rename")} <person> --to <person> [--yes] --json.`,
    }),
};

export const meetingsToolsetApi = defineApi({
    id: "meetings",
    global: "meetings",
    title: "Meetings",
    summary:
        "List and open meetings; read their corrected transcript, evidence and items; suggest, confirm and reject items; name speakers.",
    methods: [
        roomDevices,
        decideRoomDevice,
        applySeats,
        backfillVoices,
        dedupeVoices,
        voiceJobs,
        cancelVoiceJob,
        seats,
        thresholds,
        voiceReadiness,
        voices,
        lineEligibility,
        play,
        join,
        joinRepair,
        confirmRelayed,
        ...Object.values(voiceLibraryMethods),
        list,
        levels,
        open,
        look,
        measure,
        locate,
        overview,
        projectsLabels,
        projectsPair,
        projectsUnpair,
        projectsPeople,
        projectsPreview,
        dictionaryTest,
        polishBuild,
        polishCheck,
        polishInit,
        configGet,
        audioPlan,
        audioApply,
        configSet,
        captureCostMethod,
        captureBlockersMethod,
        quitCaptureBlockersMethod,
        recordStart,
        autostartMethod,
        watchOnceMethod,
        assignSweepMethod,
    ],
    handles: [
        {
            name: "Meeting",
            summary: "An opened meeting; `id` and `title` name it. Every call reads the meeting as saved now.",
            methods: [
                info,
                editPerson,
                voiceFeatures,
                prepareListen,
                enrolVoices,
                commentsList,
                commentRead,
                commentWithdraw,
                lines,
                transcript,
                evidence,
                voice,
                acousticInspect,
                acousticCollect,
                voiceCollect,
                voiceEnroll,
                acousticClip,
                voiceScore,
                itemsList,
                itemsRows,
                byChannel,
                add,
                suggest,
                preview,
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
                saveClip,
                exportMethod,
                assignProposals,
                assignAsk,
                assignApply,
            ],
        },
    ],
});
