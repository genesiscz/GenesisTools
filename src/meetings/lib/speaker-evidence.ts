import { logger } from "@genesiscz/utils/logger";
import { median, silentCallSpans } from "@genesiscz/utils/meetings/energy";
import { type RoomDevice, roomDeviceAccountKeys, rosterAccountKey } from "@genesiscz/utils/meetings/people";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";

import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { wholeMeetingRoomPeople } from "@genesiscz/utils/meetings/seats";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { VoiceMatch } from "@genesiscz/utils/meetings/voice";
import { type LineEvidence, presentAt, SELF } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import { callMutes } from "./call-mutes";
import type { NewItem } from "./new-item";
import { type Eligibility, isStrongCallForNaming, type SpeakerFacts, speakersFor } from "./speaker-eligibility";
import { assessIndicator } from "./speaker-indicator";
import { ATTENDANCE_CONFIDENCE, ENERGY_CALL_LEANS, ENERGY_MIC_LEANS, seatConfidence } from "./speaker-labels/seat";
import { addPolish, lineTallies, type SamePerson, type SpeakerScore, scoreCandidates } from "./speaker-scores";

const { log } = logger.scoped("meetings-suggest");

type SourceRange = { label: string; fromSec: number; toSec: number; evidence?: Record<string, unknown> };

/** One evaluation of the full source spans against one snapshot of presence. */
export class LineSpeakers {
    private readonly rows = new Map<number, LineEvidence>();
    private readonly byLabel = new Map<string, LineEvidence[]>();
    private readonly facts: Pick<SpeakerFacts, "seats" | "people" | "selfName" | "callStays" | "devices">;
    private readonly deviceAccounts: Set<string>;
    readonly eligibility = new Map<number, Eligibility>();
    readonly assessment: ReturnType<typeof assessIndicator>;

    constructor(options: {
        devices?: readonly RoomDevice[];
        lines: LineEvidence[];
        record: MeetingRecord;
        meeting: SourceMeeting;
        presence?: Presence[];
        selfName?: string;
        people?: string[];
    }) {
        const { lines, record, meeting, presence, selfName } = options;
        this.deviceAccounts = roomDeviceAccountKeys(options.devices);
        this.assessment = assessIndicator({
            lines,
            selfName: selfName ?? "",
            roomPeople: wholeMeetingRoomPeople(record.seats),
        });
        const selfStays = presence?.map((stay) => (stay.self && selfName ? { ...stay, name: selfName } : stay));
        const transcriptLabels = new Set(lines.map((line) => line.label));
        const people = [
            ...new Set([
                ...record.participants.map((p) => p.name),
                ...meeting.participants.map((p) => p.name),
                // Attendance may list only the joiner. R20 also knows the platform labels actually used in the call.
                ...meeting.speakers
                    .filter((p) => p.origin === "platform" && (!presence?.length || transcriptLabels.has(p.name)))
                    .map((p) => p.name),
                ...Object.values(record.speakers.labels),
                ...(options.people ?? []),
                ...record.items.flatMap((item) =>
                    item.kind === "speaker-range"
                        ? [...(item.candidates ?? []), ...(item.speaker ? [item.speaker] : [])]
                        : []
                ),
                ...lines.flatMap((line) => [
                    ...(line.present ?? []),
                    ...Object.keys(line.speaking),
                    ...(line.muted ?? []),
                    ...(line.liveName ? [line.liveName] : []),
                    ...(line.voice?.person ? [line.voice.person] : []),
                ]),
            ]),
        ];
        this.facts = { seats: record.seats, people, selfName, callStays: selfStays, devices: options.devices };
        for (const line of lines) {
            this.rows.set(line.index, line);
            const group = this.byLabel.get(line.label) ?? [];
            group.push(line);
            this.byLabel.set(line.label, group);
            this.eligibility.set(line.index, this.resolve(line));
        }
    }

    private resolve(line: LineEvidence): Eligibility {
        return speakersFor(
            { index: line.index, fromSec: line.startSec, toSec: line.endSec },
            { ...line, ...this.facts, ignoredIndicator: this.assessment.ignored.has(line.index) }
        );
    }

    isRoomDevice(name: string): boolean {
        return this.deviceAccounts.has(rosterAccountKey(name));
    }

    allowsMatchedVoice(line: LineEvidence, person: string): boolean {
        if (this.isRoomDevice(person)) {
            return false;
        }
        const eligible = this.eligibility.get(line.index)!;
        // A positive embedding comes from an audio track. On a disagreement, check its calibrated side's
        // occupants, attendance and transmitting-account mute across the full span.
        const track =
            eligible.channel.side === "mixed" && line.energyMic !== undefined
                ? this.resolve({ ...line, micShare: undefined })
                : eligible;
        return track.channel.strong && track.choices.some((name) => sameName(name, person));
    }

    linesFor(range: SourceRange): LineEvidence[] {
        const index = range.evidence?.transcriptLine;
        if (typeof index === "number") {
            const row = this.rows.get(index);
            return row ? [row] : [];
        }
        return (this.byLabel.get(range.label) ?? []).filter(
            (row) => row.startSec >= range.fromSec && row.startSec <= range.toSec
        );
    }

    key(index: number): string {
        const row = this.eligibility.get(index);
        const line = this.rows.get(index);
        return row
            ? [
                  row.channel.side,
                  row.channel.strong,
                  row.reviewOnly,
                  line?.speakingUnknown,
                  this.assessment.ignored.has(index),
                  ...row.choices,
              ].join("|")
            : "";
    }

    unknownCall(index: number): boolean {
        return (
            this.eligibility.get(index)?.channel.side === "call" &&
            (this.rows.get(index)?.speakingUnknown === true || this.assessment.ignored.has(index))
        );
    }

    choices(indices: readonly number[]): string[] | undefined {
        const [first, ...others] = indices.flatMap((i) => this.eligibility.get(i) ?? []);
        return first?.choices.filter((name) =>
            others.every((row) => row.choices.some((other) => sameName(name, other)))
        );
    }
}

/** A range's `evidence.candidateScores`, or nothing when no candidate has evidence. */
export function scoresEvidence(scores: SpeakerScore[]): { candidateScores?: SpeakerScore[] } {
    return scores.length > 0 ? { candidateScores: scores } : {};
}

/** An outstanding automatic seat answer can predate calibration. Leave decisions and unrelated ranges alone. */
export function retireContradictedSeats(options: {
    record: MeetingRecord;
    lines: LineEvidence[];
    applyAbove?: number;
}) {
    const byIndex = new Map(options.lines.map((line) => [line.index, line]));
    for (const item of options.record.items) {
        const evidence = item.evidence;
        if (
            item.kind !== "speaker-range" ||
            item.status !== "suggested" ||
            evidence?.labeler !== "seat" ||
            evidence.reason !== "seat-of-one" ||
            (evidence.seat !== "mic" && evidence.seat !== "call") ||
            typeof evidence.transcriptLine !== "number"
        ) {
            continue;
        }
        const line = byIndex.get(evidence.transcriptLine);
        if (!line || line.label !== item.label || line.startSec !== item.fromSec) {
            continue;
        }
        if (
            seatConfidence({
                seat: evidence.seat,
                energyMic: line.energyMic ?? line.energyMicRaw,
                applyAbove: options.applyAbove,
            }) === undefined
        ) {
            item.status = "rejected";
            item.evidence = { ...evidence, retired: "calibrated-seat" };
        }
    }
}

