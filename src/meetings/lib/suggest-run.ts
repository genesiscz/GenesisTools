import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileIdentityCache, fileIdentity } from "@genesiscz/utils/fs/identity-cache";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { languageSettings, type MeetingsConfig, resolveDictionary } from "@genesiscz/utils/meetings/config";
import { type AcousticShare, collectEcho, echoForRange, readEchoCache } from "@genesiscz/utils/meetings/echo";
import { peopleDirectory } from "@genesiscz/utils/meetings/people-directory";
import type { DecisionActor, MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { roomSeatNames } from "@genesiscz/utils/meetings/seats";
import type { VoiceProgress } from "@genesiscz/utils/meetings/voice";
import { type LineVoice, lineVoices, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { collectVoiceFrames } from "@genesiscz/utils/meetings/voice-frame-cache";
import { readVoiceLibrary, type VoiceLibrarySnapshot } from "@genesiscz/utils/meetings/voice-library";
import { profiler } from "@genesiscz/utils/profile";
import { mergeDictionaries } from "@genesiscz/utils/transcribe/dictionary";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { MutedCallLines } from "./call-mutes";
import { contextEntryText } from "./context-file";
import { indicatorGaps } from "./indicator-facts";
import { addQualityQuestions } from "./listen-quality";
import { localSpeechDuring } from "./local-speech";
import { OpenedMeeting } from "./opened-meeting";
import { type MeetingReviewDoor, requestMeetingQuestionReview } from "./person-door";
import { errorText } from "./shared";
import { preparePreviewLabels, proposeSpeakerLabels } from "./speaker-labels";
import { directoryMatcher, type SamePerson } from "./speaker-scores";
import { knownWord, restoreThresholdRetirements, type SuggestRule, settledTermItems, suggestItems } from "./suggest";
import { anchoredMeetingVoices } from "./voice";
import { VOICE_PASS_HISTORY } from "./voice-readiness";
import type { WordCheckChoice } from "./word-check";

const { log } = logger.scoped("meetings-suggest");
const prof = profiler.scope("meetings-suggest");

/**
 * One person under two names, as the people directory knows them for this meeting (its merges and aliases, from the
 * meetings, the projects and the people book; never Contacts, so a suggest raises no dialog). A directory that does
 * not read leaves the identity rules alone.
 */
async function directorySamePerson(options: {
    store: MeetingStore;
    config: MeetingsConfig;
    meeting: string;
}): Promise<SamePerson | undefined> {
    try {
        const known = await peopleDirectory({ store: options.store, config: options.config }).known("", {
            meeting: options.meeting,
            limit: 200,
            kinds: ["meetings", "projects", "own"],
        });
        return directoryMatcher(known.people);
    } catch (error) {
        log.warn({ error, meeting: options.meeting }, "the people directory did not read; speakers fold by name only");
        return undefined;
    }
}

/**
 * Collects what the record lacks (platform, attendance, channel layout). A step that fails is a warning of the run's
 * result, so the window and the REPL see it as the CLI does, never only a line on stderr.
 */
async function collectForSuggest(
    opened: OpenedMeeting,
    warnings: string[],
    attendance?: { spec: string; id?: string }
): Promise<MeetingRecord> {
    const { platform, evidence, id } = opened.record;

    try {
        if (platform && opened.record.attendance && evidence?.channels) {
            // Older records may still say "unknown", or the owner may have changed the separation setting.
            const layout = opened.sourceRef ? (await opened.energy()).calibration?.layout : undefined;
            if (layout && layout !== evidence.channels.layout) {
                await opened.calibrate();
            }
            return opened.record;
        }

        // The run's explicit attendance choice reaches collection, so a title lookup never stores another chat.
        const outcome = await opened.collect({ attendance });

        for (const note of outcome.notes) {
            if (note.ok) {
                log.info({ meeting: id }, note.text);
            } else {
                warnings.push(note.text);
            }
        }

        return outcome.record;
    } catch (error) {
        log.warn({ error, meeting: id }, "collect failed");
        warnings.push(`could not collect the call's facts: ${errorText(error)}`);
        return opened.record;
    }
}

/** The quality questions' spans: each transcript entry as the transcript lines read it. */
function entrySpans(entries: TranscriptEntry[]): Array<{ index: number; fromSec: number; toSec: number }> {
    const lines = new TranscriptLines(entries);
    return entries.flatMap((_entry, index) => {
        const span = lines.span(index);
        return span ? [{ index, fromSec: span.fromSec, toSec: span.toSec }] : [];
    });
}

/**
 * Runs the rules on a meeting's transcript and adds what they find as suggested items, in one save: the CLI's
 * `suggest` and the REPL's meeting.suggest(). The platform, attendance and channel layout are collected first when the
 * record lacks them. A word check that cannot run is a warning, not a failure: the term rules then skip every word
 * with a Czech letter. When the caller is an agent and its run leaves word or dictionary questions, the owner gets one
 * request per run whose click opens the Items tab (`requestMeetingQuestionReview`); a delivery failure is a warning.
 */
export async function runSuggest(options: {
    store: MeetingStore;
    record: MeetingRecord;
    rules: SuggestRule[];
    attendance?: string;
    attendanceId?: string;
    wordCheck?: WordCheckChoice;
    onProgress?: VoiceProgress;
    /** Stops the run before it saves anything; the voice pass kills its workers (`$/cancel`, a closed connection). */
    signal?: AbortSignal;
    /** Who runs it. Without an actor nobody is asked (voice enrolment, tests). */
    actor?: DecisionActor;
    /** The person area; tests pass a fake. */
    gt?: MeetingReviewDoor;
}): Promise<{ fresh: MeetingItem[]; retired: string[]; warnings: string[] }> {
    const { store, record } = options;
    using _run = prof.section("run");
    const warnings: string[] = [];
    const opened = prof.measure("open", () => OpenedMeeting.of(store, record));
    let ranVoicePass = false;
    if (options.rules.includes("speakers") || options.rules.includes("evidence")) {
        const { voiceProgressForMeeting, voiceSignalForMeeting } = await import("./speaker-labels/voice");
        let beforeProgress = prof.enabled ? prof.start("before-first-voice-progress") : undefined;
        voiceProgressForMeeting.set(opened, (done, total) => {
            ranVoicePass = true;
            beforeProgress?.();
            beforeProgress = undefined;
            options.onProgress?.(done, total);
        });

        if (options.signal) {
            voiceSignalForMeeting.set(opened, options.signal);
        }
    }

    options.signal?.throwIfAborted();

    const collected = await prof.measureAsync("collectForSuggest", () =>
        collectForSuggest(
            opened,
            warnings,
            options.attendance ? { spec: options.attendance, id: options.attendanceId } : undefined
        )
    );
    const config = await prof.measureAsync("config", () => opened.config());
    const { inputs, features } = await readSuggestInputs(opened, collected, config, options, warnings, false);
    let fresh: MeetingItem[] = [];
    let retired: string[] = [];
    try {
        options.signal?.throwIfAborted();
        using _save = prof.section("save");
        const history = {
            command: "suggest",
            change: ranVoicePass ? VOICE_PASS_HISTORY : "suggest findings and questions",
        };
        await store.update(record.id, history, (current) => {
            using _mutate = prof.section("save.compute");
            ({ fresh, retired } = applySuggestionRun(current, inputs, config, features));
        });
    } finally {
        inputs.wordCheck?.dispose();
    }

    if (options.actor) {
        using _review = prof.section("review-request");
        const warning = await requestMeetingQuestionReview({
            actor: options.actor,
            runId: randomUUID(),
            record: store.read(record.id) ?? record,
            ...(options.gt ? { gt: options.gt } : {}),
        });
        if (warning) {
            warnings.push(warning);
        }
    }

    return { fresh, retired, warnings };
}

// Retain the much smaller per-line features while editing, never the whole recording's pitch frames.
const featureCache = new FileIdentityCache<{ spans: string; features: Promise<LineVoice[]> }>({ limit: 1 });

async function previewFeatures(path: string, spans: ReturnType<typeof entrySpans>): Promise<LineVoice[]> {
    const identity = fileIdentity(path);
    const key = SafeJSON.stringify(spans);
    const cached = featureCache.get(path, identity);
    if (cached?.spans === key) {
        return cached.features;
    }
    const features = voiceFrames({ audioPath: path }).then((frames) => lineVoices({ frames, spans }));
    const entry = { spans: key, features };
    if (identity) {
        featureCache.set(path, identity, entry);
    }
    try {
        return await features;
    } catch (error) {
        if (featureCache.get(path, identity) === entry) {
            featureCache.delete(path);
        }
        throw error;
    }
}

async function readSuggestInputs(
    opened: OpenedMeeting,
    collected: MeetingRecord,
    config: MeetingsConfig,
    options: { rules: SuggestRule[]; wordCheck?: WordCheckChoice; attendance?: string; attendanceId?: string },
    warnings: string[],
    preview: boolean
) {
    const { store, record } = opened;
    const { rules } = options;
    const needsSpeakerInputs = rules.includes("speakers") || rules.includes("evidence");
    const terms = rules.includes("terms");
    const meeting = await prof.measureAsync("source-meeting", () => opened.meeting());
    const evidence = needsSpeakerInputs ? await prof.measureAsync("evidence.read", () => opened.evidence()) : null;

    // Only indicator evidence that was read can show a gap: a terms-only run, or a source without it, has none to judge.
    if (evidence) {
        for (const gap of prof.measure("evidence.indicator-gaps", () => indicatorGaps({ meeting, evidence }))) {
            warnings.push(`Speaking indicator gap ${gap.fromSec}s to ${gap.toSec}s: ${gap.reason}`);
        }
    }

    const presenceRecord = opened.record;
    const presence = await prof.measureAsync("presence", () =>
        preview ? opened.presence() : opened.suggestionPresence({ ...options, warnings })
    );
    // Labels use stored stays even when this run requested a different attendance source.
    const storedPresence = !options.attendance && opened.record === presenceRecord ? presence : undefined;
    const energy = needsSpeakerInputs ? await prof.measureAsync("energy", () => opened.energy()) : undefined;
    const audioPath = evidence?.audioPath;
    const layout = energy?.calibration?.layout;
    const echo =
        rules.includes("evidence") && audioPath && layout && layout !== "unknown"
            ? await prof.measureAsync("evidence.echo", () =>
                  (preview ? readEchoCache : collectEcho)({
                      audioPath,
                      cachePath: join(store.folder(record.id), "evidence", "echo.json"),
                      layout,
                  })
              )
            : undefined;
    if (preview && audioPath && layout && layout !== "unknown" && !echo) {
        warnings.push(
            "No saved echo evidence is available. A full run can collect it before scoring speaker proposals."
        );
    }
    const share: AcousticShare | undefined = echo
        ? Object.assign(
              (fromSec: number, toSec: number) =>
                  echoForRange(echo, fromSec, toSec)?.cleanMicShare ?? energy?.share?.(fromSec, toSec),
              {
                  acoustic: (fromSec: number, toSec: number) => echoForRange(echo, fromSec, toSec),
                  raw: energy?.share?.raw ?? energy?.share,
                  // The echo wrapper keeps the cached voice matches, or no line of a calibrated meeting has a voice.
                  voice: energy?.share?.voice,
              }
          )
        : energy?.share;
    // One decode and one pitch pass serve both the room voice clustering and the quality questions.
    let features: LineVoice[] | undefined;

    if (rules.includes("evidence")) {
        try {
            const path = await opened.audioPath();
            const spans = entrySpans(meeting.transcript);
            if (preview) {
                features = await previewFeatures(path, spans);
            } else {
                const frames = await prof.measureAsync("evidence.voice-frames", () =>
                    collectVoiceFrames({
                        audioPath: path,
                        cachePath: join(store.folder(record.id), "evidence", "voice-frames.bin"),
                    })
                );
                features = prof.measure("evidence.line-voices", () => lineVoices({ frames, spans }));
            }
        } catch (error) {
            log.warn({ error, meeting: record.id }, "voice change points unavailable");
            warnings.push("Voice change points unavailable; long stretches remain open for listening");
        }
    }

    const roomSize = roomSeatNames(collected.seats).length;
    const roomFeatures = features;
    let voice: LineVoice[] | undefined;

    if (roomFeatures && roomSize > 1) {
        // Clustering is optional evidence: without it the shared-device lines keep their candidates.
        try {
            const micChannel = energy?.calibration?.layout === "right-mic" ? 1 : 0;
            voice = prof.measure("evidence.room-voices", () =>
                anchoredMeetingVoices({
                    record: collected,
                    transcript: meeting.transcript,
                    features: roomFeatures,
                    voices: roomSize,
                    channel: micChannel,
                    micChannel,
                })
            );
        } catch (error) {
            log.warn({ error, meeting: record.id, roomSize }, "room voice clustering unavailable");
            warnings.push(
                `Room voice clustering unavailable (${errorText(error)}); shared-device lines keep their candidates`
            );
        }
    }

    const inputs: Parameters<typeof suggestItems>[0] = {
        measuredLines: evidence
            ? prof.measure("rules.line-evidence", () => lineEvidence(meeting.transcript, evidence, presence, share))
            : [],
        localSpeech: rules.includes("evidence")
            ? prof.measure("evidence.local-speech-history", () =>
                  localSpeechDuring({ start: meeting.start, end: meeting.end })
              )
            : [],
        record: collected,
        meeting,
        rules,
        dictionary: terms
            ? await prof.measureAsync("terms.dictionary", () => opened.dictionary())
            : mergeDictionaries([]),
        sourceWords: terms ? await prof.measureAsync("terms.source-words", () => opened.sourceWords()) : [],
        presence,
        evidence,
        energyMicShare: share,
        // A successfully loaded override belongs to this run. A failed lookup supplied no foreign stays:
        // the record's own roster and this pass's speaker evidence can still establish durable departures.
        ...(!options.attendance || presence === undefined
            ? { leaveSilenceMinutes: config.global.suggest.leaveSilenceMinutes }
            : {}),
        voice,
        labels:
            needsSpeakerInputs && !preview
                ? await prof.measureAsync("speakers.labels", () =>
                      proposeSpeakerLabels(opened, config.global.speakerLabels, storedPresence, {
                          applyAbove: config.global.suggest.applyAbove,
                      })
                  )
                : undefined,
        points: await prof.measureAsync("summary-points", () => opened.summaryPoints()),
        sourceLabels: languageSettings(config).render,
        restatedIdentifiers: config.global.suggest.restatedIdentifiers,
        ...(needsSpeakerInputs
            ? {
                  samePerson: await prof.measureAsync("speakers.directory", () =>
                      directorySamePerson({ store, config, meeting: record.id })
                  ),
              }
            : {}),
        now: new Date().toISOString(),
    };
    if (terms) {
        warnings.push(...prof.measure("terms.context-warnings", () => contextWarnings(collected)));
        const check = await prof.measureAsync("terms.word-check", () => opened.wordCheck(options.wordCheck));

        if (!check.check && options.wordCheck !== "off") {
            warnings.push(
                `The word check is off (${check.reason}); the term rules skip every word with a Czech letter.`
            );
        }

        inputs.wordCheck = check.check;
    }
    return { inputs, features };
}

/** Recompute pending automatic findings. Keep every decision, manual item and target of a retained question. */
function previewSeed(record: MeetingRecord): MeetingRecord {
    const seed = structuredClone(record);
    const retained = seed.items.filter(
        (item) =>
            item.status !== "suggested" ||
            item.decision ||
            (item.rules.length === 0 && !(item.kind === "question" && item.group === "long-stretch")) ||
            item.rules.includes(MeetingRule.Agent) ||
            item.rules.includes(MeetingRule.User) ||
            (item.kind === "question" && item.group === "spot-check")
    );
    const keep = new Set(
        retained.flatMap((item) => (item.kind === "question" ? [item.id, ...item.decides] : [item.id]))
    );
    seed.items = seed.items.filter((item) => keep.has(item.id));
    return seed;
}

export async function previewSuggestionRuns(
    opened: OpenedMeeting,
    current: MeetingsConfig,
    draft: MeetingsConfig,
    signal?: AbortSignal
) {
    const record = opened.record;
    const seed = previewSeed(record);
    const warnings: string[] = [];
    if (!record.platform || !record.attendance || !record.evidence?.channels) {
        warnings.push(
            "Preview uses the evidence already available. A full run can collect additional attendance and channel evidence."
        );
    }
    const { inputs, features } = await readSuggestInputs(
        opened,
        seed,
        current,
        { rules: ["speakers", "evidence", "terms"] },
        warnings,
        true
    );
    try {
        const run = (config: MeetingsConfig, labels: typeof inputs.labels, presence: typeof inputs.presence) => {
            signal?.throwIfAborted();
            const copy = structuredClone(seed);
            applySuggestionRun(
                copy,
                {
                    ...inputs,
                    presence,
                    measuredLines:
                        inputs.evidence && presence !== inputs.presence
                            ? lineEvidence(inputs.meeting.transcript, inputs.evidence, presence, inputs.energyMicShare)
                            : inputs.measuredLines,
                    labels,
                    dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }),
                    leaveSilenceMinutes: config.global.suggest.leaveSilenceMinutes,
                },
                config,
                features
            );
            return copy;
        };
        signal?.throwIfAborted();
        // Both sides of one preview see the same enrollment, including a recalculated attendance pass.
        let library: VoiceLibrarySnapshot | undefined;
        const voiceLibrary = () => (library ??= readVoiceLibrary());
        const scoreLabels = await preparePreviewLabels({
            opened,
            settings: current.global.speakerLabels,
            presence: inputs.presence,
            voiceLibrary,
            signal,
        });
        const labels = await scoreLabels(current.global.speakerLabels.voice, current.global.suggest.applyAbove);
        const before = run(current, labels, inputs.presence);
        const staysChanged = draft.global.suggest.leaveSilenceMinutes !== current.global.suggest.leaveSilenceMinutes;
        const next = staysChanged ? OpenedMeeting.of(opened.store, record, await opened.linked(), draft) : opened;
        const presence = staysChanged ? await next.presence() : inputs.presence;
        let afterLabels = labels;
        if (staysChanged) {
            const score = await preparePreviewLabels({
                opened: next,
                settings: draft.global.speakerLabels,
                presence,
                voiceLibrary,
                signal,
            });
            afterLabels = await score(draft.global.speakerLabels.voice, draft.global.suggest.applyAbove);
        } else if (
            current.global.suggest.applyAbove !== draft.global.suggest.applyAbove ||
            !Bun.deepEquals(current.global.speakerLabels.voice, draft.global.speakerLabels.voice)
        ) {
            afterLabels = await scoreLabels(draft.global.speakerLabels.voice, draft.global.suggest.applyAbove);
        }
        return {
            before,
            after: run(draft, afterLabels, presence),
            retainedIds: new Set(seed.items.map((item) => item.id)),
            transcript: inputs.meeting.transcript,
            warnings,
        };
    } finally {
        inputs.wordCheck?.dispose();
    }
}

