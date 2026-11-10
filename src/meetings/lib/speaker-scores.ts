import type { MeetingItem } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import { z } from "zod";

/**
 * Typed confidence for the people a speaker range could be (G31, the speaker half of R49). The suggest pipeline writes
 * `evidence.candidateScores` on the speaker ranges it makes, as it writes a term's candidate scores, and a speaker
 * question's choices (`meeting.rows`, `listen`) show them. How the numbers are made:
 * - The range's speaker keeps the rule's confidence (the item's), so one choice never shows two numbers.
 * - A range without a speaker gives its confidence (that the voice is not the label's own person) to its candidates.
 *   The label's own person gets no score there: the rule speaks against them.
 * - The others share what is left by weight, from the range's lines: their voice (the user's microphone holds the
 *   line, E3 shows them speaking, E4 names them), being in the call (RA; never for the user, who is always in their own
 *   call), the turn timing (they talk under their own label within 10 s, R17: the same voice cut into another label),
 *   an agent's finding over the same lines (the polish). A share stays with someone the roster does not list
 *   (`unlisted`), smaller when attendance is known.
 * - A candidate with no evidence for them gets no score, never a made-up one.
 * - The people directory folds two names of one person into one candidate.
 */

/** What a candidate's score rests on. */
export const SPEAKER_EVIDENCE_KINDS = ["voice", "roster", "timing", "polish", "directory", "answer"] as const;
export type SpeakerEvidenceKind = (typeof SPEAKER_EVIDENCE_KINDS)[number];

export const speakerEvidenceSchema = z.object({
    kind: z.enum(SPEAKER_EVIDENCE_KINDS),
    /** The rule that read it (`E3`, `RA`, `R17`, `agent`), when one did. */
    rule: z.string().optional(),
    /** Of the range's lines, how many carry it; absent when it is about the whole range. */
    lines: z.number().int().min(0).optional(),
    /** It speaks against the candidate (they were muted, a rule says the voice is not theirs). */
    against: z.literal(true).optional(),
});
export type SpeakerEvidence = z.infer<typeof speakerEvidenceSchema>;

export const speakerScoreSchema = z.object({
    speaker: z.string().min(1),
    /** 0 to 1, comparable with the item's own confidence. */
    confidence: z.number().min(0).max(1),
    /** How many of the range's lines were weighed; absent when the evidence is about the whole range. */
    lines: z.number().int().min(1).optional(),
    evidence: z.array(speakerEvidenceSchema),
});
export type SpeakerScore = z.infer<typeof speakerScoreSchema>;

/**
 * The weights the others' shares are made of, each per share of the range's lines. Calibrated on the two recorded
 * meetings with answers and checked by the meetings tests (src/meetings/README.md, "Speaker candidate scores"):
 * change them only with that check.
 */
export const SPEAKER_WEIGHTS = {
    /** The user's microphone holds the line (E1, energy). */
    mic: 1,
    /** E3 shows the candidate speaking during the line. */
    shown: 0.5,
    /** E4, the live name, is the candidate: it lags behind a change of voice. */
    liveName: 0.1,
    /** In the call over the range (RA): one of those present. */
    roster: 0.2,
    /** They talk under their own label within 10 s (R17): the same voice, cut into another label. The strongest. */
    timing: 2,
    /** An agent's finding naming the candidate over the same lines, times its confidence and its overlap. */
    polish: 2,
    /** The weight of a voice nobody in the list has, when attendance is unknown. */
    unlisted: 0.2,
    /** The same with attendance: it can still miss a second person in the room (R18). */
    unlistedWithRoster: 0.05,
};