/** A line counts as one channel when that channel holds at least this share of it (rule E1). */
const CHANNEL_SHARE = 0.9;
/** Lines of one label closer than this, with the same finding, form one item. */
const EVIDENCE_GAP_SEC = 120;

export interface EvidenceFinding {
    speaker?: string;
    candidates?: string[];
    rules: string[];
    confidence: number;
    /** Both channels are in the line: a person should listen before confirming. */
    listen?: boolean;
    /** The microphone heard the call's own words (rule R2.1 echo). */
    echo?: boolean;
    /** The tagged channel and the calibrated energy disagree: no other rule may name a winner over it. */
    conflict?: boolean;
    elimination?: boolean;
}

/** The microphone alone never proves the user spoke (Martin, 2026-11-02): loud speakers can reach it. */
const MIC_ALONE_MAX = 0.95;
const MIC_WITH_ENERGY_MAX = 0.98;
const ECHO_SIMILARITY = 0.6;
const ECHO_PENALTY = 0.3;
/** The call's share of the energy at or above this while the microphone won: someone on the call was loud too. */
const CALL_LOUD_SHARE = 0.4;
const CALL_LOUD_PENALTY = 0.15;
const ENERGY_AGREES_SHARE = 0.75;
const ENERGY_AGREES_BONUS = 0.05;
/**
 * R4.3: the live segments are coarse (a short reply into the microphone inside a long call segment counts as the
 * call's), so an energy share this sure of one channel beats them. It exists only with a calibrated layout.
 */
export const ENERGY_MIC_SURE = 0.9;
const ENERGY_CALL_SURE = 0.1;
const ENERGY_SURE_CONFIDENCE = 0.85;
/** The energy says the microphone while the segments said the call: both voices may be in the line. */
const ENERGY_OVER_SEGMENTS_CONFIDENCE = 0.75;
/**
 * Where the segments are mixed (neither channel holds `CHANNEL_SHARE`), the energy's majority decides: this much on
 * the microphone is the user, unsure enough to ask; under `ENERGY_CALL_LEANS` it is not the user.
 */
const ENERGY_LEANS_CONFIDENCE = 0.55;
/** A mixed line under a platform label whose person E3 alone shows speaking stays the label's below this energy. */
const ENERGY_LABEL_HOLDS = 0.8;
/** R17: a platform-named label with a line this close to another label's line is talking in the same dialogue. */
const OWN_LABEL_SEC = 10;
const OWN_LABEL_CONFIDENCE = 0.65;

/**
 * How sure a microphone-won line is the user: the microphone's share, at most 0.95; less when the microphone heard
 * the call's own words (echo) or the call was loud at the same time; a little more when the energy agrees.
 */
function micConfidence(line: LineEvidence): {
    confidence: number;
    echo: boolean;
    callLoud: boolean;
    energyChecked: boolean;
} {
    const echo = (line.echo ?? 0) >= ECHO_SIMILARITY;
    const callLoud = line.energyMic !== undefined && 1 - line.energyMic >= CALL_LOUD_SHARE;
    const agrees = line.energyMic !== undefined && line.energyMic >= ENERGY_AGREES_SHARE;
    let confidence = Math.min(MIC_ALONE_MAX, line.micShare ?? 0);

    confidence -= echo ? ECHO_PENALTY : 0;
    confidence -= callLoud ? CALL_LOUD_PENALTY : 0;
    confidence += agrees ? ENERGY_AGREES_BONUS : 0;

    return {
        confidence: Math.max(0, Math.min(MIC_WITH_ENERGY_MAX, confidence)),
        echo,
        callLoud,
        energyChecked: line.energyMic !== undefined,
    };
}

/** The names the platform showed speaking during a line, most often first. */
function speakingNames(line: LineEvidence): string[] {
    if (line.speakingUnknown) {
        return [];
    }
    return Object.entries(line.speaking)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
}

/** The people in the call with those the speaking indicator shows first; only those shown when nobody is known present. */
function shownFirst(present: string[] | undefined, shown: string[]): string[] {
    if (!present) {
        return shown;
    }

    const first = present.filter((name) => shown.some((other) => sameName(other, name)));
    return [...first, ...present.filter((name) => !first.includes(name))];
}

/**
 * Rule E1 with E3 and E4: what the audio channel says about one line.
 * - The user's microphone under another label: the line is the user.
 * - The call's sound under the user's label: someone else; the platform's speaking indicator (E3) and live name (E4)
 *   name them when they agree, else the people in the call are the candidates.
 * - The call's sound under another label whose live name and speaking indicator agree on a different person.
 */
