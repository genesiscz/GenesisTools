import { type RoomDevice, rosterAccountKey } from "@genesiscz/utils/meetings/people";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { LineEvidence, SpeakingObservation } from "@genesiscz/utils/transcribe/evidence";
import {
    ARRIVAL_PHRASES,
    FAREWELL_REPLY,
    FAREWELL_REPLY_WITHIN_SEC,
    isLeavePhrase,
    isShortFarewell,
    type Presence,
    type SpeakerHint,
    sameName,
} from "@genesiscz/utils/transcribe/speakers";
import { ARRIVAL_WINDOW_SEC, FROM_START_SEC } from "./arrival";
import { channelFor, isStrongCallForNaming, speakersFor } from "./speaker-eligibility";
import type { LineLabel } from "./speaker-labels/types";

export interface IdentifiedDeparture {
    name: string;
    atSec: number;
    lineIndex?: number;
    label?: string;
    confidence?: number;
    reason: "indicator" | "attendance" | "sole-remote" | "voice" | "farewell-exchange";
}

/** Named call-channel matches from this pass, or saved proposals that still address the same source line. */
export function matchedCallVoices(
    record: MeetingRecord,
    lines: readonly LineEvidence[],
    labels?: readonly LineLabel[]
): Map<number, string> {
    if (labels) {
        return new Map(
            labels.flatMap((label) =>
                label.seat === "call" && label.labeler === "voice" && label.reason === "named" && label.person
                    ? [[label.index, label.person] as const]
                    : []
            )
        );
    }
    const byIndex = new Map(lines.map((line) => [line.index, line]));
    const names = new Map<number, string>();
    for (const item of record.items) {
        if (
            item.kind !== "speaker-range" ||
            item.status === "rejected" ||
            !item.speaker ||
            item.evidence?.labeler !== "voice" ||
            item.evidence.reason !== "named" ||
            item.evidence.seat !== "call"
        ) {
            continue;
        }
        const index = item.evidence.transcriptLine;
        const line = typeof index === "number" ? byIndex.get(index) : undefined;
        if (line && line.startSec === item.fromSec && line.label === item.label) {
            names.set(line.index, item.speaker);
        }
    }
    return names;
}

interface DepartureEvidence {
    devices?: readonly RoomDevice[];
    record?: MeetingRecord;
    hints: SpeakerHint[];
    lines: LineEvidence[];
    selfName: string;
    presence?: Presence[];
    ignoredIndicator?: Set<number>;
    labels?: readonly LineLabel[];
    matchedVoices?: ReadonlyMap<number, string>;
    roomPeople?: readonly string[];
    speaking?: readonly SpeakingObservation[];
}

const onCall = (line: LineEvidence) => isStrongCallForNaming(channelFor(line));

/** The lines of one departure pass, searchable by time, and the indicator reads it may trust, computed once. */
class DeparturePass {
    private readonly byStart: LineEvidence[];
    private usable?: SpeakingObservation[];

    constructor(private readonly options: DepartureEvidence) {
        this.byStart = [...options.lines].sort((a, b) => a.startSec - b.startSec || a.index - b.index);
    }

    /** Lines after `intent` in transcript order that start within `withinSec` of it, found without a full scan. */
    after(intent: LineEvidence, withinSec: number): LineEvidence[] {
        let low = 0;
        let high = this.byStart.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (this.byStart[mid].startSec < intent.startSec) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        const found: LineEvidence[] = [];
        for (let i = low; i < this.byStart.length && this.byStart[i].startSec <= intent.startSec + withinSec; i++) {
            if (this.byStart[i].index > intent.index) {
                found.push(this.byStart[i]);
            }
        }

        return found.sort((a, b) => a.index - b.index);
    }

