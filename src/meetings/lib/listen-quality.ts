import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { activeSeatPeople } from "@genesiscz/utils/meetings/seats";
import { type LineVoice, lineVoices, voiceFrames } from "@genesiscz/utils/meetings/voice-features";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { personKey, personPresent } from "./listen-answers";
import type { OpenedMeeting } from "./opened-meeting";

export async function qualityVoiceFeatures(opened: OpenedMeeting): Promise<LineVoice[]> {
    const entries = (await opened.meeting()).transcript;
    const lines = new TranscriptLines(entries);
    const spans = entries.flatMap((_entry, index) => {
        const span = lines.span(index);
        return span ? [{ index, fromSec: span.fromSec, toSec: span.toSec }] : [];
    });
    return lineVoices({ frames: await voiceFrames({ audioPath: await opened.audioPath() }), spans });
}

import { meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";

export function addQualityQuestions(options: {
    record: MeetingRecord;
    entries: readonly TranscriptEntry[];
    spotCheck?: number;
    longStretchWords?: number;
    below?: number;
    features?: readonly LineVoice[];
    channel?: number;
}): string[] {
    const lines = qualityLines(options.record, options.entries);
    const groups: Array<{ group: "spot-check" | "long-stretch"; parts: QualityLine[][] }> = [
        {
            group: "spot-check",
            parts: options.spotCheck ? sampleLines(lines, options.spotCheck).map((line) => [line]) : [],
        },
        {
            group: "long-stretch",
            parts: options.longStretchWords
                ? longStretches(lines, options.below ?? 0.7, options.longStretchWords).flatMap((part) =>
                      splitVoiceStretch(
                          part.map((line) => {
                              const feature = options.features?.find((one) => one.index === line.index)?.channels[
                                  options.channel ?? 0
                              ];
                              return { ...line, pitchHz: feature?.pitchHz, rms: feature?.rms };
                          })
                      )
                  )
                : [],
        },
    ];
    const ids: string[] = [];
    for (const { group, parts } of groups) {
        for (const part of parts) {
            const fromSec = part[0]!.fromSec,
                toSec = part.at(-1)!.fromSec;
            const known = options.record.items.find(
                (item) =>
                    item.kind === "question" &&
                    item.status === "suggested" &&
                    item.group === group &&
                    item.fromSec === fromSec &&
                    item.toSec === toSec
            );
            if (known) {
                ids.push(known.id);
                continue;
            }
            const decides: string[] = [];
            for (const line of part) {
                const source = options.record.items.find((item) => item.id === line.item);
                if (source?.kind === "speaker-range") {
                    const target = meetingItemSchema.parse({
                        ...source,
                        id: nextId("i", options.record.items),
                        fromSec: line.fromSec,
                        toSec: line.fromSec,
                        evidence: {
                            ...source.evidence,
                            endSec: line.toSec,
                            qualitySource: source.id,
                            transcriptLine: line.index,
                        },
                    });
                    options.record.items.push(target);
                    decides.push(target.id);
                }
            }
            const question = meetingItemSchema.parse({
                kind: "question",
                id: nextId("i", options.record.items),
                about: "speaker",
                status: "suggested",
                fromSec,
                toSec,
                question: "Who speaks in this " + group + "?",
                group,
                choices: [
                    ...new Set([
                        ...part.flatMap((line) => line.speaker ?? []),
                        ...options.record.participants.map((person) => person.name),
                    ]),
                ],
                decides,
                rules: [],
                suggestedAt: new Date().toISOString(),
                evidence: { words: part.reduce((sum, line) => sum + line.words, 0), originalSpeaker: part[0]!.speaker },
            });
            options.record.items.push(question);
            ids.push(question.id);
        }
    }
    return ids;
}

export interface QualityLine {
    index: number;
    fromSec: number;
    toSec: number;
    words: number;
    confidence: number;
    speaker?: string;
    item?: string;
    confirmed: boolean;
    asked?: boolean;
}

export function qualityLines(record: MeetingRecord, entries: readonly TranscriptEntry[]): QualityLine[] {
    const lines = new TranscriptLines(entries);
    return entries.map((entry, index) => {
        const matches = record.items.filter(
            (one) =>
                one.kind === "speaker-range" &&
                one.status !== "rejected" &&
                one.label === entry.speaker &&
                (entry.startSec ?? -1) >= one.fromSec &&
                (entry.startSec ?? Infinity) <= one.toSec
        );
        const item = matches.findLast((one) => one.status === "confirmed") ?? matches.at(-1);
        return {
            index,
            fromSec: entry.startSec ?? 0,
            toSec: lines.end(index) ?? entry.startSec ?? 0,
            words: entry.text.trim().split(/\s+/).filter(Boolean).length,
            confidence: item?.confidence ?? 0,
            speaker: item?.kind === "speaker-range" ? item.speaker : undefined,
            item: item?.id,
            confirmed: item?.status === "confirmed",
            asked: record.items.some(
                (question) =>
                    question.kind === "question" &&
                    (entry.startSec ?? -1) >= question.fromSec &&
                    (entry.startSec ?? Infinity) <= question.toSec
            ),
        };
    });
}

export function thresholdProbe(
    lines: readonly QualityLine[],
    thresholds: readonly number[]
): Array<{ threshold: number; applied: number; guesses: number; open: number; questions: number }> {
    return thresholds.map((threshold) => {
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
            throw new RangeError("Thresholds must be percentages between 0 and 100");
        }
        const applied = lines.filter(
            (line) => line.confirmed || (line.speaker && line.confidence * 100 >= threshold)
        ).length;
        const guesses = lines.filter(
            (line) => !line.confirmed && line.speaker && line.confidence >= 0.5 && line.confidence * 100 < threshold
        ).length;
        return {
            threshold,
            applied,
            guesses,
            open: lines.length - applied,
            questions: longStretches(lines, threshold / 100, 50).length,
        };
    });
}