function findingFor(options: {
    line: LineEvidence;
    selfName: string;
    isSelfLabel: boolean;
    eligible: Eligibility;
    /** The platform-named labels other than this line's that have a line within `OWN_LABEL_SEC` of it (R17). */
    ownLabelNearby: string[];
    /** The platform named the line's label after a person. */
    platformLabel: boolean;
}): EvidenceFinding | undefined {
    const { line, selfName, isSelfLabel, ownLabelNearby } = options;
    const voicePerson = line.voice?.quality === "matched" ? line.voice.person : undefined;
    if (voicePerson && options.eligible.choices.some((name) => sameName(name, voicePerson))) {
        return {
            speaker: voicePerson,
            confidence: 0.9,
            rules: [MeetingRule.Voice],
            echo: (line.echoOfCall ?? 0) >= 0.65,
        };
    }

    // No live segment covers the line, or two tie: only a sure energy share names its channel.
    if (line.micShare === undefined || !line.winner) {
        const micSure = line.energyMic !== undefined && line.energyMic >= ENERGY_MIC_SURE;

        return micSure && !isSelfLabel
            ? { speaker: selfName, rules: [MeetingRule.Energy], confidence: ENERGY_OVER_SEGMENTS_CONFIDENCE }
            : undefined;
    }

    // RM: a person muted through the whole line did not speak it.
    const muted = (name: string) =>
        callMutes(line).some((person) => sameName(person, name)) &&
        !options.eligible.choices.some((person) => sameName(person, name));
    const selfMuted = muted(selfName);

    // R4.3: a sure energy share is the user's line whatever the segments, E3 or E4 say, and never the user's below.
    // Where the segments are mixed, the energy's majority decides the same way.
    const energy = line.energyMic;
    const mixed = line.micShare > 1 - CHANNEL_SHARE && line.micShare < CHANNEL_SHARE;
    const micSure = energy !== undefined && energy >= ENERGY_MIC_SURE;
    const micLeans = mixed && energy !== undefined && energy >= ENERGY_MIC_LEANS;
    const callMajority = energy !== undefined && energy < ENERGY_CALL_LEANS;

    // The platform's label and its speaking indicator agree on the label's person: a microphone lean does not win.
    const shown = speakingNames(line).filter((name) => !sameName(name, selfName) && !muted(name));
    const labelShownAlone =
        options.platformLabel && !isSelfLabel && shown.length === 1 && sameName(shown[0]!, line.label);

    if (labelShownAlone && mixed && energy !== undefined && energy < ENERGY_LABEL_HOLDS) {
        return undefined;
    }

    if ((micSure || micLeans) && line.winner !== SELF) {
        return isSelfLabel
            ? undefined
            : {
                  speaker: selfName,
                  rules: [MeetingRule.Energy],
                  confidence: micSure ? ENERGY_OVER_SEGMENTS_CONFIDENCE : ENERGY_LEANS_CONFIDENCE,
                  ...(mixed ? { listen: true } : {}),
              };
    }

    // Wispr records the microphone itself, so a user muted in the call can still be heard on it: RM never overrules a
    // line the microphone won, only one the call's sound won.
    if (line.winner === SELF && !callMajority) {
        if (isSelfLabel) {
            return undefined;
        }

        const mic = micConfidence(line);
        return {
            speaker: selfName,
            rules: mic.energyChecked ? [MeetingRule.Channel, MeetingRule.Energy] : [MeetingRule.Channel],
            confidence: micSure ? Math.max(ENERGY_SURE_CONFIDENCE, mic.confidence) : mic.confidence,
            ...(mic.echo ? { echo: true } : {}),
            ...(line.micShare < CHANNEL_SHARE || mic.echo || mic.callLoud ? { listen: true } : {}),
        };
    }

    // The call's sound won the line, or the energy says it did. Some microphone in it means two voices: listen.
    const channel = line.winner === SELF ? MeetingRule.Energy : MeetingRule.Channel;
    const listen = line.micShare > 1 - CHANNEL_SHARE ? { listen: true } : {};
    const present = line.present?.filter((name) => !sameName(name, selfName) && !muted(name));
    const live =
        line.liveName && !muted(line.liveName) && (!present || present.some((name) => sameName(name, line.liveName!)))
            ? line.liveName
            : undefined;
    const agreed = live && shown[0] && sameName(shown[0], live) ? live : undefined;
    const labelMuted = !isSelfLabel && muted(line.label);
    // RM with E3: once the muted are out, the one person the indicator shows among those present said it.
    const onlyShown = present && shown.length > 0 ? shown.filter((name) => present.some((p) => sameName(p, name))) : [];
    const rmShown = (isSelfLabel ? selfMuted : labelMuted) && onlyShown.length === 1 ? onlyShown[0] : undefined;

    if (rmShown && !sameName(rmShown, line.label)) {
        return {
            speaker: rmShown,
            rules: [channel, MeetingRule.Muted, MeetingRule.SpeakingIndicator],
            confidence: 0.9,
            ...listen,
        };
    }

    // R17: of the people E3 shows, one who talks under their own label right now is the other side of the dialogue.
    const elsewhere = shown.filter((name) => ownLabelNearby.some((label) => sameName(label, name)));
    const others = shown.filter((name) => !elsewhere.includes(name));
    const other = others.length === 1 && elsewhere.length > 0 ? others[0] : undefined;

    if (other && (!present || present.some((name) => sameName(name, other)))) {
        return sameName(other, line.label)
            ? undefined
            : {
                  speaker: other,
                  rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.OwnLabel],
                  confidence: OWN_LABEL_CONFIDENCE,
                  ...listen,
              };
    }

    if (isSelfLabel) {
        const rm = selfMuted ? [MeetingRule.Muted] : [];
        return agreed
            ? {
                  speaker: agreed,
                  rules: [channel, ...rm, MeetingRule.SpeakingIndicator, MeetingRule.LiveName],
                  confidence: selfMuted ? 0.85 : 0.8,
                  ...listen,
              }
            : { candidates: shownFirst(present, shown), rules: [channel, ...rm], confidence: 0.6, ...listen };
    }

    if (labelMuted && !agreed) {
        const candidates = (present ?? shown).filter((name) => !sameName(name, line.label));
        return { candidates, rules: [channel, MeetingRule.Muted], confidence: 0.5, ...listen };
    }

    // A label the platform named after a person is its own voice id: E3 and E4 agreeing on another never move it.
    if (agreed && !sameName(agreed, line.label) && !options.platformLabel) {
        return {
            speaker: agreed,
            rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.LiveName],
            confidence: 0.7,
            ...listen,
        };
    }

    // RA: the label's own person was not in the call, so the platform's live name is the best guess left.
    const labelAbsent = present !== undefined && !present.some((name) => sameName(name, line.label));

    // E4 is the weakest: when the speaking indicator shows people and not the live name, E4 loses.
    const indicatorAgrees = shown.length === 0 || shown.some((name) => sameName(name, live ?? ""));

    if (labelAbsent && live && indicatorAgrees) {
        return {
            speaker: live,
            rules: [channel, MeetingRule.LiveName, MeetingRule.Attendance],
            confidence: 0.6,
            ...listen,
        };
    }

    // The live name belongs to someone who had left: a live voice id keeps its last name after the person goes.
    // The speaking indicator among the people still in the call is the guess, sampled only every few seconds.
    const stillHere = shown.filter((name) => present?.some((person) => sameName(person, name)));

    if (labelAbsent && line.liveName && stillHere[0]) {
        return {
            speaker: stillHere[0],
            rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.Attendance],
            confidence: 0.45,
            listen: true,
        };
    }

    if (labelAbsent && present) {
        return { candidates: present, rules: [channel, MeetingRule.Attendance], confidence: 0.4, listen: true };
    }
    return undefined;
}

/** A silent call stretch counts when two labels each hold this share of its lines, or E3 shows others this often. */
const SILENT_CALL_LABEL_SHARE = 0.15;
const SILENT_CALL_SHOWN_SHARE = 0.2;
/** A platform-named label with this share of the microphone's sure lines (and some call lines) is another person. */
const LOCAL_VOICE_SHARE = 0.25;
const LOCAL_VOICE_MIN_LINES = 30;
const LOCAL_VOICE_CALL_SHARE = 0.1;
const LOCAL_VOICE_CONFIDENCE = 0.4;
/** With a second voice on the microphone, its larger voice is the user's, but not sure enough to skip a listen. */
const OWNER_WITH_LOCAL_VOICE_MAX = 0.7;
/** The label with the most microphone lines leads the next one by this factor before it may stand for the user. */
const LABEL_VOICE_MARGIN = 1.25;
const LABEL_VOICE_CONFIDENCE = 0.5;
interface Span {
    fromSec: number;
    toSec: number;
}

