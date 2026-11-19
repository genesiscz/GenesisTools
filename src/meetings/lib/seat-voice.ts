import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { ChannelCalibration } from "@genesiscz/utils/meetings/energy";
import { nameKey, type RoomDevice } from "@genesiscz/utils/meetings/people";
import { type MeetingRecord, voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { withoutEmptyRemoteSeats } from "@genesiscz/utils/meetings/room-people";
import { type MeetingSeats, seatSpan, wholeMeetingRoomPeople } from "@genesiscz/utils/meetings/seats";
import type { SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { VoiceUnavailableError } from "@genesiscz/utils/meetings/voice";
import { type SampleSource, voiceLineKeys } from "@genesiscz/utils/meetings/voice-library";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { OpenedMeeting } from "./opened-meeting";
import { baselineStays } from "./person-stays";
import { type MeetingSound, PREFERENCE, type Seat, type TrackKind } from "./sound";
import { channelFor, speakersFor } from "./speaker-eligibility";
import { assessIndicator } from "./speaker-indicator";
import { ENERGY_MIC_LEANS } from "./speaker-labels/seat";
import type { LabelContext } from "./speaker-labels/types";
import {
    embeddedLineSource,
    embedSeatLines,
    localVoiceDecisions,
    meetingPredictionVoices,
    meetingVoiceCachePath,
} from "./speaker-labels/voice";
import { nameByVoice, type VoiceLine } from "./voice-names";

export interface SeatVoiceHint {
    person: string;
    seat: "room" | "remote" | "unsure";
    mic?: number;
    call?: number;
    reason: string;
    confidence: number;
}

export interface SeatVoiceInput {
    people: readonly string[];
    lines: readonly VoiceLine[];
    root: string;
    lineKeys: readonly string[];
    prediction: Pick<ReturnType<typeof meetingPredictionVoices>, "store" | "sources">;
    settings: Pick<MeetingsConfig["global"]["speakerLabels"]["voice"], "gate" | "minSeconds" | "seatOppositeShare">;
    allows: (person: string, index: number) => boolean;
}

function unavailableText(reason: string): string {
    return reason === "Speaker model unavailable; run meetings voice prepare explicitly"
        ? `the speaker model is not installed (${toolCommand("meetings", "voice", "prepare")}).`
        : reason.endsWith(".")
          ? reason
          : `${reason}.`;
}

/** Compare all eligible voices on the recorded track. No saved seat, temporary seed or exclusion is a vote. */
export function suggestSeatByVoice(input: SeatVoiceInput): ReadonlyArray<SeatVoiceHint> {
    const sides = ["mic", "call"] as const;
    const attended = input.people.flatMap((person) =>
        sides.map((seat) => ({ person, seat, fromSec: 0, toSec: Infinity }))
    );
    const labels = nameByVoice({
        ...input.prediction,
        gate: input.settings.gate,
        minSeconds: input.settings.minSeconds,
        meeting: input.root,
        lineKeys: input.lineKeys,
        lines: input.lines,
        attended,
    });
    type Vote = { fromSec: number; toSec: number; score: number; key: string };
    const votes = new Map<string, Record<Seat, Vote[]>>(input.people.map((person) => [person, { mic: [], call: [] }]));
    const compared = new Set<Seat>();
    const failures: Partial<Record<Seat, string>> = {};
    for (const [position, label] of labels.entries()) {
        const line = input.lines[position]!;
        if (label.score !== undefined) {
            compared.add(line.seat);
        } else {
            const unknown = line.channels.find((channel) => channel.quality === "unknown");
            failures[line.seat] ??=
                unknown?.reason ??
                (line.channels.length
                    ? "no compatible independent voice sample could be compared"
                    : "no compatible audio track covers the eligible lines");
        }
        if (
            label.reason !== "named" ||
            !label.person ||
            label.score === undefined ||
            !input.allows(label.person, label.index)
        ) {
            continue;
        }
        const key = input.lineKeys[line.index];
        if (key !== undefined && line.fromSec !== undefined && line.toSec !== undefined) {
            const side = votes.get(label.person)![line.seat];
            side.push({ fromSec: line.fromSec, toSec: line.toSec, score: label.score, key });
        }
    }
    const missing = sides.filter((side) => !compared.has(side));
    const unavailable = (side: Seat) => unavailableText(failures[side] ?? "no eligible lines");
    const coverage =
        missing.length === 2 && unavailable("mic") === unavailable("call")
            ? `Voice matches unavailable: ${unavailable("mic")}`
            : missing
                  .map(
                      (side) =>
                          `${side === "mic" ? "Microphone" : "Call"} voice matches unavailable: ${unavailable(side)}`
                  )
                  .join(" ");
    // An opposite side with eligible but unscored lines could still carry conflicting matches.
    const incomplete = missing.some((side) => failures[side] !== undefined);
    return Array.from(votes, ([person, bySide]) => {
        const count = { mic: 0, call: 0 };
        const weakest = { mic: 1, call: 1 };
        for (const side of sides) {
            // Earliest finish retains the largest set of disjoint half-open spans.
            let end = -Infinity;
            const seen = new Set<string>();
            for (const vote of bySide[side].sort((a, b) => a.toSec - b.toSec)) {
                if (vote.fromSec >= end && !seen.has(vote.key)) {
                    end = vote.toSec;
                    seen.add(vote.key);
                    count[side]++;
                    weakest[side] = Math.min(weakest[side], vote.score);
                }
            }
        }
        const { mic, call } = count;
        const stronger = mic > call ? "mic" : "call";
        const opposite = Math.min(mic, call);
        const dominant =
            !incomplete && count[stronger] >= 2 && opposite / count[stronger] <= input.settings.seatOppositeShare;
        const seat = dominant ? (stronger === "mic" ? "room" : "remote") : "unsure";
        const counts = sides
            .filter((side) => compared.has(side))
            .map((side) => `${count[side]} ${side === "mic" ? "microphone" : "call"}`);
        const detail =
            !dominant && mic && call
                ? "Voice matches occur on both sides."
                : seat === "unsure" && !incomplete && counts.length
                  ? "Two lines on one side are needed."
                  : "";
        return {
            person,
            seat,
            ...(compared.has("mic") ? { mic } : {}),
            ...(compared.has("call") ? { call } : {}),
            confidence: dominant ? weakest[stronger] : 0,
            reason: [counts.length ? `Independent voice matches (${counts.join(", ")}).` : "", coverage, detail]
                .filter(Boolean)
                .join(" "),
        };
    });
}

/** Test room occupancy as a possibility for every unseated guest, even before that guest joined the call. */
function discoverySpans({
    devices,
    record,
    people,
    evidence,
    seats,
}: {
    devices: readonly RoomDevice[];
    record: MeetingRecord;
    people: readonly string[];
    evidence: LineEvidence[];
    seats?: MeetingSeats;
}) {
    const saved = withoutEmptyRemoteSeats(seats);
    const seated = new Set(
        [...(saved?.room ?? []), ...(saved?.remote ?? [])].map((row) => nameKey(seatSpan(row).name))
    );
    const micSeats = {
        ...saved,
        room: [...(saved?.room ?? []), ...people.filter((name) => !seated.has(nameKey(name)))],
        remote: saved?.remote ?? [],
    };
    const selfName = record.participants.find((person) => person.self)?.name;
    const { ignored } = assessIndicator({
        lines: evidence,
        selfName: selfName ?? "",
        roomPeople: wholeMeetingRoomPeople(saved),
    });
    const callStays = people.flatMap((name) => {
        const stays = baselineStays(record, name);
        // An explicit empty stay list provides zero coverage. Missing attendance leaves an open candidate.
        if (stays?.length === 0) {
            return [{ name, fromSec: 0, toSec: 0 }];
        }
        return (stays ?? []).map(({ stay }) => ({ name, fromSec: stay.fromSec, toSec: stay.toSec }));
    });
    return evidence.flatMap((line): LabelContext["lines"][number][] => {
        const energyMic = line.energyMic ?? line.energyMicRaw;
        const micShare = energyMic === undefined ? line.micShare : undefined;
        const channel = channelFor({ energyMic, micShare });
        if (
            !channel.strong ||
            (channel.side !== "mic" && channel.side !== "call") ||
            (channel.side === "mic" && (energyMic ?? micShare)! < ENERGY_MIC_LEANS)
        ) {
            return [];
        }
        const span = { index: line.index, fromSec: line.startSec, toSec: line.endSec };
        const { choices } = speakersFor(span, {
            ...line,
            devices,
            micShare,
            energyMic,
            selfName,
            people,
            callStays,
            seats: channel.side === "mic" ? micSeats : saved,
            ignoredIndicator: ignored.has(line.index),
        });
        return choices.length ? [{ ...span, seat: channel.side, eligible: choices }] : [];
    });
}

/** The normal voice-track preference, restricted to enrolled tracks whose side we can establish. */
async function discoverySound(options: {
    opened: OpenedMeeting;
    config: MeetingsConfig;
    calibration?: ChannelCalibration;
    enrolled: ReadonlySet<TrackKind>;
}): Promise<MeetingSound> {
    const { opened, config, calibration, enrolled } = options;
    const { record } = opened;
    // Use the measured channel order even if the stored calibration is stale. The sound reader uses this
    // in-memory record to map mic and call to file channels and to align the recorder on the same clock.
    const calibrated =
        calibration && calibration.layout !== record.evidence?.channels?.layout
            ? OpenedMeeting.of(
                  opened.store,
                  { ...record, evidence: { ...record.evidence, channels: calibration } },
                  await opened.linked(),
                  config
              )
            : opened;
    const { voiceReadMeeting } = await import("./voices");
    const read = await (await voiceReadMeeting(calibrated)).sound();
    const layout = calibrated.record.evidence?.channels?.layout ?? "unknown";
    const tracks = read.tracks.filter(
        (track) =>
            enrolled.has(track.kind) &&
            (track.from.kind === "source" ? layout !== "unknown" : config.global.playback.tracks === "best")
    );
    const compatible = new Set(tracks.map((track) => track.kind));
    return {
        tracks,
        slice(request) {
            for (const track of PREFERENCE.voice[request.seat]) {
                if (compatible.has(track)) {
                    const slice = read.slice({ ...request, track });
                    if (slice) {
                        return slice;
                    }
                }
            }
            return undefined;
        },
    };
}

export async function readSeatVoiceHints(options: {
    opened: OpenedMeeting;
    people: readonly string[];
    seats?: MeetingSeats;
    readEvidence: () => Promise<{ meeting?: SourceMeeting; lines: LineEvidence[]; calibration?: ChannelCalibration }>;
}): Promise<ReadonlyArray<SeatVoiceHint>> {
    const { opened, people } = options;
    const { record } = opened;
    const config = await opened.config();
    const settings = config.global.speakerLabels.voice;
    if (!record.project || !settings.enabled) {
        return [];
    }
    const prediction = meetingPredictionVoices({
        record,
        project: record.project,
        people,
        scope: settings.sampleScope,
    });
    if (!Object.keys(prediction.store.people).length) {
        return [];
    }
    const { meeting, lines: measured, calibration } = await options.readEvidence();
    if (!meeting) {
        return [];
    }
    const spans = discoverySpans({
        record,
        people,
        evidence: measured,
        seats: options.seats,
        devices: opened.roomDevices,
    }).filter((line) => line.toSec - line.fromSec >= settings.minSeconds);
    let lines: VoiceLine[] = [];
    if (spans.length) {
        const enrolled = new Set(
            Object.values(prediction.store.people).flatMap((person) => person.samples.map((sample) => sample.track))
        );
        const sound = await discoverySound({ opened, config, calibration, enrolled });
        try {
            lines = await embedSeatLines({
                lines: spans,
                config,
                sound,
                cachePath: meetingVoiceCachePath(opened),
                readOnlyCache: true,
            });
        } catch (error) {
            if (!(error instanceof VoiceUnavailableError)) {
                throw error;
            }
            const reason = `Voice matches unavailable: ${unavailableText(error.message)}`;
            return people.map((person) => ({ person, seat: "unsure", confidence: 0, reason }));
        }
    }
    const root = voiceRootMeeting(opened.store, record);
    const lineKeys = voiceLineKeys(meeting);
    const decisions = localVoiceDecisions({ record, root, prediction });
    const targets = new Map<number, SampleSource>();
    if (decisions.any) {
        const hashes = new Map<string, string>();
        for (const line of lines) {
            const source = await embeddedLineSource({ line, root, lineKey: lineKeys[line.index], hashes });
            if (source) {
                targets.set(line.index, source);
            }
        }
    }
    return suggestSeatByVoice({
        people,
        root,
        prediction,
        lines,
        lineKeys,
        settings,
        allows(person, index) {
            const target = targets.get(index);
            return !decisions.any || (!!target && decisions.allows(person, target));
        },
    });
}