/** Both a locked save and a preview on a detached record run these same rules. */
function applySuggestionRun(
    current: MeetingRecord,
    inputs: Parameters<typeof suggestItems>[0],
    config: MeetingsConfig,
    features?: LineVoice[]
) {
    const retired: string[] = [];
    const known = knownWord(inputs.wordCheck);
    // What the dictionary or the slang rule settles now is retired first, so its questions free the budget.
    if (inputs.rules.includes("terms")) {
        using _retire = prof.section("terms.retire");
        const settled = settledTermItems({
            record: current,
            dictionary: inputs.dictionary,
            known,
            minOccurrences: config.global.suggest.words.minOccurrences,
            unknownCandidate: config.global.suggest.terms.unknownCandidate,
        });

        for (const item of current.items) {
            const reason = settled.get(item.id);

            if (reason) {
                item.status = "rejected";
                item.decidedAt = inputs.now;
                item.evidence = { ...item.evidence, retired: reason };
            }
        }

        retired.push(...settled.keys());
        restoreThresholdRetirements({
            record: current,
            dictionary: inputs.dictionary,
            unknownCandidate: config.global.suggest.terms.unknownCandidate,
        });
    }
    const suggested = current.items.filter((item) => item.status === "suggested");
    const fresh = prof.measure("suggestItems", () =>
        suggestItems({
            ...inputs,
            record: current,
            termThresholds: config.global.suggest.terms,
            listenBelow: config.global.suggest.listenBelow,
            questionBudget: config.global.suggest.questionCap,
            minPriority: config.global.playback.listen.minPriority,
            wordQuestions: { minOccurrences: config.global.suggest.words.minOccurrences },
        })
    );
    retired.push(...suggested.filter((item) => item.status === "rejected").map((item) => item.id));
    current.items.push(...fresh);
    if (!inputs.rules.includes("evidence")) {
        return { fresh, retired };
    }
    using _quality = prof.section("evidence.quality");
    const before = current.items.length;
    const quality = new Set(
        addQualityQuestions({
            record: current,
            entries: inputs.meeting.transcript,
            callMutes: new MutedCallLines(inputs.measuredLines ?? []),
            longStretchWords: config.global.suggest.longStretchWords,
            below: Math.max(0.7, config.global.suggest.applyAbove),
            features,
            channel: current.evidence?.channels?.layout === "right-mic" ? 0 : 1,
        })
    );
    fresh.push(...current.items.slice(before).filter((item) => quality.has(item.id)));
    return { fresh, retired };
}

/** What the term rules cannot read as the meeting saw it: a context file that is gone, or changed with no commit. */
export function contextWarnings(record: MeetingRecord): string[] {
    return record.context.flatMap((entry) => {
        if (entry.kind !== "file") {
            return [];
        }

        const file = contextEntryText(entry, record);

        if (!file) {
            return [
                `The context file ${entry.ref} is gone and no git commit holds it; its quotes and identifiers are not checked`,
            ];
        }

        if (file.from === "git") {
            logger.debug(
                { ref: entry.ref, commit: file.commit },
                "meetings: context file read at its saved or historical Git revision"
            );
        }

        return file.warning ? [file.warning] : [];
    });
}