/** R20: windows, the medians that read normal or swapped, and how much of a stretch must read swapped. */
const SWAP_WINDOW_SEC = 300;
const SWAP_LOW = 0.3;
const SWAP_HIGH = 0.7;
const SWAP_WINDOW_LINES = 3;
const SWAP_MIN_WINDOWS = 2;
const SWAP_MIN_LINES = 10;
/** The stretch itself, from its first swapped line's start to its last one's end: two windows can hold a few seconds. */
const SWAP_MIN_SEC = 600;
/**
 * The swap starts and ends somewhere between two lines, and the last line of a call has only an estimated end (5 s),
 * so the measured stretch may fall this short of 10 min (a swap from 10:00 to the end of a 20 min call measures 595 s).
 */
const SWAP_EDGE_SEC = 30;
const SWAP_MAX_CONFIDENCE = 0.9;

/** A stretch where the recorder put the user's voice under another label and that person's under the user's (R20). */
export interface SwapStretch extends Span {
    selfLabel: string;
    otherLabel: string;
    selfMedian: number;
    otherMedian: number;
    selfLines: number;
    otherLines: number;
    skipped?: number[];
}

type SwapWindowState = "normal" | "swapped" | "unclear";

interface SwapWindow {
    state: SwapWindowState;
    self: LineEvidence[];
    other: LineEvidence[];
}

/** One window of R20: the medians of the user's label and the other label, when both talk enough to have one. */
function swapWindowState(self: LineEvidence[], other: LineEvidence[]): SwapWindowState {
    if (self.length < SWAP_WINDOW_LINES || other.length < SWAP_WINDOW_LINES) {
        return "unclear";
    }

    const selfMedian = median(self.map((line) => line.energyMic!))!;
    const otherMedian = median(other.map((line) => line.energyMic!))!;

    if (selfMedian >= SWAP_HIGH && otherMedian <= SWAP_LOW) {
        return "normal";
    }

    return selfMedian <= SWAP_LOW && otherMedian >= SWAP_HIGH ? "swapped" : "unclear";
}

/**
 * R20 over the calibrated energy: the stretches where the user's label and one platform-named label read the other
 * way round than elsewhere in the call. A run of swapped windows may hold one unclear window; a stretch starts and
 * ends at the first and last line that already reads swapped.
 */
function swappedStretches(lines: LineEvidence[], selfName: string, platformLabels: Set<string>): SwapStretch[] {
    const measured = lines.filter((line) => line.energyMic !== undefined);
    const selfLabel = measured.find((line) => sameName(line.label, selfName))?.label;

    if (!selfLabel || measured.length === 0) {
        return [];
    }

    const byWindow = new Map<number, Map<string, LineEvidence[]>>();
    const labels = new Set<string>();
    let lastWindow = 0;
    for (const line of measured) {
        const window = Math.floor(line.startSec / SWAP_WINDOW_SEC);
        const bucket = byWindow.get(window) ?? new Map<string, LineEvidence[]>();
        const group = bucket.get(line.label) ?? [];
        group.push(line);
        bucket.set(line.label, group);
        byWindow.set(window, bucket);
        labels.add(line.label);
        lastWindow = Math.max(lastWindow, window);
    }
    const others = [...labels].filter((label) => label !== selfLabel && platformLabels.has(label));
    const stretches: SwapStretch[] = [];

    for (const otherLabel of others) {
        const windows: SwapWindow[] = [];

        for (let index = 0; index <= lastWindow; index++) {
            const bucket = byWindow.get(index);
            const self = bucket?.get(selfLabel) ?? [];
            const other = bucket?.get(otherLabel) ?? [];
            windows.push({ state: swapWindowState(self, other), self, other });
        }

        if (!windows.some((window) => window.state === "normal")) {
            continue;
        }

        let start = 0;

        while (start < windows.length) {
            if (windows[start]!.state !== "swapped") {
                start += 1;
                continue;
            }

            let last = start;
            let swapped = 1;

            while (last + 1 < windows.length) {
                if (windows[last + 1]!.state === "swapped") {
                    last += 1;
                    swapped += 1;
                } else if (windows[last + 1]!.state === "unclear" && windows[last + 2]?.state === "swapped") {
                    last += 2;
                    swapped += 1;
                } else {
                    break;
                }
            }

            const run = windows.slice(start, last + 1);
            const self = run.flatMap((window) => window.self);
            const other = run.flatMap((window) => window.other);
            start = last + 1;

            if (swapped < SWAP_MIN_WINDOWS || self.length < SWAP_MIN_LINES || other.length < SWAP_MIN_LINES) {
                continue;
            }

            const reads = [
                ...self.filter((line) => line.energyMic! <= SWAP_LOW),
                ...other.filter((line) => line.energyMic! >= SWAP_HIGH),
            ];
            const fromSec = Math.min(...reads.map((line) => line.startSec));
            const lastEndSec = Math.max(...reads.map((line) => line.endSec));

            // Lines bunched at a window seam fill two windows in seconds: the measured stretch must last 10 min.
            if (lastEndSec - fromSec < SWAP_MIN_SEC - SWAP_EDGE_SEC) {
                continue;
            }

            stretches.push({
                fromSec,
                toSec: Math.max(...reads.map((line) => line.startSec)),
                selfLabel,
                otherLabel,
                selfMedian: median(self.map((line) => line.energyMic!))!,
                otherMedian: median(other.map((line) => line.energyMic!))!,
                selfLines: self.length,
                otherLines: other.length,
            });
        }
    }

    return stretches;
}

/** The other label's lines are the user's, and the user's label's are the other's. */
function swapItems(
    swap: SwapStretch,
    selfName: string,
    lines: LineEvidence[]
): Array<{
    line: LineEvidence;
    item: Extract<NewItem, { kind: "speaker-range" }>;
}> {
    const confidence =
        Math.round(Math.min(SWAP_MAX_CONFIDENCE, 0.5 + (swap.otherMedian - swap.selfMedian) / 2) * 100) / 100;
    const inside = lines.filter(
        (line) =>
            (line.label === swap.selfLabel || line.label === swap.otherLabel) &&
            line.startSec >= swap.fromSec &&
            line.startSec <= swap.toSec
    );
    const agrees = (line: LineEvidence) => {
        const shares = [line.micShare, line.energyMic].filter((share) => share !== undefined);
        return shares.length > 0 && shares.every((mic) => (line.label === swap.otherLabel ? mic >= 0.75 : mic <= 0.25));
    };
    swap.skipped = inside.filter((line) => !agrees(line)).map((line) => line.startSec);
    return inside.filter(agrees).map((line) => ({
        line,
        item: {
            kind: "speaker-range",
            status: "suggested",
            label: line.label,
            fromSec: line.startSec,
            toSec: line.startSec,
            speaker: line.label === swap.otherLabel ? selfName : swap.otherLabel,
            confidence,
            rules: [MeetingRule.LabelSwap, MeetingRule.Energy],
            evidence: {
                channel: line.label === swap.otherLabel ? "mic" : "system",
                lines: 1,
                endSec: line.endSec,
                transcriptLine: line.index,
                swap: { fromSec: swap.fromSec, toSec: swap.toSec, skipped: swap.skipped },
                note: "label swap agrees with this line's own channel",
            },
        },
    }));
}