const RULE_KINDS = new Map<string, SpeakerEvidenceKind>([
    [MeetingRule.Attendance, "roster"],
    [MeetingRule.Muted, "roster"],
    [MeetingRule.LeavePhrase, "timing"],
    [MeetingRule.ContinuesAfterLeave, "timing"],
    [MeetingRule.FarewellAnswered, "timing"],
    [MeetingRule.EchoedFarewell, "timing"],
    [MeetingRule.Arrival, "timing"],
    [MeetingRule.OwnLabel, "timing"],
    [MeetingRule.Channel, "voice"],
    [MeetingRule.SpeakingIndicator, "voice"],
    [MeetingRule.LiveName, "voice"],
    [MeetingRule.Energy, "voice"],
    [MeetingRule.LocalVoice, "voice"],
    [MeetingRule.LabelVoice, "voice"],
    [MeetingRule.LabelSwap, "voice"],
    [MeetingRule.Agent, "polish"],
    [MeetingRule.User, "answer"],
]);

/** Tells whether two names are one person: the identity rules, and the people directory's aliases when at hand. */
export type SamePerson = (a: string, b: string) => boolean;

/**
 * Two names are one person by the identity rules (`sameName`), or by the people directory: both are names or the
 * email of one known person (its aliases include the names a merge joined).
 */
export function directoryMatcher(people: Array<{ name: string; email?: string; aliases: string[] }>): SamePerson {
    const groups = people.map((person) =>
        [person.name, ...person.aliases, ...(person.email ? [person.email] : [])].map((name) => name.toLowerCase())
    );
    return (a, b) => {
        const left = a.toLowerCase();
        const right = b.toLowerCase();
        return groups.some((names) => names.includes(left) && names.includes(right));
    };
}

/** What the lines of one range say for one candidate. */
export interface CandidateTally {
    name: string;
    /** The recording user: the microphone is their voice, and being in their own call says nothing. */
    self: boolean;
    /** Lines the user's microphone holds, per rule (E1 or energy). */
    mic: Map<string, number>;
    /** Lines E3 shows them speaking. */
    shown: number;
    /** Lines whose live name (E4) is theirs. */
    live: number;
    /** Lines in the call (RA), or the share of the range without lines. Undefined: attendance is unknown. */
    roster?: number;
    /** Lines where they talk under their own label within 10 s (R17). */
    nearby: number;
    /** Lines they were muted through (RM). */
    muted: number;
    /** An agent's finding over the same lines: its confidence times the overlap, 0 to 1. */
    polish: number;
    /** The people directory folded another name of this person into it. */
    directory: boolean;
}

/** Collects candidates by person: one tally per person, whichever of their names a line uses. */
export class CandidateTallies {
    readonly tallies: CandidateTally[] = [];

    constructor(private readonly options: { selfName?: string; samePerson?: SamePerson } = {}) {}

    of(name: string): CandidateTally {
        const named = this.tallies.find((tally) => sameName(tally.name, name));

        if (named) {
            return named;
        }

        const samePerson = this.options.samePerson;
        const folded = samePerson ? this.tallies.find((tally) => samePerson(tally.name, name)) : undefined;

        if (folded) {
            folded.directory = true;
            return folded;
        }

        const selfName = this.options.selfName;
        const tally: CandidateTally = {
            name,
            self: selfName !== undefined && (sameName(name, selfName) || (samePerson?.(name, selfName) ?? false)),
            mic: new Map(),
            shown: 0,
            live: 0,
            nearby: 0,
            muted: 0,
            polish: 0,
            directory: false,
        };
        this.tallies.push(tally);
        return tally;
    }

    find(name: string): CandidateTally | undefined {
        return this.tallies.find(
            (tally) => sameName(tally.name, name) || (this.options.samePerson?.(tally.name, name) ?? false)
        );
    }
}

/**
 * The tallies of a range of evidence lines (rule E1 with E3, E4, RA, RM and R17): every person a line names as present,
 * shown speaking or the live name, and the user when the microphone holds a line.
 */
