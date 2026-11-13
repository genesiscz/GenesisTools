import { type RpcHandlers, type RpcTable, toRpcTable } from "@genesiscz/utils/api-descriptor";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingsConfig, MeetingsConfigStore } from "@genesiscz/utils/meetings/config";
import {
    MEETINGS_CONFLICT_CODES,
    MEETINGS_STATE_CODES,
    MeetingsConflictError,
    MeetingsStateError,
} from "@genesiscz/utils/meetings/conflict";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import type { channelEnergy } from "@genesiscz/utils/meetings/energy";
import type { PeopleSource } from "@genesiscz/utils/meetings/people-directory";
import { type MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { editMeetingPerson } from "@genesiscz/utils/meetings/room-people";
import type { voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { RpcError, type RpcErrorOptions } from "@genesiscz/utils/rpc/errors";
import { type LineEvidence, lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import type { cutClip, cutTone, probeAudio } from "../audio";
import { meetingListRow, selectMeetings } from "../list-rows";
import { OpenedMeeting } from "../opened-meeting";
import type { SuggestionReads } from "../project-suggestions";
import { TOOL } from "../shared";
import type { LocalSourceAudioAccess } from "../source-audio-backfill";
import { type LinkedSource, linkedSource } from "../sources";
import { assessIndicator } from "../speaker-indicator";
import { correctTranscript } from "../transcript-corrections";
import { meetingVoices } from "../voice";
import { correctedTranscriptRead, revisionsRead, timedTranscriptView } from "../window-reads";
import { generateWordTimings, meetingWordTimingCache, type WordTimingGenerateDeps } from "../word-timings";
import {
    MEETINGS_REFUSED,
    type MeetingsErrorCode,
    type MeetingsEvent,
    type MeetingsHello,
    type MeetingsNotification,
    type MeetingsResult,
    meetingsApi,
    meetingsErrorDataSchema,
} from "./api";

/**
 * The handlers of the Meetings service's methods, one set for both adapters: the service runs them for its
 * connections, a command without a service runs them in its own process (`InProcessMeetingsClient`). `hello` is the
 * adapter's own, since only it knows the connection.
 */

/** What a handler knows of its call. */
export interface MeetingsCallContext {
    /** Who the connection said it is; set by `hello`. */
    caller?: MeetingsHello;
    signal?: AbortSignal;
    /** `hello` answers through the adapter that owns the connection. */
    hello: (hello: MeetingsHello) => MeetingsResult<"hello">;
    /**
     * True when the handler runs in the caller's own process (the in-process adapter): a caller without a harness in
     * its hello is then this process, whose agent identity a decision reads itself.
     */
    local?: boolean;
    /** Tells the subscribers (the service's connections, or this process's listeners) what a write did. */
    emit?: <E extends MeetingsEvent>(event: E, params: MeetingsNotification<E>) => void;
    /** Sends the caller `$/progress` for this call (a cut's fraction). */
    progress?: (update: { fraction?: number; label?: string }) => void;
}

export interface MeetingsHandlerDeps {
    /** Local audio adapters with their live lookup; tests supply isolated ones and never read this Mac's provider. */
    localSourceAudio?: LocalSourceAudioAccess;
    /** Optional isolated cache/inference dependencies for word-timing generation tests. */
    wordTimings?: Pick<WordTimingGenerateDeps, "cache" | "modelFiles" | "infer">;
    /** The meetings store (a test passes a scratch one). */
    store?: () => MeetingStore;
    /** The transcript source of a record; tests pass a fake one, production asks the record's linked source. */
    linkedSource?: (record: MeetingRecord) => LinkedSource | undefined;
    /** Where a decision's corrections go (tests keep them); the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
    /** The corrections ledger a plan's dictionary reach reads (tests pass lines); the ledger file by default. */
    readLedger?: () => Correction[];
    /** The meetings config (tests pass one); the config file by default. */
    config?: () => Promise<MeetingsConfig>;
    /** The meetings config the library methods (projects, dictionary, config.edit) change; the config file by default. */
    configStore?: () => MeetingsConfigStore;
    /** The clock of a decision's time (tests fix it). */
    now?: () => Date;
    /** Cuts a clip (tests pass a fake); ffmpeg by default. */
    cut?: typeof cutClip;
    /** Reads a recording's tracks and length (tests pass a fake); ffprobe by default. */
    probe?: typeof probeAudio;
    /** Decodes a recording's voice frames for `meeting.voice` (tests pass a table); ffmpeg by default. */
    voiceFrames?: typeof voiceFrames;
    /** Whether ffmpeg can cut here (tests answer); `Bun.which("ffmpeg")` by default. */
    hasFfmpeg?: () => boolean;
    /** Makes a tone preview (tests pass a fake); ffmpeg by default. */
    tone?: typeof cutTone;
    /** The channel energy of a recording (tests pass a table); ffmpeg with the meeting folder's cache by default. */
    energy?: typeof channelEnergy;
    /** Whether a comment listener's pid still runs `meetings listen` (tests answer); the process table by default. */
    listenerAlive?: (pid: number) => boolean;
    /** The people directory's Contacts source (tests pass a fake, or none); darwinkit's Contacts by default. */
    contacts?: () => PeopleSource | undefined;
    /** What the settings page's suggestions read beyond the config and the records (tests pass fakes); the sources' own
     * folder lists and the Calendar app by default. */
    suggestionReads?: () => SuggestionReads;
}

/**
 * A refusal: JSON-RPC error 1100 with `data.code`, the same through the socket and in-process. `data` adds what the
 * code names (`already-decided`'s entry, `unplayable`'s reason).
 */
export function refusal(
    code: MeetingsErrorCode,
    message: string,
    data: Record<string, unknown> = {},
    options: RpcErrorOptions = {}
): RpcError {
    return new RpcError(MEETINGS_REFUSED, message, { ...data, code }, options);
}

/**
 * Any error a handler threw, as the service answers it: an RpcError as it is, a conflict or a meeting state with its
 * own code (the CLI prints `[code] sentence` from it), anything else as `fallback`.
 */
export function asRefusal(error: unknown, fallback: MeetingsErrorCode = "failed"): RpcError {
    if (error instanceof RpcError) {
        return error;
    }

    if (error instanceof MeetingsConflictError || error instanceof MeetingsStateError) {
        return refusal(error.code, error.message, {}, { cause: error });
    }

    return refusal(fallback, error instanceof Error ? error.message : String(error), {}, { cause: error });
}

/** The code of a refusal (`data.code`); undefined for a transport error (a bad param, an unknown method). */
export function refusalCode(error: RpcError): MeetingsErrorCode | undefined {
    if (error.code !== MEETINGS_REFUSED) {
        return undefined;
    }

    const data = meetingsErrorDataSchema.safeParse(error.data);
    return data.success ? data.data.code : undefined;
}

/** A refusal the service did not class as a conflict or a meeting state; `code` names it, `data` is its error data. */
export class MeetingsServiceError extends Error {
    constructor(
        readonly code: MeetingsErrorCode,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "MeetingsServiceError";
    }
}

const isConflictCode = (code: string): code is MeetingsConflictError["code"] =>
    (MEETINGS_CONFLICT_CODES as readonly string[]).includes(code);
const isStateCode = (code: string): code is MeetingsStateError["code"] =>
    (MEETINGS_STATE_CODES as readonly string[]).includes(code);

/**
 * The error a client throws for a failed call: a conflict or a meeting state as its own class, so the CLI's
 * `errorText` prints the same `[code] sentence` it printed before the service; anything else as a
 * `MeetingsServiceError` with the service's sentence.
 */
export function clientError(error: unknown): Error {
    if (!(error instanceof RpcError)) {
        return error instanceof Error ? error : new Error(String(error));
    }

    const code = refusalCode(error) ?? "failed";

    if (isConflictCode(code)) {
        return new MeetingsConflictError(code, error.message);
    }

    if (isStateCode(code)) {
        return new MeetingsStateError(code, error.message);
    }

    return new MeetingsServiceError(code, error.message, error.data);
}

/** The record a command names, or the refusal the CLI printed for it before the service. */
export function recordOf(store: MeetingStore, ref: string): MeetingRecord {
    let record: MeetingRecord | undefined;

    try {
        record = store.resolve(ref);
    } catch (error) {
        throw asRefusal(error, "meeting-ref");
    }

    if (!record) {
        throw refusal("meeting-not-found", `No meeting "${ref}". List them: ${TOOL} list`);
    }

    return record;
}

const { log } = logger.scoped("meetings-service");

const decisions = () => import("./decision-handlers");
const moments = () => import("./moment-handlers");
const reads = () => import("./reads-handlers");
const comments = () => import("./comment-handlers");
const people = () => import("./people-handlers");
const library = () => import("./library-handlers");

function changedPeople<T>(value: T, context: MeetingsCallContext): T {
    context.emit?.("people.changed", {});
    return value;
}

/** The handlers of every method but `hello`'s own work, which the context's adapter does. */
export function meetingsHandlers(deps: MeetingsHandlerDeps = {}): RpcHandlers<typeof meetingsApi, MeetingsCallContext> {
    const storeOf = deps.store ?? (() => new MeetingStore());
    const acousticTarget = () => ({ store: storeOf(), linkedSource: deps.linkedSource });

    return {
        hello: (params, context) => context.hello(params),
        "meetings.list": (params) => {
            const records = selectMeetings(storeOf(), { project: params.project, limit: params.limit });
            return params.full ? records : records.map(meetingListRow);
        },
        "meeting.show": (params) => recordOf(storeOf(), params.ref),
        "meeting.suggest": async (params, context) => {
            const store = storeOf();
            const record = recordOf(store, params.meeting);
            const { runSuggest } = await import("../suggest-run");
            const result = await runSuggest({
                store,
                record,
                rules: ["speakers", "evidence", "terms"],
                attendance: params.attendance,
            });
            context.emit?.("meeting.changed", { meeting: record.id, parts: ["show", "speakers", "transcript"] });
            return { added: result.fresh.length, warnings: result.warnings };
        },
        "meeting.listen.prepare": async (params, context) => {
            const store = storeOf();
            const record = recordOf(store, params.meeting);
            const opened = OpenedMeeting.of(store, record, deps.linkedSource?.(record));
            const { addQualityQuestions, qualityVoiceFeatures } = await import("../listen-quality");
            const entries = (await opened.meeting()).transcript;
            const features = params.group === "long-stretch" ? await qualityVoiceFeatures(opened) : undefined;
            let questions: string[] = [];
            await store.update(record.id, { command: "listen", change: "prepare " + params.group }, (current) => {
                questions = addQualityQuestions({
                    record: current,
                    entries,
                    features,
                    spotCheck: params.group === "spot-check" ? (params.count ?? 20) : undefined,
                    longStretchWords: params.group === "long-stretch" ? (params.words ?? 50) : undefined,
                    // `--apply-above` reaches the long-stretch preparation: a line below it is unsure enough to ask.
                    below: params.below,
                    channel: current.evidence?.channels?.layout === "right-mic" ? 0 : 1,
                });
            });
            context.emit?.("meeting.changed", { meeting: record.id, parts: ["show", "transcript"] });
            return { meeting: record.id, questions };
        },
        "meeting.voice.enrol": async (params, context) => {
            const store = storeOf();
            const record = recordOf(store, params.meeting);
            const { enrolMeetingVoices } = await import("../voice-enrolment");
            const result = await enrolMeetingVoices({
                store,
                opened: OpenedMeeting.of(store, record, deps.linkedSource?.(record)),
            });
            context.emit?.("meeting.changed", { meeting: record.id, parts: ["show", "transcript", "speakers"] });
            return result;
        },
        "meeting.people.edit": async (params, context) => {
            const store = storeOf();
            const current = recordOf(store, params.meeting);
            let selfName: string | undefined;
            if (params.atMic && !current.participants.some((person) => person.self)) {
                selfName = (await OpenedMeeting.of(store, current, deps.linkedSource?.(current)).evidence())?.selfName;
            }
            const record = await editMeetingPerson({ store, meeting: params.meeting, edit: params, selfName });
            context.emit?.("meeting.changed", { meeting: record.id, parts: ["show", "speakers", "transcript"] });
            context.emit?.("people.changed", {});
            return record;
        },
        "meeting.voice": async (params) => {
            const store = storeOf();
            const record = recordOf(store, params.meeting);
            return meetingVoices({
                opened: OpenedMeeting.of(store, record, deps.linkedSource?.(record)),
                voices: params.voices,
                channel: params.channel,
                frames: deps.voiceFrames,
            });
        },
        "meeting.transcript": async (params) => {
            const store = storeOf();
            const record = recordOf(store, params.ref);
            // One opened meeting for the corrections, the indicator and every preview: the source loads once.
            const opened = OpenedMeeting.of(store, record, deps.linkedSource?.(record));
            const { applied } = await correctedTranscriptRead({
                store,
                record,
                format: "json",
                // As commander hands `transcript --format json` its flags: the dictionary is on unless turned off.
                flags: {
                    dictionary: params.dictionary ?? true,
                    frontmatter: true,
                    ...(params.withSuggested !== undefined ? { withSuggested: params.withSuggested } : {}),
                    ...(params.applyAbove !== undefined ? { applyAbove: params.applyAbove } : {}),
                },
                opened,
            });
            const view = timedTranscriptView(record, applied);
            // The indicator is optional enrichment: evidence that does not read leaves the corrected lines without it.
            let measured: LineEvidence[] = [];
            let selfName = "";

            try {
                const evidence = await opened.evidence();
                selfName = evidence?.selfName ?? "";
                measured = evidence
                    ? lineEvidence((await opened.meeting()).transcript, evidence, await opened.presence())
                    : [];
            } catch (error) {
                log.warn({ error, meeting: record.id }, "speaking indicator not read; the transcript has no indicator");
            }

            const assessed = assessIndicator({ lines: measured, selfName });
            // One lookup by start for the main entries and every preview, the first line of a start as before.
            const byStart = new Map<number, LineEvidence>();

            for (const line of measured) {
                if (!byStart.has(line.startSec)) {
                    byStart.set(line.startSec, line);
                }
            }

            const withIndicator = <T extends { startSec?: number }>(entry: T) => {
                const line = entry.startSec === undefined ? undefined : byStart.get(entry.startSec);
                return line
                    ? {
                          ...entry,
                          indicator: { names: Object.keys(line.speaking), ignored: assessed.reasons.get(line.index) },
                      }
                    : entry;
            };
            const timingCache = deps.wordTimings?.cache ?? meetingWordTimingCache(record.id);
            const timed = timingCache.read(view.entries);
            const previews = params.previewThresholds
                ? await Promise.all(
                      params.previewThresholds.map(async (threshold) => {
                          const config = await opened.config();
                          const changed = {
                              ...config,
                              global: {
                                  ...config.global,
                                  suggest: { ...config.global.suggest, applyAbove: threshold },
                              },
                          };
                          const preview = correctTranscript({
                              record,
                              transcript: (await opened.meeting()).transcript,
                              config: changed,
                              format: "json",
                              withSuggested: true,
                              dictionary: params.dictionary ?? true,
                          });
                          return {
                              threshold,
                              // The cached word timings follow the preview's own lines, as they do the main ones.
                              entries: timingCache
                                  .read(timedTranscriptView(record, preview).entries)
                                  .entries.map(withIndicator),
                          };
                      })
                  )
                : undefined;
            return {
                meeting: view.meeting,
                ...timed,
                ...(previews ? { previews } : {}),
                entries: timed.entries.map(withIndicator),
            };
        },
        "meeting.wordTimings.generate": async (params, context) => {
            const store = storeOf();
            const record = recordOf(store, params.ref);
            const result = await generateWordTimings(
                {
                    meeting: record.id,
                    window: { fromSec: params.fromSec, toSec: params.toSec },
                    model: params.model,
                    language: params.language,
                    signal: context.signal,
                    progress: context.progress,
                },
                {
                    ...deps.wordTimings,
                    read: async () => {
                        const current = recordOf(store, record.id);
                        const linked = deps.linkedSource?.(current) ?? (await linkedSource(current));
                        const { applied } = await correctedTranscriptRead({
                            store,
                            record: current,
                            format: "json",
                            flags: { dictionary: true },
                            linked,
                        });
                        const evidence = await linked.source.evidence(linked.sourceMeetingId);
                        if (!evidence?.audioPath) {
                            throw new Error("This meeting has no source audio for word timing generation");
                        }
                        return {
                            lines: timedTranscriptView(current, applied).entries,
                            audioPath: evidence.audioPath,
                            live: current.recording?.status === "recording" || current.recording?.status === "paused",
                        };
                    },
                }
            );
            context.emit?.("meeting.wordTimings.changed", { meeting: record.id, revision: result.cacheRevision });
            return result;
        },
        "meeting.revisions": (params) => {
            const store = storeOf();
            const record = recordOf(store, params.ref);
            return revisionsRead({ store, record, linked: deps.linkedSource?.(record) });
        },
        // The decisions load the journal and its rules (about 40 ms) only when a call decides.
        "decision.plan": async (params, context) => (await decisions()).planDecision(params, context, storeOf(), deps),
        "decision.apply": async (params, context) =>
            (await decisions()).applyDecision(params, context, storeOf(), deps),
        "decision.revert": async (params, context) =>
            (await decisions()).revertDecision(params, context, storeOf(), deps),
        "journal.read": async (params) => (await decisions()).readJournal(params, storeOf()),
        // The Moments load the engine and the OCR readers only when a call plays.
        "moment.plan": async (params) => (await moments()).planMomentCall(params, storeOf(), deps),
        "moment.clip": async (params, context) => (await moments()).clipMomentCall(params, context, storeOf(), deps),
        "moment.save": async (params, context) => (await moments()).saveMomentCall(params, context, storeOf(), deps),
        "tone.preview": async (params) => (await moments()).previewTone(params, deps),
        "tone.presets": async () => (await moments()).listTonePresets(),
        "meeting.audio": async (params) => (await moments()).readMeetingAudio(params, storeOf(), deps),
        // The acoustic reads open the meeting with the service's source, as every other read does.
        "acoustic.inspect": async (params) =>
            (await import("../acoustic")).inspectAcoustic({ ...acousticTarget(), ...params }),
        "acoustic.clip": async (params) =>
            (await import("../acoustic")).acousticClip({ ...acousticTarget(), ...params }),
        "voice.score": async (params) => (await import("../acoustic")).voiceMeeting({ ...acousticTarget(), ...params }),
        "voice.prepare": async () => ({
            path: await (await import("@genesiscz/utils/meetings/voice")).prepareVoiceModel(),
        }),
        "voice.enroll": async (params) =>
            (await import("../acoustic")).voiceMeeting({ ...acousticTarget(), ...params }),
        "acoustic.collect": async (params) =>
            (await import("../acoustic")).collectAcoustic({ ...acousticTarget(), meeting: params.meeting }),
        "voice.collect": async (params) =>
            (await import("../acoustic")).collectVoiceEvidence({ ...acousticTarget(), meeting: params.meeting }),
        "meeting.speakers": async (params) => (await reads()).readSpeakers(params, storeOf(), deps),
        "meeting.screen": async (params) => (await reads()).readScreen(params, storeOf()),
        "meeting.timeline": async (params) => (await reads()).readTimeline(params, storeOf()),
        "meeting.waveform": async (params) => (await reads()).readWaveform(params, storeOf(), deps),
        "meetings.overview": async (params) => (await reads()).readOverview(params, storeOf()),
        "sourceAudio.plan": async () =>
            (await import("../source-audio-backfill")).planLocalSourceAudio({
                store: storeOf(),
                local: deps.localSourceAudio,
            }),
        "sourceAudio.apply": async ({ plan }) =>
            (await import("../source-audio-backfill")).applyLocalSourceAudio({
                plan,
                store: storeOf(),
                local: deps.localSourceAudio,
            }),
        "config.read": async (params) => (await reads()).readConfig(params),
        "config.set": async (params) => (await reads()).setConfig(params),
        "config.unset": async (params) => (await reads()).unsetConfig(params),
        "config.edit": async (params) => (await library()).editConfig(params, deps),
        "meeting.rows": async (params) => (await reads()).readRows(params, storeOf(), deps),
        "comment.stage": async (params, context) => (await comments()).stageComment(params, context, storeOf(), deps),
        "comment.list": async (params) => (await comments()).listComments(params, storeOf(), deps),
        "comment.unstage": async (params, context) =>
            (await comments()).unstageComment(params, context, storeOf(), deps),
        "comment.send": async (params, context) => (await comments()).sendComments(params, context, storeOf(), deps),
        "comment.read": async (params, context) =>
            (await comments()).acknowledgeComment(params, context, storeOf(), deps),
        "comment.withdraw": async (params, context) =>
            (await comments()).withdrawComment(params, context, storeOf(), deps),
        // The people directory loads Contacts (darwinkit) only when a call asks for people.
        "people.known": async (params) => (await people()).knownPeople(params, storeOf(), deps),
        "people.meetings": async (params) => (await people()).personMeetings(params, storeOf(), deps),
        "people.add": async (params, context) =>
            changedPeople(await (await people()).addPerson(params, storeOf(), deps), context),
        "people.hide": async (params, context) =>
            changedPeople(await (await people()).hidePerson(params, storeOf(), deps), context),
        "people.planMerge": async (params) => (await people()).planPeopleMerge(params, storeOf(), deps),
        "people.merge": async (params, context) =>
            changedPeople(await (await people()).mergePeople(params, storeOf(), deps), context),
        "people.unmerge": async (params, context) =>
            changedPeople(await (await people()).unmergePeople(params, storeOf(), deps), context),
        // The library (the settings page's projects, dictionary and source rules) loads its writers only when asked.
        "projects.add": async (params) => (await library()).addProject(params, deps),
        "projects.rename": async (params) => (await library()).renameKnownProject(params, storeOf(), deps),
        "projects.remove": async (params) => (await library()).removeKnownProject(params, storeOf(), deps),
        "projects.restore": async (params) => (await library()).restoreRemovedProject(params, storeOf(), deps),
        "projects.labels": async (params) => (await library()).changeProjectLabels(params, deps),
        "projects.unpair": async (params) => (await library()).unpairProjects(params, deps),
        "projects.preview": async (params) => (await library()).previewProjects(params, storeOf(), deps),
        "projects.suggestions": async () => (await library()).suggestProjectValues(storeOf(), deps),
        "projects.meetingPeople": async (params) => (await library()).meetingPeopleOf(params, storeOf(), deps),
        "projects.pairFromMeetings": async (params) => (await library()).pairMeetingPeople(params, storeOf(), deps),
        "dictionary.show": async (params) => (await library()).showDictionary(params, deps),
        "dictionary.add": async (params) => (await library()).addDictionaryEntry(params, deps),
        "dictionary.remove": async (params) => (await library()).removeDictionaryEntry(params, deps),
        "dictionary.test": async (params) => (await library()).testDictionaryPhrase(params, deps),
    };
}

/** The method table both adapters call: params checked against the descriptor, then the handler. */
export function meetingsTable(deps: MeetingsHandlerDeps = {}): RpcTable<MeetingsCallContext> {
    return toRpcTable<typeof meetingsApi, MeetingsCallContext>(meetingsApi, meetingsHandlers(deps));
}