    /**
     * Part of a line may be unreadable while an individual read at the join is good. Keep that read,
     * but never use an indicator assessed as stuck to identify either the joiner or a continuing speaker.
     */
    reads(): SpeakingObservation[] {
        if (!this.usable) {
            const ignored = this.options.lines.filter((other) => this.options.ignoredIndicator?.has(other.index));
            this.usable = (this.options.speaking ?? []).filter(
                (read) =>
                    !read.speakingUnknown &&
                    !ignored.some((other) => read.tSec >= other.startSec && read.tSec < other.endSec)
            );
        }

        return this.usable;
    }
}

/** The first return to the caller's label must be a short sign-off; the other side must answer the exchange. */
function closingOf({ pass, intent }: { pass: DeparturePass; intent: LineEvidence }): LineEvidence | undefined {
    const exchange = pass.after(intent, FAREWELL_REPLY_WITHIN_SEC);
    const closing = exchange.find((other) => other.label === intent.label);
    if (
        closing &&
        onCall(closing) &&
        isShortFarewell(closing.text) &&
        exchange.some((other) => other.label !== intent.label && FAREWELL_REPLY.test(other.text))
    ) {
        return closing;
    }
}

/** In an indicator gap, use a witnessed arrival and an answered sign-off, with another remote still speaking later. */
function exchangeDeparture({
    options,
    pass,
    line,
    present,
}: {
    options: DepartureEvidence;
    pass: DeparturePass;
    line: LineEvidence;
    present: Presence[];
}): IdentifiedDeparture | undefined {
    const closing = closingOf({ pass, intent: line });
    if (!closing || !options.speaking?.length) {
        return;
    }

    const reads = pass.reads();
    const history = present.map((stay) => {
        const inStay = reads.filter((read) => read.tSec >= stay.fromSec && read.tSec < stay.toSec);
        const heard = inStay.filter((read) => read.speaking.some((name) => sameName(name, stay.name)));
        return {
            stay,
            joinedSpeaking:
                stay.fromSec > FROM_START_SEC &&
                heard.some((read) => read.tSec <= Math.min(stay.fromSec + ARRIVAL_WINDOW_SEC, line.startSec)),
            continued: heard.some((read) => read.tSec > closing.startSec + 5),
            onlyMuted: !heard.length && inStay.some((read) => read.muted?.some((name) => sameName(name, stay.name))),
        };
    });
    if (!history.some((person) => person.continued)) {
        return;
    }
    const possible = history.filter((person) => !person.continued && !person.onlyMuted);
    // A matching label alone cannot name a leaver. In a multi-speaker gap require that a good earlier
    // call-channel read independently connected that label to its named person during this stay.
    const supported = possible.filter(({ stay, joinedSpeaking }) => {
        if (!joinedSpeaking || stay.leftAtExact !== false || closing.startSec > stay.toSec) {
            return false;
        }
        return options.lines.some((earlier) => {
            if (earlier.startSec < stay.fromSec || earlier.startSec >= line.startSec || !onCall(earlier)) {
                return false;
            }
            if (
                possible.length === 1 &&
                earlier.startSec <= stay.fromSec + ARRIVAL_WINDOW_SEC &&
                ARRIVAL_PHRASES.some((phrase) => phrase.test(earlier.text))
            ) {
                return true;
            }
            const shown = Object.keys(earlier.speaking);
            return (
                sameName(stay.name, line.label) &&
                earlier.label === line.label &&
                !earlier.speakingUnknown &&
                !options.ignoredIndicator?.has(earlier.index) &&
                shown.length === 1 &&
                sameName(shown[0], stay.name)
            );
        });
    });
    const name = supported.length === 1 ? supported[0].stay.name : undefined;
    const closingVoice =
        options.matchedVoices?.get(closing.index) ??
        (closing.voice?.quality === "matched" ? closing.voice.person : undefined);
    if (
        !name ||
        (closingVoice && !sameName(name, closingVoice)) ||
        [...(line.muted ?? []), ...(closing.muted ?? [])].some((other) => sameName(name, other)) ||
        (!closing.speakingUnknown &&
            !options.ignoredIndicator?.has(closing.index) &&
            Object.keys(closing.speaking).some((other) => !sameName(name, other)))
    ) {
        return;
    }
    return { name, atSec: closing.startSec, lineIndex: closing.index, reason: "farewell-exchange", confidence: 0.65 };
}

