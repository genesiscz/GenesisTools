import { prepareFindings } from "@app/meetings/lib/add-findings";
import { captureCost } from "@app/meetings/lib/capture-cost";
import { configValueAt, parseConfigPath, setConfigValue } from "@app/meetings/lib/config-edit";
import { decideItems, reopenItems } from "@app/meetings/lib/decide";
import { callerActor, DecisionJournal } from "@app/meetings/lib/decision-journal";
import { testPhrase } from "@app/meetings/lib/dictionary-test";
import { matchPreview } from "@app/meetings/lib/match-preview";
import { projectLabels, setMeetingFields } from "@app/meetings/lib/meeting-fields";
import { OpenedMeeting } from "@app/meetings/lib/opened-meeting";
import { meetingsOverview } from "@app/meetings/lib/overview";
import { meetingLiveId } from "@app/meetings/lib/recorder-shared";
import { reviewRow } from "@app/meetings/lib/review-rows";
import { withMeetingsClient } from "@app/meetings/lib/service/client";
import {
    add,
    assignApply,
    assignAsk,
    audioApply,
    audioPlan,
    commentRead,
    commentWithdraw,
    configGet,
    configSet,
    confirm,
    dictionaryTest,
    editorProject,
    exportMethod,
    itemsList,
    itemsRows,
    lines,
    list,
    meetingsToolsetApi,
    overview,
    projectsLabels,
    projectsPair,
    projectsPeople,
    projectsPreview,
    projectsUnpair,
    recordingMark,
    ref,
    reject,
    rename,
    reopen,
    saveClip,
    screen,
    screenTimelineMethod,
    set,
    speakers,
    suggest,
} from "@app/meetings/lib/service/toolset-api";
import { applyLocalSourceAudio, planLocalSourceAudio } from "@app/meetings/lib/source-audio-backfill";
import { isSuggestRule, SUGGEST_RULES } from "@app/meetings/lib/suggest";
import { runSuggest } from "@app/meetings/lib/suggest-run";
import { correctTranscript, outcomeText } from "@app/meetings/lib/transcript-corrections";
import { rowsRead } from "@app/meetings/lib/window-reads";
import { assertReach } from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import {
    MEETING_UNCHANGED,
    type MeetingItem,
    type MeetingRecord,
    MeetingStore,
} from "@genesiscz/utils/meetings/record";
import type { MeetingPersonEdit } from "@genesiscz/utils/meetings/room-people";
import { ReplToolset } from "@genesiscz/utils/repl/toolset";
import { type recorderSetSchema, settingsPatchOf } from "@genesiscz/utils/repl/toolsets/recorder";
import { callRecorder, readLiveRecording } from "@genesiscz/utils/screen-recorder/live";
import { parseClock } from "@genesiscz/utils/transcribe/render";
import { DEFAULT_SPAN_GAP_SEC, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import type { z } from "zod";

const { log } = logger.scoped("meetings-toolset");
// lazy: saves 13.8 ms cold import (tools ts imports lazy, 2026-11-05) — calendar assignment loads on its first call
const loadAssign = () => import("@app/meetings/lib/assign");

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

/** An item as `items.list` answers it: the review row's label and text, so it reads as `items` and the window do. */
function itemRow(record: MeetingRecord, item: MeetingItem) {
    const row = reviewRow(record, item);
    return {
        id: item.id,
        ...(item.kind === "question" ? { question: row.label } : {}),
        kind: item.kind,
        status: item.status,
        confidence: item.confidence ?? null,
        what: row.what,
        rules: item.rules,
    };
}

export class MeetingsToolset extends ReplToolset {
    readonly api = meetingsToolsetApi;

    async bootstrap(): Promise<Record<string, unknown>> {
        const store = new MeetingStore();
        return {
            meetings: {
                audio: {
                    plan: async (input: z.input<typeof audioPlan.params> = {}) => {
                        audioPlan.params.parse(input);
                        return planLocalSourceAudio({ store });
                    },
                    apply: async (plan: z.input<typeof audioApply.params>["plan"]) =>
                        applyLocalSourceAudio({ plan: audioApply.params.parse({ plan }).plan, store }),
                },
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
            comments: () =>
                withMeetingsClient(async (client) => (await client.call("comment.list", { meeting: id })).comments),
            readComment: (comment: string) => {
                const params = commentRead.params.parse({ id: comment });
                return withMeetingsClient((client) => client.call("comment.read", { meeting: id, ...params }));
            },
            withdrawComment: (comment: string) => {
                const params = commentWithdraw.params.parse({ id: comment });
                return withMeetingsClient((client) => client.call("comment.withdraw", { meeting: id, ...params }));
            },
            get title() {
                return current().title;
            },
            // One line, as a Movie prints: the handle printed every getter and function, and no title (R2-NR5).
            [Symbol.for("nodejs.util.inspect.custom")]: () =>
                `Meeting ${id} ${SafeJSON.stringify(current().title)} (info() reads it; describe("meetings.Meeting") lists its methods)`,
            // Read again on each access, so the findings items.add stores show at once.
            get record() {
                return current();
            },
            info: () => describe(current()),
            evidence: () => opened().evidence(),
            voice: (options: { voices?: number; channel?: number } = {}) =>
                withMeetingsClient((client) => client.call("meeting.voice", { meeting: id, ...options })),
            editPerson: (edit: MeetingPersonEdit) =>
                withMeetingsClient((client) => client.call("meeting.people.edit", { meeting: id, ...edit })),
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
                rows: async (input: z.input<typeof itemsRows.params> = {}) => {
                    const { lowPriority } = itemsRows.params.parse(input);
                    return rowsRead({ store, record: current(), ...(lowPriority ? { lowPriority } : {}) });
                },
                add: async (input: z.input<typeof add.params>) => {
                    const { findings, allowDuplicates, force } = add.params.parse(input);
                    // The same anchors as `items add`; with no transcript at hand, the items are added as given.
                    const source = await opened()
                        .meeting()
                        .catch((error: unknown) => {
                            log.debug({ error, meeting: id }, "no transcript to check the finding anchors against");
                            return undefined;
                        });
                    // NR5 (2026-11-06): this answered the whole meeting record, 88 KB with the calendar attendees.
                    let added: MeetingItem[] = [];
                    let duplicates: MeetingItem[] = [];
                    let warnings: string[] = [];
                    const record = await store.update(
                        id,
                        { command: "items add", change: `${findings.length} findings` },
                        (current) => {
                            const prepared = prepareFindings({
                                findings,
                                items: current.items,
                                transcript: source?.transcript,
                                allowDuplicates,
                                force,
                            });

                            for (const warning of prepared.warnings) {
                                log.warn({ meeting: id }, warning);
                            }

                            current.items.push(...prepared.added);
                            added = prepared.added;
                            warnings = prepared.warnings;
                            duplicates = prepared.duplicates;

                            if (added.length === 0) {
                                return MEETING_UNCHANGED;
                            }
                        }
                    );
                    return {
                        added: added.map((item) => itemRow(record, item)),
                        duplicates: duplicates.map((item) => item.id),
                        warnings,
                    };
                },
                suggest: async (input: z.input<typeof suggest.params> = {}) => {
                    const options = suggest.params.parse(input);
                    const asked = options.rules ?? [...SUGGEST_RULES];
                    const unknown = asked.filter((rule) => !isSuggestRule(rule));

                    if (unknown.length > 0) {
                        throw new Error(`Unknown rule set ${unknown.join(", ")}. Known: ${SUGGEST_RULES.join(", ")}`);
                    }

                    const { fresh, retired, warnings } = await runSuggest({
                        store,
                        record: current(),
                        rules: asked.filter(isSuggestRule),
                        attendance: options.attendance,
                        attendanceId: options.attendanceId,
                    });
                    const record = current();
                    return { fresh: fresh.map((item) => itemRow(record, item)), retired, warnings };
                },
                confirm: decideWith("confirmed"),
                reject: decideWith("rejected"),
                reopen: async (input: z.input<typeof reopen.params>) => {
                    const options = reopen.params.parse(input);
                    const result = await reopenItems({ store, record: current(), ...options, ids: options.ids ?? [] });
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

                    // A rename is a decision: journaled with who made it, so its token undoes it (`reopen --token`).
                    const { entry } = await new DecisionJournal({ store }).apply({
                        meeting: id,
                        action: { kind: "rename", label: parsed.label, name: parsed.name },
                        actor: callerActor(),
                    });
                    return { ...describe(current()), token: entry?.token ?? null };
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
            saveClip: async (input: z.input<typeof saveClip.params>) => {
                const parsed = saveClip.params.parse(input);
                return withMeetingsClient((client) => client.call("moment.save", { ...parsed, meeting: id }));
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
