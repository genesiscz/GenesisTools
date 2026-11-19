import { IntervalIndex } from "@genesiscz/utils/array";
import { DEFAULT_APPLY_ABOVE, type MeetingsConfig } from "@genesiscz/utils/meetings/config";
import type { ChannelEmbedding, LineEmbedding } from "@genesiscz/utils/meetings/voice";
import type { SampleSource } from "@genesiscz/utils/meetings/voice-library";
import type { VoicePrint, VoiceStore } from "@genesiscz/utils/meetings/voice-store";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { Seat, TrackKind } from "./sound";
import type { LabelContext, LineLabel } from "./speaker-labels/types";

type VoiceSettings = MeetingsConfig["global"]["speakerLabels"]["voice"];
export type VoiceGate = VoiceSettings["gate"];
export type VoiceLine = LineEmbedding & {
    seat: Seat;
    track: TrackKind;
    fromSec?: number;
    toSec?: number;
    eligible?: string[];
};
type ReadyVoice = Extract<ChannelEmbedding, { quality: "ready" }>;
type Stay = LabelContext["attended"][number];

interface NamingInputs {
    lines: readonly VoiceLine[];
    store: VoiceStore;
    attended: readonly Stay[];
    gate: VoiceGate;
    minSeconds: number;
    exclusion?: VoiceSettings["exclusion"];
    meeting?: string;
    lineKeys?: readonly string[];
    sources?: ReadonlyMap<VoicePrint, SampleSource>;
    certain?: LabelContext["certain"];
    applyAbove?: number;
}

export function unit(vector: number[]): number[] | undefined {
    const length = Math.hypot(...vector);
    return length > 0 && Number.isFinite(length) ? vector.map((v) => v / length) : undefined;
}

export function addVector(sum: number[], vector: number[], sign: 1 | -1): void {
    for (let i = 0; i < sum.length; i++) {
        sum[i]! += sign * vector[i]!;
    }
}

/** Normalise each print before averaging, so a louder vector cannot dominate a person's prototype. */
export function meanVoice(embeddings: readonly number[][]): number[] | undefined {
    const sum = Array<number>(embeddings[0]?.length ?? 0).fill(0);
    for (const embedding of embeddings) {
        const vector = embedding.length === sum.length && unit(embedding);
        if (vector) {
            addVector(sum, vector, 1);
        }
    }
    return unit(sum);
}

interface WindowPrint {
    lineKey?: string;
    fromSec: number;
    toSec: number;
    vector: number[];
    voice?: ReadyVoice;
}

interface VoiceVector {
    seat: Seat;
    track: TrackKind;
    model: string;
    vector: number[];
}
type Target = VoiceVector & WindowPrint & { voice: ReadyVoice };

interface Profile {
    sum: number[];
    count: number;
    windows: WindowPrint[];
    /** The same-meeting windows by their line time, and by their source audio and channel, for the overlap lookups. */
    byTime: IntervalIndex<WindowPrint>;
    byAudio: Map<string, IntervalIndex<WindowPrint>>;
    /** The windows by their transcript line, and the spans of every window and of the windows without a line key. */
    byLineKey: Map<string, WindowPrint[]>;
    spans: Set<string>;
    keylessSpans: Set<string>;
    external: number[][];
}

function audioKey(voice: ReadyVoice): string {
    return `${voice.source.audioPath}\0${voice.channel}`;
}

function profileKey(person: string, sample: VoiceVector): string {
    return [person, sample.seat, sample.track, sample.model, sample.vector.length].join("\0");
}