export function lineTallies(options: {
    lines: LineEvidence[];
    selfName: string;
    /** Per line, the platform-named labels other than its own with a line within 10 s of it (R17). */
    nearby: string[][];
    /** The user's microphone holds the line (a sure energy share, else the live segments). */
    micHolds: (line: LineEvidence) => boolean;
    samePerson?: SamePerson;
}): CandidateTallies {
    const tallies = new CandidateTallies({ selfName: options.selfName, samePerson: options.samePerson });
    const rosterKnown = options.lines.some((line) => line.present !== undefined);

    for (const line of options.lines) {
        const muted = (name: string) => line.muted?.some((person) => sameName(person, name)) === true;

        if (options.micHolds(line)) {
            const rule = line.energyMic !== undefined ? MeetingRule.Energy : MeetingRule.Channel;
            const self = tallies.of(options.selfName);
            self.mic.set(rule, (self.mic.get(rule) ?? 0) + 1);
        }

        for (const [name, readings] of Object.entries(line.speaking)) {
            if (readings > 0 && !muted(name) && !sameName(name, options.selfName)) {
                tallies.of(name).shown += 1;
            }
        }

        if (line.liveName && !muted(line.liveName) && !sameName(line.liveName, options.selfName)) {
            tallies.of(line.liveName).live += 1;
        }

        for (const name of line.present ?? []) {
            const tally = tallies.of(name);
            tally.roster = (tally.roster ?? 0) + 1;
        }

        for (const name of line.muted ?? []) {
            tallies.of(name).muted += 1;
        }
    }

    // After every line is read, so a person first named on a later line still counts an earlier one.
    options.lines.forEach((_line, index) => {
        for (const label of options.nearby[index] ?? []) {
            const talking = tallies.find(label);

            if (talking) {
                talking.nearby += 1;
            }
        }
    });

    if (rosterKnown) {
        for (const tally of tallies.tallies) {
            tally.roster ??= 0;
        }
    }

    return tallies;
}

/**
 * The tallies of a range the transcript and attendance rules found (RA, R1 with R5): each person in the call over it,
 * with the share of the range they were there. `present` names them for the whole range when the rule knows it.
 */
export function rosterTallies(options: {
    fromSec: number;
    toSec: number;
    present?: string[];
    presence?: Array<{ name: string; fromSec: number; toSec: number }>;
    selfName?: string;
    samePerson?: SamePerson;
}): CandidateTallies {
    const tallies = new CandidateTallies({ selfName: options.selfName, samePerson: options.samePerson });
    const span = options.toSec - options.fromSec;

    if (options.present) {
        for (const name of options.present) {
            tallies.of(name).roster = 1;
        }

        return tallies;
    }

    for (const stay of options.presence ?? []) {
        const overlap = Math.min(stay.toSec, options.toSec) - Math.max(stay.fromSec, options.fromSec);
        const share =
            span > 0
                ? Math.max(0, overlap) / span
                : stay.fromSec <= options.fromSec && stay.toSec >= options.toSec
                  ? 1
                  : 0;

        if (share > 0) {
            const tally = tallies.of(stay.name);
            tally.roster = Math.min(1, (tally.roster ?? 0) + share);
        }
    }

    return tallies;
}

/**
 * The polish: an agent's speaker ranges (`items add`, rule `agent`) on the same label over the same time score their
 * speaker, by the agent's confidence (1 once a person confirmed it) times the share of the range they cover.
 */
export function addPolish(
    tallies: CandidateTallies,
    options: { items: readonly MeetingItem[]; label: string; fromSec: number; toSec: number }
): void {
    const span = options.toSec - options.fromSec;

    for (const item of options.items) {
        if (
            item.kind !== "speaker-range" ||
            !item.speaker ||
            item.status === "rejected" ||
            item.label !== options.label ||
            !item.rules.includes(MeetingRule.Agent)
        ) {
            continue;
        }

        const endSec =
            typeof item.evidence?.endSec === "number" ? Math.max(item.toSec, item.evidence.endSec) : item.toSec;
        const overlap = Math.min(endSec, options.toSec) - Math.max(item.fromSec, options.fromSec);
        const covered =
            span > 0 ? Math.max(0, overlap) / span : item.fromSec <= options.fromSec && endSec >= options.toSec ? 1 : 0;
        const sure = item.status === "confirmed" ? 1 : (item.confidence ?? 0);
        const weight = Math.min(1, covered) * sure;

        if (weight > 0) {
            const tally = tallies.of(item.speaker);
            tally.polish = Math.max(tally.polish, weight);
        }
    }
}