/** Resolve a goodbye independently of the diarizer label. Ambiguous identity remains unresolved. */
export function identifiedDepartures(options: DepartureEvidence): IdentifiedDeparture[] {
    const departures: IdentifiedDeparture[] = [];
    const pass = new DeparturePass(options);
    const hinted = new Map(
        options.hints.flatMap((hint) =>
            hint.kind === "leave-then-continues" ? hint.leaves.map((leave) => [leave.atSec, hint.label] as const) : []
        )
    );
    const remote = (name: string) =>
        !sameName(name, options.selfName) &&
        !options.roomPeople?.some((person) => sameName(name, person)) &&
        !options.devices?.some(({ account }) => rosterAccountKey(account) === rosterAccountKey(name));
    for (const line of options.lines) {
        const atSec = line.startSec;
        const label = hinted.get(atSec);
        if ((!label && !isLeavePhrase(line.text)) || !onCall(line)) {
            continue;
        }
        const present = options.presence?.filter(
            (stay) => !stay.self && remote(stay.name) && stay.fromSec <= atSec && stay.toSec >= atSec - 5
        );
        // An indicator assessed as stuck names nobody: not as the one shown speaking, and without attendance not as
        // the only candidate either, since then the candidates would come from that same indicator.
        const ignored = options.ignoredIndicator?.has(line.index) ?? false;
        const eligibility =
            options.record &&
            speakersFor(
                { index: line.index, fromSec: atSec, toSec: line.endSec },
                {
                    ...line,
                    devices: options.devices,
                    selfName: options.selfName,
                    seats: options.record.seats,
                    people: options.record.participants.map((p) => p.name),
                    callStays: options.presence,
                    ignoredIndicator: ignored,
                }
            );
        const allowed = (name: string) =>
            eligibility
                ? eligibility.choices.some((other) => sameName(other, name))
                : !line.muted?.some((other) => sameName(other, name));
        const candidates = [
            ...new Set(present?.map((stay) => stay.name) ?? (ignored ? [] : Object.keys(line.speaking).filter(remote))),
        ];
        const shown = ignored
            ? []
            : candidates.filter((name) => Object.keys(line.speaking).some((other) => sameName(name, other)));
        const leaving =
            present
                ?.filter((stay) => stay.leftAtExact !== false && Math.abs(stay.toSec - atSec) <= 15)
                .map((stay) => stay.name) ?? [];
        // Only the call seat can name a remote leaver, as in matchedCallVoices: a mic-seat match is someone in the room.
        const voice = options.labels?.find(
            (label) =>
                label.seat === "call" &&
                label.labeler === "voice" &&
                label.index === line.index &&
                label.reason === "named"
        );
        const matched =
            voice?.person ??
            options.matchedVoices?.get(line.index) ??
            (line.voice?.quality === "matched" ? line.voice.person : undefined);
        const voiceName =
            matched && remote(matched) && (!options.presence || candidates.some((name) => sameName(name, matched)))
                ? matched
                : undefined;
        const name =
            leaving.length === 1
                ? leaving[0]
                : shown.length === 1
                  ? shown[0]
                  : candidates.length === 1
                    ? candidates[0]
                    : voiceName;
        if (!name) {
            const exchange =
                present &&
                !shown.length &&
                !leaving.length &&
                !matched &&
                isLeavePhrase(line.text) &&
                exchangeDeparture({ options, line, present });
            if (exchange && allowed(exchange.name)) {
                departures.push(exchange);
            }
            continue;
        }
        if (sameName(name, options.selfName) || !allowed(name)) {
            continue;
        }
        departures.push({
            name,
            atSec,
            ...(sameName(name, label ?? line.label) ? { label: label ?? line.label } : {}),
            reason:
                leaving.length === 1
                    ? "attendance"
                    : shown.length === 1
                      ? "indicator"
                      : candidates.length === 1
                        ? "sole-remote"
                        : "voice",
        });
    }
    return departures;
}