export function longStretches(lines: readonly QualityLine[], below: number, minWords: number): QualityLine[][] {
    const stretches: QualityLine[][] = [];
    let current: QualityLine[] = [];
    for (const line of lines) {
        if (!line.confirmed && !line.asked && line.confidence >= 0.5 && line.confidence < below && line.speaker) {
            if (current.length && line.index - current.at(-1)!.index > 2) {
                stretches.push(current);
                current = [];
            }
            current.push(line);
        }
    }
    if (current.length) {
        stretches.push(current);
    }
    return stretches.filter((part) => part.reduce((sum, line) => sum + line.words, 0) >= minWords);
}

export function sampleLines(
    lines: readonly QualityLine[],
    count: number,
    random: () => number = Math.random
): QualityLine[] {
    if (!Number.isInteger(count) || count < 1) {
        throw new RangeError("Spot check count must be a positive integer");
    }
    const candidates = lines.filter((line) => !line.confirmed && line.confidence >= 0.5 && line.confidence < 0.7);
    for (let i = candidates.length - 1; i > 0; i--) {
        const at = Math.floor(random() * (i + 1));
        [candidates[i], candidates[at]] = [candidates[at]!, candidates[i]!];
    }
    return candidates.slice(0, count);
}

/** Change points only split; the feature delta never identifies a person. */
export function splitVoiceStretch<
    T extends { pitchHz?: number | null; rms?: number; speaker?: string; addressee?: string },
>(lines: readonly T[]): T[][] {
    const parts: T[][] = [];
    for (const line of lines) {
        const last = parts.at(-1)?.at(-1);
        const pitch = last?.pitchHz && line.pitchHz ? Math.abs(last.pitchHz - line.pitchHz) >= 25 : false;
        const level = last?.rms && line.rms ? Math.abs(20 * Math.log10(last.rms / line.rms)) >= 6 : false;
        const turn = last?.speaker && line.speaker && last.speaker !== line.speaker;
        const address = last?.addressee && line.addressee && last.addressee !== line.addressee;
        if (!last || pitch || level || turn || address) {
            parts.push([]);
        }
        parts.at(-1)!.push(line);
    }
    return parts;
}