interface MicrophoneVoices {
    owner?: string;
    ownerLeads: boolean;
    others: Set<string>;
}

export function micSure(line: LineEvidence): boolean {
    return line.energyMic !== undefined
        ? line.energyMic >= ENERGY_MIC_SURE
        : line.winner === SELF && (line.micShare ?? 0) >= CHANNEL_SHARE;
}

function callSure(line: LineEvidence): boolean {
    return line.energyMic !== undefined
        ? line.energyMic <= ENERGY_CALL_SURE
        : line.winner !== undefined && line.winner !== SELF && (line.micShare ?? 1) <= 1 - CHANNEL_SHARE;
}

function within(spans: Span[], sec: number): boolean {
    return spans.some((span) => sec >= span.fromSec && sec < span.toSec);
}

/**
 * The stretches where E1 says nothing: the call's channel stayed silent for 5 min or more while two labels talked,
 * or while E3 showed other people speaking. The microphone then carried the call's voices as well (the call played
 * through the room's speakers), so a microphone line there may be anyone.
 */
function unusableChannelSpans(
    lines: LineEvidence[],
    share: ((fromSec: number, toSec: number) => number | undefined) | undefined,
    selfName: string
): Span[] {
    if (!share || lines.length === 0) {
        return [];
    }

    const end = Math.max(...lines.map((line) => line.endSec));

    return silentCallSpans(share, 0, end).filter((span) => {
        const inside = lines.filter((line) => within([span], line.startSec));
        const perLabel = new Map<string, number>();

        for (const line of inside) {
            perLabel.set(line.label, (perLabel.get(line.label) ?? 0) + 1);
        }

        const talking = [...perLabel.values()].filter((count) => count >= SILENT_CALL_LABEL_SHARE * inside.length);
        const shownOthers = inside.filter((line) =>
            Object.keys(line.speaking).some((name) => !sameName(name, selfName))
        ).length;

        return inside.length > 0 && (talking.length >= 2 || shownOthers >= SILENT_CALL_SHOWN_SHARE * inside.length);
    });
}

/**
 * Who the microphone's labels are where the channels work. `owner`: the label with the most sure microphone lines
 * (the user's voice), and whether it leads clearly enough to stand for the user where the channels fail. `others`:
 * the platform-named labels that also hold a large share of the sure microphone lines next to call lines of their
 * own, so a second person in the room talks into the microphone under them (R18).
 */
function microphoneVoices(lines: LineEvidence[], selfName: string, platformLabels: Set<string>): MicrophoneVoices {
    const mic = new Map<string, number>();
    const call = new Map<string, number>();
    const all = new Map<string, number>();

    for (const line of lines) {
        all.set(line.label, (all.get(line.label) ?? 0) + 1);
        mic.set(line.label, (mic.get(line.label) ?? 0) + (micSure(line) ? 1 : 0));
        call.set(line.label, (call.get(line.label) ?? 0) + (callSure(line) ? 1 : 0));
    }

    const ranked = [...mic.entries()].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const top = ranked[0];
    const ownerLeads = top !== undefined && (ranked[1]?.[1] ?? 0) * LABEL_VOICE_MARGIN <= top[1];
    const others = new Set(
        ranked
            .filter(
                ([label, count]) =>
                    label !== top?.[0] &&
                    !sameName(label, selfName) &&
                    platformLabels.has(label) &&
                    count >= Math.max(LOCAL_VOICE_MIN_LINES, LOCAL_VOICE_SHARE * total) &&
                    (call.get(label) ?? 0) >= LOCAL_VOICE_CALL_SHARE * (all.get(label) ?? 1)
            )
            .map(([label]) => label)
    );

    log.debug({ sureMicLines: Object.fromEntries(ranked), ownerLeads, others: [...others] }, "microphone voices");
    return { ...(top ? { owner: top[0] } : {}), ownerLeads, others };
}

/**
 * R18 and R19 over the finding of one line. Where the channels fail, only the microphone's own label stands for the
 * user (0.5, to listen). A second person's sure microphone line is not the user's: the people in the call are the
 * candidates (0.4). With such a person in the room, the user's sure microphone lines are capped at 0.7 and asked,
 * and a line the microphone does not clearly hold stays its label's.
 */
