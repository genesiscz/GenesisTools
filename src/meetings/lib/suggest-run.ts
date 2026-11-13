import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { languageSettings, type MeetingsConfig } from "@genesiscz/utils/meetings/config";
import { type AcousticShare, collectEcho, echoForRange } from "@genesiscz/utils/meetings/echo";
import { peopleDirectory } from "@genesiscz/utils/meetings/people-directory";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type LineVoice, lineVoices, type VoiceFrame, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { contextEntryText } from "./context-file";
import { indicatorFacts } from "./indicator-facts";
import { addQualityQuestions } from "./listen-quality";
import { localSpeechDuring } from "./local-speech";
import { OpenedMeeting } from "./opened-meeting";
import { errorText } from "./shared";
import { directoryMatcher, type SamePerson } from "./speaker-scores";
import { knownWord, type SuggestRule, settledTermItems, suggestItems } from "./suggest";
import { anchoredMeetingVoices } from "./voice";
import type { WordCheckChoice } from "./word-check";

const { log } = logger.scoped("meetings-suggest");

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
async function collectForSuggest(opened: OpenedMeeting, warnings: string[]): Promise<MeetingRecord> {
    const { platform, attendance, evidence, id } = opened.record;

    if (platform && attendance && evidence?.channels) {
        return opened.record;
    }

    try {
        const outcome = await opened.collect();

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
 * with a Czech letter.
 */
export async function runSuggest(options: {
    store: MeetingStore;
    record: MeetingRecord;
    rules: SuggestRule[];
    attendance?: string;
    attendanceId?: string;
    wordCheck?: WordCheckChoice;
}): Promise<{ fresh: MeetingItem[]; retired: string[]; warnings: string[] }> {
    const { store, record, rules } = options;
    const warnings: string[] = [];
    const opened = OpenedMeeting.of(store, record);
    const collected = await collectForSuggest(opened, warnings);
    const meeting = await opened.meeting();
    const config = await opened.config();
    const evidence = rules.includes("evidence") || rules.includes("speakers") ? await opened.evidence() : null;

    // Only indicator evidence that was read can show a gap: a terms-only run, or a source without it, has none to judge.
    if (evidence) {
        for (const gap of indicatorFacts({ meeting, evidence }).gaps) {
            warnings.push(`Speaking indicator gap ${gap.fromSec}s to ${gap.toSec}s: ${gap.reason}`);
        }
    }

    if (rules.includes("terms")) {
        warnings.push(...contextWarnings(collected));
    }
    let wordCheck: Awaited<ReturnType<OpenedMeeting["wordCheck"]>>["check"];

    if (rules.includes("terms")) {
        const check = await opened.wordCheck(options.wordCheck);

        if (!check.check && options.wordCheck !== "off") {
            warnings.push(
                `The word check is off (${check.reason}); the term rules skip every word with a Czech letter.`
            );
        }

        wordCheck = check.check;
    }

    const presence = await opened.suggestionPresence({ ...options, warnings });
    const energy = await opened.energy();
    const echo =
        rules.includes("evidence") &&
        evidence?.audioPath &&
        energy.calibration?.layout &&
        energy.calibration.layout !== "unknown"
            ? await collectEcho({
                  audioPath: evidence.audioPath,
                  cachePath: join(store.folder(record.id), "evidence", "echo.json"),
                  layout: energy.calibration.layout,
              })
            : undefined;
    const share: AcousticShare | undefined = echo
        ? Object.assign(
              (fromSec: number, toSec: number) =>
                  echoForRange(echo, fromSec, toSec)?.cleanMicShare ?? energy.share?.(fromSec, toSec),
              {
                  acoustic: (fromSec: number, toSec: number) => echoForRange(echo, fromSec, toSec),
                  raw: energy.share?.raw ?? energy.share,
                  // The echo wrapper keeps the cached voice matches, or no line of a calibrated meeting has a voice.
                  voice: energy.share?.voice,
              }
          )
        : energy.share;
    // One decode and one pitch pass serve both the room voice clustering and the quality questions.
    let frames: VoiceFrame[] | undefined;

    if (rules.includes("evidence")) {
        try {
            frames = await voiceFrames({ audioPath: await opened.audioPath() });
        } catch (error) {
            log.warn({ error, meeting: record.id }, "voice change points unavailable");
            warnings.push("Voice change points unavailable; long stretches remain open for listening");
        }
    }

    const roomSize = collected.seats?.room.length ?? 0;
    let voice: LineVoice[] | undefined;

    if (frames && roomSize > 1) {
        // Clustering is optional evidence: without it the shared-device lines keep their candidates.
        try {
            const spans = lineEvidence(meeting.transcript, { segments: [], speaking: [] }).map((line) => ({
                index: line.index,
                fromSec: line.startSec,
                toSec: line.endSec,
            }));
            const micChannel = energy.calibration?.layout === "right-mic" ? 1 : 0;
            voice = anchoredMeetingVoices({
                record: collected,
                transcript: meeting.transcript,
                features: lineVoices({ frames, spans }),
                voices: roomSize,
                channel: micChannel,
                micChannel,
            });
        } catch (error) {
            log.warn({ error, meeting: record.id, roomSize }, "room voice clustering unavailable");
            warnings.push(
                `Room voice clustering unavailable (${errorText(error)}); shared-device lines keep their candidates`
            );
        }
    }

    const inputs: Parameters<typeof suggestItems>[0] = {
        localSpeech: rules.includes("evidence") ? localSpeechDuring({ start: meeting.start, end: meeting.end }) : [],
        record: collected,
        meeting,
        rules,
        dictionary: await opened.dictionary(),
        sourceWords: await opened.sourceWords(),
        presence,
        evidence,
        energyMicShare: share,
        voice,
        listenBelow: config.global.suggest.listenBelow,
        questionBudget: config.global.suggest.questionCap,
        minPriority: config.global.playback.listen.minPriority,
        points: await opened.summaryPoints(),
        wordCheck,
        sourceLabels: languageSettings(config).render,
        restatedIdentifiers: config.global.suggest.restatedIdentifiers,
        ...(rules.includes("speakers") || rules.includes("evidence")
            ? { samePerson: await directorySamePerson({ store, config, meeting: record.id }) }
            : {}),
        now: new Date().toISOString(),
    };
    const features = frames ? lineVoices({ frames, spans: entrySpans(meeting.transcript) }) : undefined;
    let fresh: MeetingItem[] = [];
    let retired: string[] = [];
    const known = knownWord(wordCheck);

    try {
        await store.update(record.id, { command: "suggest", change: "suggest findings and questions" }, (current) => {
            // What the dictionary or the slang rule settles now is retired first, so its questions free the budget.
            const settled = rules.includes("terms")
                ? settledTermItems({ record: current, dictionary: inputs.dictionary, known })
                : new Map<string, string>();

            for (const item of current.items) {
                const reason = settled.get(item.id);

                if (reason) {
                    item.status = "rejected";
                    item.decidedAt = inputs.now;
                    item.evidence = { ...item.evidence, retired: reason };
                }
            }

            retired = [...settled.keys()];
            fresh = suggestItems({ ...inputs, record: current });
            current.items.push(...fresh);
            // The long-stretch questions are evidence questions, and they share the meeting's one question budget.
            const open = current.items.filter((item) => item.kind === "question" && item.status === "suggested");
            const room = Math.max(0, config.global.suggest.questionCap - open.length);

            if (rules.includes("evidence") && room > 0) {
                const draft = structuredClone(current);
                const before = new Set(current.items.map((item) => item.id));
                const quality = addQualityQuestions({
                    record: draft,
                    entries: meeting.transcript,
                    longStretchWords: config.global.suggest.longStretchWords,
                    below: Math.max(0.7, config.global.suggest.applyAbove),
                    features,
                    channel: current.evidence?.channels?.layout === "right-mic" ? 0 : 1,
                });
                const accepted = draft.items
                    .filter((item) => item.kind === "question" && !before.has(item.id))
                    .slice(0, room);
                const keep = new Set(
                    accepted.flatMap((item) => (item.kind === "question" ? [item.id, ...item.decides] : []))
                );
                current.items = draft.items.filter((item) => before.has(item.id) || keep.has(item.id));
                fresh.push(...current.items.filter((item) => quality.includes(item.id) && keep.has(item.id)));
            }
        });
    } finally {
        wordCheck?.dispose();
    }

    return { fresh, retired, warnings };
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
