import { decideItems } from "@app/meetings/lib/decide";
import { findingItems, findingProblems, findingSchema } from "@app/meetings/lib/findings";
import { itemWhat } from "@app/meetings/lib/item-text";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { resolveProject } from "@app/meetings/lib/project";
import { questionLabel } from "@app/meetings/lib/questions";
import { meetingLiveId } from "@app/meetings/lib/recorder";
import { meetingScreen } from "@app/meetings/lib/screen-boxes";
import { isSuggestRule, SUGGEST_RULES } from "@app/meetings/lib/suggest";
import { runSuggest } from "@app/meetings/lib/suggest-run";
import { correctTranscript, outcomeText } from "@app/meetings/lib/transcript-corrections";
import { defineApi, defineMethod } from "@genesiscz/utils/api-descriptor";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { OCR_BOX_LEVELS } from "@genesiscz/utils/macos/ocr-boxes";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
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

const ref = z.object({ ref: z.string().min(1) });
const ids = z.array(z.string().min(1));
const recordDoc =
    "{ id, title, start, project, sources, speakers, items: { suggested, confirmed, rejected }, summary }";

const list = defineMethod({
    name: "list",
    params: z.object({ project: z.string().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, title, start, project, items, open }[]",
    effect: "read",
    doc: "The stored meetings, newest first, optionally of one project. `open` counts the suggested items nobody decided yet.",
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
    params: z.object({ status: z.enum(ITEM_STATUSES).optional(), kind: z.string().optional() }).strict(),
    result: z.unknown(),
    resultName: "{ id, question?, kind, status, confidence, what, rules }[]",
    effect: "read",
    doc: 'The meeting\'s items, optionally of one status ("suggested", "confirmed", "rejected") or kind ("speaker-range", "term", "question", "join", "label"). `what` is the one-line text the items command shows.',
});
const add = defineMethod({
    name: "items.add",
    params: z.object({ findings: z.array(findingSchema).min(1) }),
    result: z.unknown(),
    effect: "reversible",
    doc: "Add validated findings under the meeting store lock.",
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
    params: z
        .object({
            ids: ids.optional(),
            minConfidence: z.number().min(0).max(1).optional(),
            speaker: z.string().optional(),
            proposed: z.string().optional(),
        })
        .strict(),
    result: z.unknown(),
    resultName: "{ decided: string[], skipped: { id, reason, needs }[] }",
    effect: "reversible" as const,
};
const confirm = defineMethod({
    name: "items.confirm",
    ...decide,
    doc:
        'Confirm items (ids "i3", or a question\'s number "Q2"), or every suggested item at or above minConfidence (0..1). Transcripts apply confirmed items. A range nobody named needs `speaker`, a term with no spelling needs `proposed`; a question is answered by ear (' +
        toolCommand("meetings listen") +
        "). Those come back in `skipped` with the reason and what they need.",
});
const reject = defineMethod({
    name: "items.reject",
    ...decide,
    doc: "Reject items by id, or every suggested item at or above minConfidence: they are never suggested again.",
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
    doc: 'Name a speaker label ("Speaker 2" → "Alice"): this meeting\'s transcripts use the name from now on.',
});
const set = defineMethod({
    name: "set",
    params: z.object({ title: z.string().min(1).optional(), project: z.string().min(1).optional() }).strict(),
    result: z.unknown(),
    resultName: recordDoc,
    effect: "reversible",
    doc: "Change the meeting's title and/or project (a new project name is added to the known projects).",
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
    effect: "read",
    doc: 'The screen frames at a transcript time (at, windowSec) or that show a text (match, limit), from the recording\'s ocr.jsonl. With boxes: { outDir }, each frame\'s OCR boxes in frame pixels (level "block" default, or "line"): the ones holding match, or without match the ones that changed since the display\'s earlier frame, drawn numbered on the frame plus one PNG crop each in outDir.',
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
        methods: [list, open],
        handles: [
            {
                name: "Meeting",
                summary: "An opened meeting. Every call reads the meeting as saved now.",
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
                    speakers,
                    rename,
                    set,
                    recordingSettings,
                    setRecordingSettings,
                    screen,
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
                            project: record.project ?? null,
                            items: record.items.length,
                            open: record.items.filter((item) => item.status === "suggested").length,
                        }));
                },
                open: (refText: string) => this.meeting(store, ref.parse({ ref: refText }).ref),
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
        const callLive = (method: "settings.get" | "settings.set", params?: unknown) => {
            if (!readLiveRecording(liveId)) {
                throw new Error(`The meeting ${id} is not being recorded now (no live recording ${liveId})`);
            }

            return callRecorder({ id: liveId, method, params });
        };
        const decideWith = (status: "confirmed" | "rejected") => async (input: z.input<typeof decide.params>) => {
            const options = decide.params.parse(input);
            const result = await decideItems({ store, record: current(), status, ids: options.ids ?? [], ...options });
            log.info(
                { meeting: id, status, decided: result.decided.length, skipped: result.skipped.length },
                "items decided"
            );
            return result;
        };

        return {
            record: found,
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
                add: (input: z.input<typeof add.params>) => {
                    const { findings } = add.params.parse(input);
                    return store.update(
                        id,
                        { command: "items add", change: `${findings.length} findings` },
                        (record) => {
                            const problems = findingProblems(findings, record.items);

                            if (problems.length > 0) {
                                throw new Error(problems.join("; "));
                            }

                            record.items.push(...findingItems(findings, record.items, new Date().toISOString()));
                        }
                    );
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
                    const record = await store.update(
                        id,
                        { command: "speakers rename", change: `${parsed.label} → ${parsed.name}` },
                        (current) => {
                            current.speakers.labels[parsed.label] = parsed.name;
                        }
                    );
                    return describe(record);
                },
            },
            settings: async () => callLive("settings.get"),
            setSettings: async (input: z.input<typeof recorderSetSchema>) =>
                callLive("settings.set", settingsPatchOf(input)),
            set: async (input: z.input<typeof set.params>) => {
                const { title, project } = set.params.parse(input);

                if (!title && !project) {
                    throw new Error("Nothing to set: give title and/or project");
                }

                const resolved = project
                    ? (await resolveProject({ config: new MeetingsConfigStore(), flag: project, quiet: true })).project
                    : undefined;
                const record = await store.update(
                    id,
                    {
                        command: "set",
                        change: [resolved && `project ${resolved}`, title && `title "${title}"`]
                            .filter(Boolean)
                            .join(", "),
                    },
                    (current) => {
                        current.project = resolved ?? current.project;
                        current.title = title ?? current.title;
                    }
                );
                return describe(record);
            },
            screen: async (input: z.input<typeof screen.params>) => {
                const options = screen.params.parse(input);
                const atSec = typeof options.at === "string" ? parseClock(options.at) : options.at;

                if (typeof options.at === "string" && atSec === undefined) {
                    throw new Error(`at "${options.at}" is no transcript time: use seconds, 1:23:50 or 23:50`);
                }

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