/**
 * The weight a candidate's evidence gives them, 0 when nothing speaks for them. `lines` counts the range's lines; without
 * it the tally holds shares of the range (0 to 1) instead of line counts.
 */
function weightOf(tally: CandidateTally, lines: number | undefined): number {
    if (lines !== undefined && lines > 0 && tally.muted >= lines) {
        return 0;
    }

    const share = (count: number) => Math.min(1, lines === undefined ? count : lines > 0 ? count / lines : 0);
    const mic = [...tally.mic.values()].reduce((sum, count) => sum + count, 0);
    const roster = tally.self || tally.roster === undefined ? 0 : share(tally.roster);
    return (
        share(mic) * SPEAKER_WEIGHTS.mic +
        share(tally.shown) * SPEAKER_WEIGHTS.shown +
        share(tally.live) * SPEAKER_WEIGHTS.liveName +
        roster * SPEAKER_WEIGHTS.roster +
        share(tally.nearby) * SPEAKER_WEIGHTS.timing +
        Math.min(1, tally.polish) * SPEAKER_WEIGHTS.polish
    );
}

/** The evidence a tally holds, as a score lists it; line counts only when the tally counted lines. */
function evidenceOf(tally: CandidateTally, counted: boolean): SpeakerEvidence[] {
    const evidence: SpeakerEvidence[] = [...tally.mic].map(([rule, lines]) => ({ kind: "voice", rule, lines }));
    const counts = (lines: number) => (counted ? { lines } : {});

    if (tally.shown > 0) {
        evidence.push({ kind: "voice", rule: MeetingRule.SpeakingIndicator, ...counts(tally.shown) });
    }

    if (tally.live > 0) {
        evidence.push({ kind: "voice", rule: MeetingRule.LiveName, ...counts(tally.live) });
    }

    if (!tally.self && tally.roster !== undefined && tally.roster > 0) {
        evidence.push({ kind: "roster", rule: MeetingRule.Attendance, ...counts(tally.roster) });
    }

    if (tally.nearby > 0) {
        evidence.push({ kind: "timing", rule: MeetingRule.OwnLabel, ...counts(tally.nearby) });
    }

    if (tally.polish > 0) {
        evidence.push({ kind: "polish", rule: MeetingRule.Agent });
    }

    if (tally.directory) {
        evidence.push({ kind: "directory" });
    }

    if (tally.muted > 0) {
        evidence.push({ kind: "roster", rule: MeetingRule.Muted, ...counts(tally.muted), against: true });
    }

    return evidence;
}

/** The item's rules as evidence about the whole range for the person it names. */
export function ruleEvidence(rules: string[]): SpeakerEvidence[] {
    return rules.flatMap((rule) => {
        const kind = RULE_KINDS.get(rule);
        return kind ? [{ kind, rule }] : [];
    });
}