export function clipProgress(options: {
    duration: number;
    position: number;
    askedFrom: number;
    askedTo: number;
    tone?: number;
    width?: number;
}): string {
    const width = Math.max(10, Math.min(70, options.width ?? 50));
    const cell = (seconds: number) =>
        Math.max(0, Math.min(width - 1, Math.floor((width * seconds) / Math.max(0.001, options.duration))));
    const from = cell(options.askedFrom),
        to = cell(options.askedTo),
        head = cell(options.position);
    return Array.from({ length: width }, (_, index) =>
        index === head
            ? "┃"
            : options.tone !== undefined && index === cell(options.tone)
              ? "♪"
              : index >= from && index <= to
                ? "━"
                : "─"
    ).join("");
}

/** A finite remote stay cannot disappear behind an unreadable light and an unchanged diarizer label. Ask; never infer identity. */
export function uncertainSharedCallRanges(options: {
    record: MeetingRecord;
    lines: readonly LineEvidence[];
}): Array<Omit<Extract<MeetingItem, { kind: "speaker-range" }>, "id" | "suggestedAt">> {
    const result: Array<Omit<Extract<MeetingItem, { kind: "speaker-range" }>, "id" | "suggestedAt">> = [];
    let priorIndex = -2;
    let priorKey = "";
    for (const line of options.lines) {
        const seats = options.record.seats && activeSeatPeople({ seats: options.record.seats, atSec: line.startSec });
        const remote =
            seats?.remote
                .filter((person) => personPresent(options.record, person.name, line.startSec))
                .map((person) => person.name) ?? [];
        const sourcePerson = options.record.participants.find(
            (person) =>
                !person.self &&
                sameName(person.name, options.record.speakers.labels[line.label] ?? line.label) &&
                personPresent(options.record, person.name, line.startSec)
        );
        const names = [
            ...remote,
            ...(sourcePerson && !seats?.room.some((name) => sameName(name, sourcePerson.name))
                ? [sourcePerson.name]
                : []),
        ];
        const candidates = names.filter(
            (name, index) => names.findIndex((other) => personKey(other) === personKey(name)) === index
        );
        const confirmed = options.record.items.some(
            (item) =>
                item.kind === "speaker-range" &&
                item.status === "confirmed" &&
                item.label === line.label &&
                line.startSec >= item.fromSec &&
                line.startSec <= item.toSec
        );
        const matched = options.record.evidence?.voice?.lines[String(line.index)]?.quality === "matched";
        if (
            !line.speakingUnknown ||
            candidates.length < 2 ||
            (line.energyMic ?? line.micShare ?? 1) > 0.35 ||
            confirmed ||
            matched
        ) {
            priorKey = "";
            continue;
        }
        const key = line.label + "|" + [...candidates].sort().join("|");
        const previous = result.at(-1);
        if (previous && key === priorKey && line.index === priorIndex + 1) {
            previous.toSec = line.startSec;
            previous.evidence = { ...previous.evidence, endSec: line.endSec };
        } else {
            result.push({
                kind: "speaker-range",
                status: "suggested",
                label: line.label,
                fromSec: line.startSec,
                toSec: line.startSec,
                candidates,
                confidence: 0.5,
                rules: [MeetingRule.Attendance],
                evidence: {
                    endSec: line.endSec,
                    listen: true,
                    sharedCallUnknown: true,
                    reason: "Several remote candidates are present while the speaking indicator is unknown; listen or enrol their isolated call voices.",
                },
            });
        }
        priorKey = key;
        priorIndex = line.index;
    }
    return result;
}