/** Only this meeting's windows can overlap the target. The other prints contribute to a reusable sum. */
function voiceProfiles(options: NamingInputs, people: string[]) {
    const profiles = new Map<string, Profile>();
    const enrolled = new Set<string>();
    const canonical = new Map<string, string | undefined>();
    function add(name: string, sample: VoiceVector & { window?: WindowPrint }) {
        if (!canonical.has(name)) {
            canonical.set(
                name,
                people.find((person) => sameName(name, person))
            );
        }
        const person = canonical.get(name);
        if (!person) {
            return;
        }
        enrolled.add(person);
        const { vector, window } = sample;
        const key = profileKey(person, sample);
        const profile: Profile = profiles.get(key) ?? {
            sum: Array<number>(vector.length).fill(0),
            count: 0,
            windows: [],
            byTime: new IntervalIndex(),
            byAudio: new Map(),
            byLineKey: new Map(),
            spans: new Set(),
            keylessSpans: new Set(),
            external: [],
        };
        if (window) {
            const span = `${window.fromSec}:${window.toSec}`;
            // Two windows of one transcript line are the same window; without both line keys, the same span is.
            if (
                window.lineKey
                    ? profile.byLineKey.has(window.lineKey) || profile.keylessSpans.has(span)
                    : profile.spans.has(span)
            ) {
                return;
            }
            profile.spans.add(span);
            if (!window.lineKey) {
                profile.keylessSpans.add(span);
            }
            if (window.lineKey !== undefined) {
                profile.byLineKey.set(window.lineKey, [...(profile.byLineKey.get(window.lineKey) ?? []), window]);
            }
            profile.windows.push(window);
            profile.byTime.add(window.fromSec, window.toSec, window);
            if (window.voice) {
                const byAudio = profile.byAudio.get(audioKey(window.voice)) ?? new IntervalIndex();
                byAudio.add(window.voice.fromSec, window.voice.toSec, window);
                profile.byAudio.set(audioKey(window.voice), byAudio);
            }
        } else {
            profile.external.push(vector);
        }
        addVector(profile.sum, vector, 1);
        profile.count++;
        profiles.set(key, profile);
    }

    for (const [name, person] of Object.entries(options.store.people)) {
        const seen = new Set<string>();
        for (const sample of person.samples) {
            const vector = unit(sample.embedding);
            const source = options.sources?.get(sample);
            const identity =
                source && [source.rootMeeting, source.lineKey, sample.track, sample.embedding.length].join("\0");
            if (identity && seen.has(identity)) {
                continue;
            }
            if (identity) {
                seen.add(identity);
            }
            if (vector) {
                add(name, {
                    seat: sample.seat,
                    track: sample.track,
                    model: options.store.model,
                    vector,
                    window:
                        (source?.rootMeeting ?? sample.meeting) === options.meeting
                            ? { lineKey: source?.lineKey, fromSec: sample.fromSec, toSec: sample.toSec, vector }
                            : undefined,
                });
            }
        }
    }
    for (const line of options.lines) {
        const person = options.certain?.get(line.index);
        const voice = line.channels.find((channel) => channel.quality === "ready");
        if (!person || !voice) {
            continue;
        }
        const fromSec = line.fromSec ?? voice.fromSec;
        const toSec = line.toSec ?? voice.toSec;
        const vector = unit(voice.embedding);
        if (
            vector &&
            toSec - fromSec >= options.minSeconds &&
            options.attended.some(
                (stay) =>
                    stay.seat === line.seat &&
                    sameName(stay.person, person) &&
                    stay.fromSec <= fromSec &&
                    stay.toSec >= toSec
            )
        ) {
            add(person, {
                seat: line.seat,
                track: line.track,
                model: voice.model,
                vector,
                window: { fromSec, toSec, vector, voice, lineKey: options.lineKeys?.[line.index] },
            });
        }
    }
    return { profiles, enrolled };
}

/**
 * The same-meeting windows that overlap the target: the same transcript line (`lineKey`), the line time, or the same
 * source audio and channel. Looked up in the profile's indexes, so a long meeting does not scan every training window
 * for every target line.
 */
function overlappingWindows(profile: Profile, { fromSec, toSec, voice, lineKey }: Target): Set<WindowPrint> {
    const found = new Set(profile.byTime.overlapping(fromSec, toSec));
    for (const window of profile.byAudio.get(audioKey(voice))?.overlapping(voice.fromSec, voice.toSec) ?? []) {
        found.add(window);
    }
    for (const window of lineKey === undefined ? [] : (profile.byLineKey.get(lineKey) ?? [])) {
        found.add(window);
    }
    return found;
}

export function dot(a: number[], b: number[]): number {
    let score = 0;
    for (let i = 0; i < a.length; i++) {
        score += a[i]! * b[i]!;
    }
    return score;
}

function profileScore(profile: Profile, target: Target) {
    const overlaps = overlappingWindows(profile, target);
    if (overlaps.size === profile.count) {
        return undefined;
    }
    const sum = overlaps.size ? [...profile.sum] : profile.sum;
    for (const print of overlaps) {
        addVector(sum, print.vector, -1);
    }
    const length = Math.hypot(...sum);
    if (length <= Number.EPSILON * profile.count) {
        return undefined;
    }
    return Math.max(-1, Math.min(1, dot(target.vector, sum) / length));
}

/** Compare the individual prints too. A poor match to a person's mean can hide a close match to one of their lines. */
function closestPrint(profile: Profile, target: Target): number {
    let closest = -1;
    for (const print of profile.external) {
        closest = Math.max(closest, dot(target.vector, print));
    }
    const overlaps = overlappingWindows(profile, target);
    for (const print of profile.windows) {
        if (!overlaps.has(print)) {
            closest = Math.max(closest, dot(target.vector, print.vector));
        }
    }
    return Math.min(1, closest);
}