/** Evidence entries of one rule once, the counted one first. */
function joined(...lists: SpeakerEvidence[][]): SpeakerEvidence[] {
    const out: SpeakerEvidence[] = [];

    for (const entry of lists.flat()) {
        if (!out.some((one) => one.kind === entry.kind && one.rule === entry.rule && one.against === entry.against)) {
            out.push(entry);
        }
    }

    return out;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The scores of a range's candidates from their tallies, best first. `confidence` is the item's: in `speaker` when the
 * range names one, else that the voice is not the label's own person. Only candidates with evidence get a score.
 */
export function scoreCandidates(options: {
    tallies: CandidateTally[];
    /** The lines the tallies counted; absent when they hold shares of the whole range (attendance, a goodbye). */
    lines?: number;
    label: string;
    speaker?: string;
    confidence: number;
    rules: string[];
    samePerson?: SamePerson;
}): SpeakerScore[] {
    const same = (a: string, b: string) => sameName(a, b) || (options.samePerson?.(a, b) ?? false);
    const speaker = options.speaker;
    const anchor = speaker ? options.tallies.find((tally) => same(tally.name, speaker)) : undefined;
    // Without a speaker the rule says the voice is not the label's person: they share nothing of its confidence.
    const others = options.tallies
        .filter((tally) => tally !== anchor && (speaker !== undefined || !same(tally.name, options.label)))
        .map((tally) => ({ tally, weight: weightOf(tally, options.lines) }))
        .filter((one) => one.weight > 0);
    const rosterKnown = options.tallies.some((tally) => tally.roster !== undefined);
    const unlisted = rosterKnown ? SPEAKER_WEIGHTS.unlistedWithRoster : SPEAKER_WEIGHTS.unlisted;
    const total = others.reduce((sum, one) => sum + one.weight, 0) + unlisted;
    const rest = speaker ? 1 - options.confidence : options.confidence;
    const counted = options.lines !== undefined && options.lines > 0;
    const lines = counted ? { lines: options.lines } : {};
    const scores: SpeakerScore[] = [];

    if (speaker) {
        scores.push({
            speaker,
            confidence: round(options.confidence),
            ...lines,
            evidence: joined(anchor ? evidenceOf(anchor, counted) : [], ruleEvidence(options.rules)),
        });
    }

    for (const { tally, weight } of others) {
        const confidence = round((rest * weight) / total);

        if (confidence > 0) {
            scores.push({ speaker: tally.name, confidence, ...lines, evidence: evidenceOf(tally, counted) });
        }
    }

    return scores.sort((a, b) => b.confidence - a.confidence);
}

/**
 * The scores with `speaker` at `confidence` (an answer that raised a range, two rules that agree): the others keep
 * their proportions in the room the speaker leaves. `evidence` is added to the speaker's.
 */
export function anchorScores(
    scores: SpeakerScore[],
    speaker: string,
    confidence: number,
    evidence: SpeakerEvidence[] = []
): SpeakerScore[] {
    const anchor = scores.find((score) => sameName(score.speaker, speaker));
    const before = 1 - (anchor?.confidence ?? 0);
    const factor = before > 0 ? (1 - confidence) / before : 0;
    const others = scores
        .filter((score) => score !== anchor)
        .map((score) => ({ ...score, confidence: round(score.confidence * factor) }))
        .filter((score) => score.confidence > 0);
    const top: SpeakerScore = anchor
        ? { ...anchor, confidence: round(confidence), evidence: joined(anchor.evidence, evidence) }
        : { speaker, confidence: round(confidence), evidence };
    return [top, ...others].sort((a, b) => b.confidence - a.confidence);
}

/** A speaker range's typed candidate scores; entries that do not parse are left out, never guessed. */
export function speakerScoresOf(item: { kind: string; evidence?: Record<string, unknown> }): SpeakerScore[] {
    const typed = item.kind === "speaker-range" ? item.evidence?.candidateScores : undefined;

    if (!Array.isArray(typed)) {
        return [];
    }

    return typed.flatMap((one: unknown) => {
        const parsed = speakerScoreSchema.safeParse(one);
        return parsed.success ? [parsed.data] : [];
    });
}

/**
 * The confidence of each name over the ranges a speaker question decides: a range's scores with its current speaker
 * at the range's own confidence (a later answer may have changed both), and over several ranges the lowest, for a
 * name every range scores. Names no range scores are absent.
 */
export function speakerChoiceScores(
    ranges: Array<Extract<MeetingItem, { kind: "speaker-range" }>>
): Map<string, number> {
    const perRange = ranges.map((range) => {
        const scores = speakerScoresOf(range);
        return range.speaker && range.confidence !== undefined && scores.length > 0
            ? anchorScores(scores, range.speaker, range.confidence)
            : scores;
    });
    const result = new Map<string, number>();

    if (perRange.length === 0 || perRange.some((scores) => scores.length === 0)) {
        return result;
    }

    for (const score of perRange[0]!) {
        const values = perRange.map((scores) => scores.find((one) => sameName(one.speaker, score.speaker))?.confidence);

        if (values.every((value) => value !== undefined)) {
            result.set(score.speaker, Math.min(...(values as number[])));
        }
    }

    return result;
}