function localVoiceFinding(options: {
    line: LineEvidence;
    selfName: string;
    isSelfLabel: boolean;
    voices: MicrophoneVoices;
    unusable: boolean;
    found: EvidenceFinding | undefined;
    platformLabel: boolean;
    indicatorIgnored: boolean;
    eligible: Eligibility;
    mappedCall: boolean;
    hasSeats: boolean;
    observedCallPeople: () => string[];
}): EvidenceFinding | undefined {
    const { line, selfName, voices, found } = options;

    const choices = options.eligible.choices;
    if (
        found?.speaker &&
        found.rules.includes(MeetingRule.SpeakingIndicator) &&
        choices.some((person) => sameName(person, found.speaker!)) &&
        options.eligible.channel.side === "call"
    ) {
        return found;
    }

    if (
        options.eligible.channel.side === "mixed" &&
        line.micShare !== undefined &&
        line.energyMic !== undefined &&
        (line.micShare - 0.5) * (line.energyMic - 0.5) < 0
    ) {
        // Without a seat or another platform identity to reconcile, a coarse segment adds no speaker evidence
        // against R4.3's calibrated reply. Full-line eligibility still filters the result.
        if (!options.hasSeats && (!options.platformLabel || options.isSelfLabel)) {
            return found;
        }
        return {
            candidates: options.eligible.choices,
            rules: [MeetingRule.Channel, MeetingRule.Energy],
            confidence: 0.4,
            listen: true,
            conflict: true,
        };
    }

    if (
        options.platformLabel &&
        !options.isSelfLabel &&
        (line.acoustic?.rawMicShare ?? 0) >= 0.35 &&
        (line.acoustic?.cleanMicShare ?? 1) < 0.65
    ) {
        return {
            candidates: choices,
            rules: [MeetingRule.Channel, MeetingRule.LocalVoice],
            confidence: 0.4,
            listen: true,
            echo: true,
        };
    }
    if ((options.eligible.channel.side === "mic" || options.mappedCall) && choices.length > 1) {
        return {
            candidates: choices,
            rules: [MeetingRule.Channel, MeetingRule.LocalVoice],
            confidence: 0.4,
            listen: true,
            echo: (line.echo ?? 0) >= ECHO_SIMILARITY,
        };
    }
    if (
        choices.length === 1 &&
        callMutes(line).some((name) => !choices.some((other) => sameName(name, other))) &&
        options.eligible.channel.side === "call"
    ) {
        return {
            ...(isStrongCallForNaming(options.eligible.channel) ? { speaker: choices[0] } : { candidates: choices }),
            rules: [MeetingRule.Channel, MeetingRule.Attendance, MeetingRule.Muted],
            confidence: ATTENDANCE_CONFIDENCE,
            elimination: true,
            listen: true,
        };
    }
    if (
        isStrongCallForNaming(options.eligible.channel) &&
        (options.indicatorIgnored || (line.speakingUnknown && Object.keys(line.speaking).length === 0))
    ) {
        // A platform label can be eligible for review without proving that several people shared the call.
        const observed = options.observedCallPeople();
        const remote = choices.filter((name) => observed.some((person) => sameName(name, person)));
        if (options.indicatorIgnored || remote.length >= 2) {
            return {
                candidates: options.indicatorIgnored ? choices : remote,
                rules: [MeetingRule.Channel],
                confidence: 0.4,
                listen: true,
            };
        }
    }

    if (options.unusable) {
        return !options.isSelfLabel && voices.ownerLeads && line.label === voices.owner
            ? { speaker: selfName, rules: [MeetingRule.LabelVoice], confidence: LABEL_VOICE_CONFIDENCE, listen: true }
            : undefined;
    }

    const mic = line.energyMic ?? line.micShare;
    if (
        options.platformLabel &&
        !options.isSelfLabel &&
        mic !== undefined &&
        mic >= 0.65 &&
        (line.echo ?? 0) < ECHO_SIMILARITY
    ) {
        return {
            speaker: selfName,
            candidates: [selfName],
            rules: [MeetingRule.Channel, MeetingRule.LocalVoice],
            confidence: Math.min(0.7, found?.confidence ?? 0.55),
            listen: true,
        };
    }
    if (voices.others.has(line.label) && micSure(line)) {
        return {
            candidates: [selfName],
            rules: [MeetingRule.Channel, MeetingRule.LocalVoice],
            confidence: LOCAL_VOICE_CONFIDENCE,
            listen: true,
        };
    }

    if (voices.others.size > 0 && found?.speaker === selfName) {
        // Two people in the room: a line the microphone does not clearly hold is either of them, or the call.
        if (!micSure(line)) {
            return undefined;
        }

        return {
            ...found,
            rules: [...found.rules, MeetingRule.LocalVoice],
            confidence: Math.min(OWNER_WITH_LOCAL_VOICE_MAX, found.confidence),
            listen: true,
        };
    }

    return found;
}

/** A line of `label` at `sec` inside a swapped stretch under one of its two labels: R20 already said who it is. */
export function inSwap(swaps: SwapStretch[], label: string, sec: number): boolean {
    return swaps.some(
        (swap) =>
            (label === swap.selfLabel || label === swap.otherLabel) &&
            sec >= swap.fromSec &&
            sec <= swap.toSec &&
            !swap.skipped?.includes(sec)
    );
}

/** Inputs shared by the pre-departure voice seeds and the final suggestion pass. */
export interface EvidenceInput {
    meeting: SourceMeeting;
    evidence: MeetingEvidence;
    lines: LineEvidence[];
    presence?: Presence[];
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
    voiceMatches?: Readonly<Record<string, VoiceMatch>>;
    speakers?: LineSpeakers;
    /** The record's items: an agent's speaker ranges over the same lines score their speaker (the polish). */
    items?: readonly MeetingItem[];
    samePerson?: SamePerson;
    record: MeetingRecord;
}

/** One outcome per measured line, in the order used to build ranges for its label. */
export type LineOutcome =
    | { kind: "finding"; line: LineEvidence; finding: EvidenceFinding; nearby: string[]; indicatorReason?: string }
    | { kind: "direct"; line: LineEvidence; item: NewItem }
    | { kind: "none"; line: LineEvidence; reason: "swap-skipped" | "in-swap" | "no-finding" | "ineligible-speaker" };

export interface SpeakerEvidence {
    swapItems: NewItem[];
    labels: Array<{ label: string; outcomes: LineOutcome[] }>;
    swaps: SwapStretch[];
}

/** Grouped scores use the same eligibility and existing ranges that the line rules saw. */
interface EvaluatedEvidence extends SpeakerEvidence {
    rangeContext?: { selfName: string; speakers: LineSpeakers; items: readonly MeetingItem[]; samePerson?: SamePerson };
}