/** Pure seat- and time-scoped proposals. Every excluded name needs a human answer. */
export function nameByVoice(options: NamingInputs): LineLabel[] {
    const { gate, exclusion, applyAbove = DEFAULT_APPLY_ABOVE } = options;
    const people: string[] = [];
    const stays = options.attended.map((stay) => {
        const person = people.find((other) => sameName(other, stay.person));
        if (person) {
            return { ...stay, person };
        }
        people.push(stay.person);
        return stay;
    });
    const { profiles, enrolled } = voiceProfiles(options, people);
    const groups = new Map<Stay, Array<{ label: LineLabel; vector: number[]; model: string }>>();
    const labels = options.lines.map((line): LineLabel => {
        const base = { labeler: "voice" as const, index: line.index, seat: line.seat };
        const voice = line.channels.find((channel) => channel.quality === "ready");
        const vector = voice && unit(voice.embedding);
        if (
            !voice ||
            !vector ||
            (options.store.model && options.store.model !== voice.model && !options.certain?.size)
        ) {
            return { ...base, reason: "no-voice" };
        }
        const fromSec = line.fromSec ?? voice.fromSec;
        const toSec = line.toSec ?? voice.toSec;
        if (toSec - fromSec < options.minSeconds) {
            return { ...base, reason: "no-voice" };
        }
        const target = {
            lineKey: options.lineKeys?.[line.index],
            seat: line.seat,
            track: line.track,
            model: voice.model,
            vector,
            fromSec,
            toSec,
            voice,
        };
        const touching = stays.filter(
            (stay) => stay.seat === line.seat && stay.fromSec < toSec && stay.toSec > fromSec
        );
        const present = new Map(
            touching.filter((stay) => stay.fromSec <= fromSec && stay.toSec >= toSec).map((stay) => [stay.person, stay])
        );
        const eligiblePeople = [...present.keys()].filter(
            (person) => !line.eligible || line.eligible.some((name) => sameName(name, person))
        );
        const candidates = eligiblePeople
            .flatMap((person) => {
                const profile = profiles.get(profileKey(person, target));
                const score = profile && profileScore(profile, target);
                return score === undefined ? [] : [{ person, score }];
            })
            .sort((a, b) => b.score - a.score);
        const [first, second] = candidates;
        const missing = [...present.values()].filter(
            (stay) =>
                eligiblePeople.includes(stay.person) && !candidates.some((sample) => sample.person === stay.person)
        );
        const unknown = missing[0];
        if (!first) {
            return {
                ...base,
                reason: unknown ? "unsampled-present" : "no-rival-sample",
                ...(unknown && missing.length === 1 ? { next: { person: unknown.person, score: 0 } } : {}),
            };
        }
        const scored = { ...base, score: first.score, ...(second ? { next: second } : {}) };
        if (present.size === 1 && first.score < gate.strangerScore) {
            return { ...scored, next: first, reason: "not-the-seat-person" };
        }
        let margin = gate.score - first.score;
        if (
            exclusion?.enabled &&
            unknown &&
            missing.length === 1 &&
            !enrolled.has(unknown.person) &&
            !options.certain?.has(line.index) &&
            touching.every((stay) => present.has(stay.person)) &&
            (!line.eligible ||
                line.eligible.every((name) => eligiblePeople.some((person) => sameName(person, name)))) &&
            margin > 0 &&
            margin >= exclusion.margin
        ) {
            let closest = first;
            for (const candidate of candidates) {
                const profile = profiles.get(profileKey(candidate.person, target))!;
                const score = closestPrint(profile, target);
                if (score > closest.score) {
                    closest = { person: candidate.person, score };
                }
            }
            margin = gate.score - closest.score;
            if (margin > 0 && margin >= exclusion.margin) {
                const label: LineLabel = { ...base, next: closest, reason: "exclusion-too-few-lines", margin };
                const group = groups.get(unknown) ?? [];
                group.push({ label, vector, model: voice.model });
                groups.set(unknown, group);
                return label;
            }
        }
        if (unknown && first.score < gate.unsampledScore) {
            return {
                ...scored,
                ...(missing.length === 1 ? { next: { person: unknown.person, score: 0 } } : {}),
                reason: "unsampled-present",
            };
        }
        if (!second && first.score < gate.loneScore) {
            return { ...scored, reason: "no-rival-sample" };
        }
        if (first.score < gate.score || (second && first.score - second.score < gate.margin)) {
            return { ...scored, reason: "below-gate" };
        }
        return { ...scored, person: first.person, reason: "named" };
    });

    if (exclusion) {
        for (const [stay, group] of groups) {
            if (group.length < exclusion.minLines) {
                continue;
            }
            // For unit vectors, mean cosine to their own unit centroid is the norm of their mean.
            const sum = Array<number>(group[0]!.vector.length).fill(0);
            const compatible = group.every(
                ({ vector, model }) => vector.length === sum.length && model === group[0]!.model
            );
            if (compatible) {
                for (const { vector } of group) {
                    addVector(sum, vector, 1);
                }
            }
            const coherence = Math.hypot(...sum) / group.length;
            for (const { label } of group) {
                if (!compatible || coherence === 0 || coherence < exclusion.coherence) {
                    label.reason = "exclusion-not-one-voice";
                } else {
                    label.reason = "exclusion";
                    label.person = stay.person;
                    label.score = Math.min(label.margin!, exclusion.maxConfidence, Math.max(0, applyAbove - 0.01));
                }
            }
        }
    }
    return labels;
}