export function speakerEvidence(options: EvidenceInput): EvaluatedEvidence {
    const selfName = options.evidence.selfName ?? options.record.participants.find((person) => person.self)?.name;

    if (
        !selfName ||
        (options.evidence.segments.length === 0 &&
            !options.voiceMatches &&
            !options.lines.some((line) => line.voice?.quality === "matched" || line.energyMic !== undefined))
    ) {
        log.debug({ selfName, segments: options.evidence.segments.length }, "no channel evidence");
        return { swapItems: [], labels: [], swaps: [] };
    }

    // Teams attendance names the user by email; here the user is always `selfName`.
    const renameSelf = options.presence?.some((stay) => stay.self && stay.name !== selfName);
    const presence = renameSelf
        ? options.presence?.map((stay) => (stay.self ? { ...stay, name: selfName } : stay))
        : options.presence;
    const measured =
        renameSelf && presence
            ? options.lines.map((line) => ({ ...line, present: presentAt(presence, line.startSec) }))
            : options.lines;
    const speakers = options.speakers ?? new LineSpeakers({ ...options, presence, selfName, lines: measured });
    const seats = options.record.seats;
    const hasSeats = !!(seats?.room.length || seats?.remote.length || seats?.microphones?.length);
    const unusable = unusableChannelSpans(measured, options.energyMicShare, selfName);
    const assessment = speakers.assessment;
    const stuck = assessment.ignored;
    const lines = measured.map((line) => {
        const shown = stuck.has(line.index) ? { ...line, speaking: {}, liveName: undefined } : line;

        return within(unusable, line.startSec)
            ? {
                  ...shown,
                  micShare: undefined,
                  winner: undefined,
                  winnerShare: undefined,
                  energyMic: undefined,
                  echo: undefined,
              }
            : shown;
    });
    const swapRanges: NewItem[] = [];
    const platformLabels = new Set(
        options.meeting.speakers.filter((speaker) => speaker.origin === "platform").map((speaker) => speaker.name)
    );
    const swapLines = lines.map((line) =>
        line.energyMicRaw === undefined ? line : { ...line, energyMic: line.energyMicRaw }
    );
    const swaps = swappedStretches(swapLines, selfName, platformLabels);
    const swapped = (line: LineEvidence) => inSwap(swaps, line.label, line.startSec);

    for (const swap of swaps) {
        for (const { line, item } of swapItems(swap, selfName, swapLines)) {
            // A matched voice gets the line below, without a competing assignment from the swap.
            if (line.voice?.quality === "matched") {
                continue;
            }
            const choices = speakers.eligibility.get(line.index)?.choices ?? [];
            if (item.speaker === selfName && choices.length > 1) {
                delete item.speaker;
                item.candidates = choices;
                item.confidence = 0.4;
            } else if (!item.speaker || !choices.some((name) => sameName(name, item.speaker!))) {
                continue;
            }

            const candidates = item.candidates;
            const scores = scoreCandidates({
                tallies: lineTallies({
                    lines: [line],
                    eligibility: speakers.eligibility,
                    selfName,
                    nearby: [],
                    micHolds: micSure,
                    samePerson: options.samePerson,
                }).tallies,
                lines: 1,
                label: item.label,
                speaker: item.speaker,
                confidence: item.confidence ?? 0,
                rules: item.rules,
                samePerson: options.samePerson,
            }).filter((score) => !candidates || candidates.some((name) => sameName(name, score.speaker)));
            item.evidence = { ...item.evidence, ...scoresEvidence(scores) };
            swapRanges.push(item);
        }
    }

    const voices = microphoneVoices(
        lines.filter((line) => !within(unusable, line.startSec) && !swapped(line)),
        selfName,
        platformLabels
    );
    log.debug({ unusable, stuckLines: stuck.size, ...voices, others: [...voices.others] }, "microphone voices");
    const byLabel = new Map<string, LineEvidence[]>();

    for (const line of lines) {
        const group = byLabel.get(line.label);
        if (group) {
            group.push(line);
        } else {
            byLabel.set(line.label, [line]);
        }
    }

    const platformLines = lines
        .filter((line) => platformLabels.has(line.label))
        .sort((a, b) => a.startSec - b.startSec);
    const nearbyLabels = (line: LineEvidence): string[] => {
        let low = 0;
        let high = platformLines.length;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (platformLines[mid].startSec < line.startSec - OWN_LABEL_SEC) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        const labels = new Set<string>();
        for (let index = low; index < platformLines.length; index += 1) {
            const near = platformLines[index];
            if (near.startSec > line.startSec + OWN_LABEL_SEC) {
                break;
            }
            if (near.label !== line.label) {
                labels.add(near.label);
            }
        }
        return [...labels];
    };

    const confirmedByLabel = new Map<string, Array<Extract<MeetingItem, { kind: "speaker-range" }>>>();
    for (const item of options.items ?? []) {
        if (item.kind === "speaker-range" && item.status === "confirmed") {
            const group = confirmedByLabel.get(item.label) ?? [];
            group.push(item);
            confirmedByLabel.set(item.label, group);
        }
    }

    const labels: SpeakerEvidence["labels"] = [];
    for (const [label, labelLines] of byLabel) {
        const outcomes: LineOutcome[] = [];
        labels.push({ label, outcomes });
        const isSelfLabel = sameName(label, selfName);

        for (const line of labelLines) {
            const skippedSwap = swaps.some(
                (swap) =>
                    (line.label === swap.selfLabel || line.label === swap.otherLabel) &&
                    swap.skipped?.includes(line.startSec)
            );
            if (skippedSwap && line.voice?.quality !== "matched") {
                outcomes.push({ kind: "none", line, reason: "swap-skipped" });
                continue;
            }
            const voice = options.voiceMatches?.[String(line.index)];
            const eligible = speakers.eligibility.get(line.index)!;
            if (
                voice?.quality === "matched" &&
                voice.person &&
                speakers.allowsMatchedVoice(line, voice.person) &&
                !confirmedByLabel
                    .get(label)
                    ?.some((item) => line.startSec >= item.fromSec && line.startSec <= item.toSec)
            ) {
                const item: NewItem = {
                    kind: "speaker-range",
                    status: "suggested",
                    label,
                    fromSec: line.startSec,
                    toSec: line.startSec,
                    speaker: voice.person,
                    confidence: 0.8,
                    rules: [MeetingRule.VoiceEmbedding],
                    evidence: {
                        endSec: line.endSec,
                        voice,
                        decisionGate: "cosine and margin",
                        confidenceMeaning: "rule gate passed; cosine is not probability",
                    },
                };
                outcomes.push({ kind: "direct", line, item });
                continue;
            }
            // R20 handled this line, even if timed eligibility prevented it from naming a speaker.
            if (swapped(line) && line.voice?.quality !== "matched") {
                outcomes.push({ kind: "none", line, reason: "in-swap" });
                continue;
            }

            const nearby = nearbyLabels(line);
            const found = findingFor({
                line,
                selfName,
                isSelfLabel,
                platformLabel: platformLabels.has(label),
                ownLabelNearby: nearby,
                eligible,
            });
            // A confirmed voice match (its presence and mute checks passed in findingFor) names the person outright: the
            // channel and label fallbacks of R18 and R19 never replace it.

            const finding = found?.rules.includes(MeetingRule.Voice)
                ? found
                : localVoiceFinding({
                      line,
                      selfName,
                      isSelfLabel,
                      voices,
                      eligible,
                      hasSeats,
                      platformLabel: platformLabels.has(label),
                      mappedCall:
                          eligible.channel.side === "call" &&
                          speakingNames(line).length === 1 &&
                          (speakers.isRoomDevice(speakingNames(line)[0]!) ||
                              !!options.record.seats?.microphones?.some(
                                  (group) => group.deviceId && sameName(group.deviceId, speakingNames(line)[0]!)
                              )),
                      indicatorIgnored: stuck.has(line.index),
                      observedCallPeople: () => [
                          ...(line.present ??
                              assessment.candidates.filter((p) => p.fromSec <= line.startSec).map((p) => p.name)),
                          ...(options.record.seats?.remote.map((seat) => seat.name) ?? []),
                      ],
                      unusable: within(unusable, line.startSec),
                      found,
                  });

            if (!finding) {
                outcomes.push({ kind: "none", line, reason: "no-finding" });
                continue;
            }

            if (
                finding.speaker &&
                (speakers.isRoomDevice(finding.speaker) ||
                    !eligible.choices.some((name) => sameName(name, finding.speaker!)))
            ) {
                outcomes.push({ kind: "none", line, reason: "ineligible-speaker" });
                continue;
            }
            if (finding.candidates) {
                finding.candidates = finding.candidates.filter(
                    (name) => !speakers.isRoomDevice(name) && eligible.choices.some((other) => sameName(name, other))
                );
            }

            outcomes.push({
                kind: "finding",
                line,
                finding,
                nearby,
                ...(stuck.has(line.index) ? { indicatorReason: assessment.reasons.get(line.index) } : {}),
            });
        }
    }

    return {
        swapItems: swapRanges,
        labels,
        swaps,
        rangeContext: { selfName, speakers, items: options.items ?? [], samePerson: options.samePerson },
    };
}

/** The independent speaking-indicator lines sure enough to seed the voice pass. */
export function independentIndicatorLines(evidence: SpeakerEvidence, applyAbove: number): Map<number, string> {
    const indicators = new Map<number, string>();
    for (const { outcomes } of evidence.labels) {
        for (const outcome of outcomes) {
            if (outcome.kind !== "finding") {
                continue;
            }

            const { finding, line } = outcome;
            if (
                finding.speaker &&
                finding.rules.includes(MeetingRule.SpeakingIndicator) &&
                !finding.listen &&
                !finding.echo &&
                !finding.conflict &&
                finding.confidence >= applyAbove
            ) {
                indicators.set(line.index, finding.speaker);
            }
        }
    }
    return indicators;
}

/** Group consecutive findings, preserving swap items first and the first-seen label order. */
function rangesOf(evidence: EvaluatedEvidence): { items: NewItem[]; swaps: SwapStretch[] } {
    const { swaps, rangeContext } = evidence;
    const items = [...evidence.swapItems];
    if (!rangeContext) {
        return { items, swaps };
    }

    const { selfName, speakers, samePerson } = rangeContext;
    let open:
        | {
              item: Extract<NewItem, { kind: "speaker-range" }>;
              key: string;
              shares: number[];
              echoLines: number;
              endSec: number;
              /** The range's lines and, per line, the platform labels talking within 10 s (R17). */
              lines: LineEvidence[];
              nearby: string[][];
          }
        | undefined;
    const close = () => {
        if (open) {
            const mean = open.shares.reduce((sum, share) => sum + share, 0) / open.shares.length;
            const confidence = Math.round(mean * 100) / 100;
            open.item.confidence = confidence;
            const tallies = lineTallies({
                lines: open.lines,
                selfName,
                nearby: open.nearby,
                eligibility: speakers.eligibility,
                micHolds: micSure,
                samePerson,
            });
            addPolish(tallies, {
                items: rangeContext.items,
                label: open.item.label,
                fromSec: open.item.fromSec,
                toSec: open.endSec,
            });
            const eligible = speakers.eligibility.get(open.lines[0]!.index)!;
            const candidateScores = scoreCandidates({
                tallies: tallies.tallies.filter((tally) => eligible.choices.some((name) => sameName(name, tally.name))),
                lines: open.lines.length,
                label: open.item.label,
                speaker: open.item.speaker,
                confidence,
                rules: open.item.rules,
                samePerson,
            });
            open.item.evidence = {
                ...open.item.evidence,
                lines: open.shares.length,
                endSec: open.endSec,
                ...(open.echoLines > 0 ? { echoLines: open.echoLines } : {}),
                ...(open.item.rules.includes(MeetingRule.Voice)
                    ? {
                          voiceEvidence: open.lines.map((line) => ({
                              index: line.index,
                              fromSec: line.startSec,
                              toSec: line.endSec,
                              ...line.voice,
                          })),
                      }
                    : {}),
                ...(candidateScores.length > 0
                    ? {
                          candidateScores:
                              open.item.rules.includes(MeetingRule.LocalVoice) && open.item.candidates
                                  ? candidateScores.filter((score) =>
                                        open!.item.candidates!.some((name) => sameName(name, score.speaker))
                                    )
                                  : candidateScores,
                      }
                    : {}),
            };
            items.push(open.item);
            open = undefined;
        }
    };

    for (const { label, outcomes } of evidence.labels) {
        for (const outcome of outcomes) {
            // A range holds only consecutive lines with its finding: a line without one stays its label's.
            if (outcome.kind !== "finding") {
                close();
                if (outcome.kind === "direct") {
                    items.push(outcome.item);
                }
                continue;
            }

            const { line, finding, nearby, indicatorReason } = outcome;
            const indicatorIgnored = "indicatorReason" in outcome;
            const eligible = speakers.eligibility.get(line.index)!;
            // A voice finding and a channel finding stay apart, so a range's rules and voice evidence fit every line.
            const key = `${speakers.key(line.index)}|${finding.elimination ?? false}|${finding.speaker ?? ""}|${(finding.candidates ?? []).join(",")}|${finding.listen ? "listen" : ""}|${finding.rules.includes(MeetingRule.Voice) ? "voice" : ""}|${finding.conflict ? "conflict" : ""}`;

            if (open && open.key === key && line.startSec - open.item.toSec < EVIDENCE_GAP_SEC) {
                open.item.toSec = line.startSec;
                open.endSec = Math.max(open.endSec, line.endSec);
                open.shares.push(finding.confidence);
                open.echoLines += finding.echo ? 1 : 0;
                open.lines.push(line);
                open.nearby.push(nearby);
                continue;
            }

            close();
            const micFinding =
                eligible.channel.side === "mic" ||
                (eligible.channel.side === "mixed" &&
                    !finding.conflict &&
                    finding.rules.includes(MeetingRule.Energy) &&
                    (line.energyMic ?? 0) > ENERGY_CALL_LEANS);
            open = {
                key,
                shares: [finding.confidence],
                echoLines: finding.echo ? 1 : 0,
                endSec: line.endSec,
                lines: [line],
                nearby: [nearby],
                item: {
                    kind: "speaker-range",
                    status: "suggested",
                    label,
                    fromSec: line.startSec,
                    toSec: line.startSec,
                    ...(finding.speaker ? { speaker: finding.speaker } : {}),
                    ...(finding.candidates ? { candidates: finding.candidates } : {}),
                    confidence: finding.confidence,
                    rules: finding.rules,
                    evidence: {
                        channel: micFinding ? "mic" : "system",
                        ...(finding.elimination ? { reviewOnly: true, reason: "mute-elimination" } : {}),
                        ...(eligible.channel.side === "call" &&
                        !finding.speaker &&
                        (line.speakingUnknown || indicatorIgnored)
                            ? { sharedCallUnknown: true }
                            : {}),
                        ...(finding.conflict ? { channelConflict: true } : {}),
                        ...(indicatorIgnored ? { indicatorIgnored: indicatorReason, indicatorReason } : {}),
                        ...(finding.listen
                            ? { listen: true, note: "both channels in these lines: confirm by listening" }
                            : {}),
                    },
                },
            };
        }

        close();
    }

    const lineCount = evidence.labels.reduce((sum, group) => sum + group.outcomes.length, 0);
    log.debug({ lines: lineCount, items: items.length, swaps }, "evidence items");
    return { items, swaps };
}

/** The channel and energy items, and the swapped stretches (R20) that the arrival rule must leave alone too. */
export function evidenceItems(input: EvidenceInput): { items: NewItem[]; swaps: SwapStretch[] } {
    return rangesOf(speakerEvidence(input));
}
