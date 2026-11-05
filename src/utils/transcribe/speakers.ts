import type { Participant, TranscriptEntry } from "./types";

export function speakerLabel(participants: Participant[], speakerId: number | undefined): string {
    const named = participants.find((p) => p.speakerId === speakerId);

    if (named) {
        return named.name;
    }

    return speakerId === undefined ? "Unknown" : `Speaker ${speakerId}`;
}

export function firstName(name: string): string {
    return name.split(/\s+/)[0] ?? name;
}

/** A pause shorter than this between two turns of one label keeps them in one span. */
export const DEFAULT_SPAN_GAP_SEC = 120;
/** Spoken time of a line is the time to the next line, but no more than this per word (a silence is not speech). */
const MAX_SEC_PER_WORD = 0.8;
/** A line with no next line, or no time, counts this much per word. */
const SEC_PER_WORD = 0.4;
/** A label with this many turns at most and this much speech, next to another label, may be a split voice. */
const LONE_MAX_TURNS = 1;
const LONE_MAX_SEC = 10;
/** A label with several spans and at least this share of the speech may be several people. */
const SEVERAL_MIN_SHARE = 0.25;
/** Speech under the same label this long after a leave phrase is someone else (or the person came back). */
const LEAVE_CONTINUES_AFTER_SEC = 30;
/** A cut-off line and the next one count as one sentence when the next starts within this many seconds. */
const JOIN_WITHIN_SEC = 1.5;

/** A pattern that matches only as whole words. JavaScript's `\b` treats "í" or "ž" as a word edge, so it cannot. */
function wholeWords(pattern: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Phrases a person says when they leave the call. Czech and English, matched case-insensitively anywhere in a line.
 * A label that keeps speaking after one of them holds more than one voice (rules R1 and R5 of the meetings skill).
 */
export const LEAVE_PHRASES: readonly RegExp[] = [
    "mějte se",
    "mizím",
    "(?:já )?už musím",
    "musím (?:jít|běžet|letět|končit|se odpojit)",
    "budu muset (?:jít|končit|běžet)",
    "měla? .{0,30}jít",
    "(?:já )?končím",
    "loučím se",
    "na shledanou",
    "bye|goodbye|see you",
    "(?:i have to|i need to|gotta) (?:go|drop|leave|run)",
    "musím odejít",
    "musím na (?:další )?(?:call|schůzku|meeting|poradu)",
    "mám (?:další )?(?:call|schůzku|meeting)",
    "odpojuju se|odpojím se",
    "odcházím|zdrhám|padám|zmizím",
    "zatím (?:čau|ahoj)",
    // Slovak.
    "musím (?:ísť|bežať|končiť)",
    "idem (?:preč|už)",
    "majte sa|maj sa|lúčim sa|dovidenia",
    "i'll drop|i'm dropping|dropping off|i'm off|(?:i have to )?hop off",
].map(wholeWords);

/**
 * A bare greeting ("čau", "tak ahoj", "čaute"). It is a goodbye only when it ends the label's run and another label
 * answers it; otherwise it is someone arriving ("Čau." at 00:21).
 */
/**
 * What a person says when they arrive in a call (rule R16): a greeting, or a newcomer's question. Czech, Slovak and
 * English, as whole words.
 */
export const ARRIVAL_PHRASES: readonly RegExp[] = [
    "čus|čau|ahoj|ahojte|zdravím|zdravíčko|dobrý den|dobrý den všem|nazdar",
    "o co jsem (?:přišel|přišla)|co jsem (?:zmeškal|zmeškala|propásl)",
    "slyšíte mě|slyšíš mě|je mě slyšet|jde mě slyšet|počujete ma",
    "hi|hello|hey all|hi all|can you hear me|what did i miss",
].map(wholeWords);

const CLOSING_GREETING = wholeWords("(?:tak |zatím )?(?:čau|ahoj|čaute)");
/** Rule R13: another label answers a departure with one of these within `FAREWELL_REPLY_WITHIN_SEC`. */
const FAREWELL_REPLY = wholeWords("čau|ahoj|čaute|měj(?:te)? se|maj(?:te)? sa|nic se neděje|díky|dík|bye|see you");
const FAREWELL_REPLY_WITHIN_SEC = 15;
/** Rule R14: "taky" in a leave phrase right after another label's leave phrase is a second person leaving. */
const ECHO = wholeWords("taky|také|i já|já taky|tiež|aj ja|me too");
const ECHO_WITHIN_SEC = 15;

function isLeavePhrase(text: string): boolean {
    return LEAVE_PHRASES.some((phrase) => phrase.test(text));
}

/**
 * One person's time in the call, on the transcript clock (seconds from the start of the recording). From a meeting
 * platform's attendance (Teams), so it is evidence, not a guess. A person who rejoined has one entry per stay.
 */
export interface Presence {
    name: string;
    /** The recording user; a platform may name them by email only. */
    self?: boolean;
    /** False when the join was only observed after it happened. Missing means legacy exact attendance. */
    joinedAtExact?: boolean;
    leftAtExact?: boolean;
    fromSec: number;
    toSec: number;
}

/** Who is in the call over one stretch: one section per interval between two join or leave times. */
export interface PresenceSection {
    fromSec: number;
    toSec: number;
    present: string[];
}

/**
 * Sections from the stays: a new section starts at every join and every leave, so a person who leaves and comes back
 * is present in the sections of both stays. An open stay (still in the call) ends at the last known time.
 */
export function presenceSections(presence: Presence[]): PresenceSection[] {
    const finite = presence.map((stay) => ({ ...stay, toSec: Number.isFinite(stay.toSec) ? stay.toSec : Number.NaN }));
    const lastKnown = Math.max(
        ...finite.flatMap((stay) => [stay.fromSec, Number.isNaN(stay.toSec) ? stay.fromSec : stay.toSec])
    );
    const stays = finite.map((stay) => ({ ...stay, toSec: Number.isNaN(stay.toSec) ? lastKnown : stay.toSec }));
    const edges = [...new Set(stays.flatMap((stay) => [Math.max(0, stay.fromSec), stay.toSec]))].sort((a, b) => a - b);
    const sections: PresenceSection[] = [];

    for (let index = 1; index < edges.length; index += 1) {
        const fromSec = edges[index - 1]!;
        const toSec = edges[index]!;
        const middle = (fromSec + toSec) / 2;
        const present = [
            ...new Set(stays.filter((stay) => middle >= stay.fromSec && middle <= stay.toSec).map((stay) => stay.name)),
        ];
        sections.push({ fromSec, toSec, present });
    }

    return sections;
}

/** Rule RA: attendance times are exact to a few seconds; a line this close to a join or leave still counts. */
export const PRESENCE_TOLERANCE_SEC = 5;
/** Rule R15: an attendee silent under their own label this long is probably heard under other labels. */
export const LABEL_DRIFT_SEC = 15 * 60;
/** Lines of one label closer than this form one range in an attendance hint. */
const PRESENCE_RANGE_GAP_SEC = 60;

/** Who named a label: the meeting platform (evidence), a language model (a guess), the user, or nobody known. */
export type SpeakerOrigin = "platform" | "llm" | "self" | "unknown";

export interface SpeakerSpan {
    fromSec: number;
    toSec: number;
    turns: number;
}

/** A leave phrase under a label, and when the same label speaks again. */
export interface SpeakerLeave {
    atSec: number;
    text: string;
    continuesAtSec: number;
    /** R13: the label that answered with a farewell. Without one, the phrase may be only an intention to leave. */
    confirmedBy?: string;
    /** R14: the other label's leave phrase this one echoes ("já taky"), so the speaker here is not that person. */
    echoOf?: { label: string; atSec: number };
}

export interface SpeakerStat {
    label: string;
    speakerId?: number;
    origin: SpeakerOrigin;
    turns: number;
    lines: number;
    words: number;
    /** Estimated seconds of speech; 0 when the transcript has no times. */
    spokenSec: number;
    firstSec?: number;
    lastSec?: number;
    spans: SpeakerSpan[];
    /** Leave phrases followed by more speech under this label: a boundary between two voices. */
    leaves: SpeakerLeave[];
}

/**
 * How much a hint is worth (rule R0): a label the platform named is evidence, so a hint against it is weak; a label a
 * language model guessed is a hypothesis, so a hint against it is strong.
 */
export type HintStrength = "weak" | "normal" | "strong";

/** Two lines that are one sentence cut by diarization: the last word of one and the first word of the next. */
export interface SplitJoin {
    atSec: number;
    left: string;
    right: string;
    joined: string;
}

/** Consecutive lines that break an attendance rule. */
export interface PresenceRange {
    fromSec: number;
    toSec: number;
    lines: number;
    /**
     * Who was in the call during the range: the candidates for whose voice it is. A range ends where someone joins
     * or leaves, so the list holds for the whole range. Set on `absent-speaker` ranges.
     */
    present?: string[];
}

export type SpeakerHint =
    /** R15: a person in the call whose own label stayed silent this long: their voice is under other labels. */
    | { kind: "label-drift"; label: string; strength: HintStrength; person: string; fromSec: number; toSec: number }
    /** RA: the label speaks while that person was not in the call. */
    | { kind: "absent-speaker"; label: string; strength: HintStrength; ranges: PresenceRange[] }
    /** RA: only one person was in the call, so the voice is that person, whatever the label says. */
    | {
          kind: "sole-attendee";
          label: string;
          strength: HintStrength;
          person: string;
          /** The person is the recording user. */
          self: boolean;
          ranges: PresenceRange[];
      }
    | { kind: "several-people"; label: string; strength: HintStrength; spans: number; share: number }
    | { kind: "leave-then-continues"; label: string; strength: HintStrength; leaves: SpeakerLeave[] }
    | {
          kind: "split-voice";
          label: string;
          strength: HintStrength;
          neighbour: string;
          turns: number;
          spokenSec: number;
          atSec?: number;
          join?: SplitJoin;
      };

export interface SpeakerStats {
    /** False when no line has a time: then only counts are known. */
    timed: boolean;
    speakers: SpeakerStat[];
    hints: SpeakerHint[];
}

function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

function originOf(origin: string | undefined, isSelf: boolean | undefined): SpeakerOrigin {
    if (isSelf || origin === "self") {
        return "self";
    }

    return origin === "platform" || origin === "llm" ? origin : "unknown";
}

function strengthFor(origin: SpeakerOrigin): HintStrength {
    if (origin === "llm") {
        return "strong";
    }

    return origin === "platform" || origin === "self" ? "weak" : "normal";
}

/** The word cut between two lines: the first ends without punctuation, the next starts in lower case. */
function splitJoin(
    first: TranscriptEntry,
    firstEnd: number | undefined,
    next: TranscriptEntry | undefined
): SplitJoin | undefined {
    if (!next || firstEnd === undefined || next.startSec === undefined || next.startSec - firstEnd > JOIN_WITHIN_SEC) {
        return undefined;
    }

    const left = first.text.trim().split(/\s+/).at(-1) ?? "";
    const right = next.text.trim().split(/\s+/)[0] ?? "";

    if (!left || !right || /[.!?…,;:]$/.test(left) || !/^\p{Ll}/u.test(right)) {
        return undefined;
    }

    const cleanRight = right.replace(/[.!?…,;:]+$/, "");
    return { atSec: next.startSec, left, right: cleanRight, joined: `${left}${cleanRight}` };
}

interface TurnRun {
    label: string;
    lines: number[];
    fromSec?: number;
    toSec?: number;
}

/**
 * Per label: turns, lines, words, estimated speech, the spans the label speaks in, and the leave phrases it keeps
 * talking after. The hints point a person at what to check: a label that is probably several people, a label that
 * speaks on after saying goodbye, and a lone one-turn label that is probably a voice cut off from its neighbour.
 * `participants` give each label its origin (who named it), which sets how strong a hint is.
 */
export function speakerStats(
    entries: TranscriptEntry[],
    options: { gapSec?: number; participants?: Participant[]; presence?: Presence[] } = {}
): SpeakerStats {
    const gapSec = options.gapSec ?? DEFAULT_SPAN_GAP_SEC;
    const participants = options.participants ?? [];
    const lines = entries.filter((entry) => entry.text.trim());
    const timed = lines.some((entry) => entry.startSec !== undefined);
    const spoken = lines.map((entry, index) => {
        const words = wordCount(entry.text);
        const next = lines[index + 1]?.startSec;

        if (entry.startSec === undefined || !timed) {
            return 0;
        }

        if (next === undefined || next <= entry.startSec) {
            return words * SEC_PER_WORD;
        }

        return Math.min(next - entry.startSec, words * MAX_SEC_PER_WORD);
    });
    const endOf = (index: number): number | undefined => {
        const start = lines[index]?.startSec;
        return start === undefined ? undefined : start + spoken[index]!;
    };

    const runs: TurnRun[] = [];

    lines.forEach((entry, index) => {
        const run = runs.at(-1);

        if (!run || run.label !== entry.speaker) {
            runs.push({ label: entry.speaker, lines: [index], fromSec: entry.startSec, toSec: endOf(index) });
            return;
        }

        run.lines.push(index);
        run.fromSec ??= entry.startSec;
        run.toSec = endOf(index) ?? run.toSec;
    });

    const runEnds = new Set(runs.map((run) => run.lines.at(-1)!));
    const byLabel = new Map<string, SpeakerStat>();

    lines.forEach((entry, index) => {
        let stat = byLabel.get(entry.speaker);

        if (!stat) {
            const person = participants.find((p) => p.speakerId !== undefined && p.speakerId === entry.speakerId);
            stat = {
                label: entry.speaker,
                speakerId: entry.speakerId,
                origin: originOf(person?.origin, person?.isSelf),
                turns: 0,
                lines: 0,
                words: 0,
                spokenSec: 0,
                spans: [],
                leaves: [],
            };
            byLabel.set(entry.speaker, stat);
        }

        stat.lines += 1;
        stat.words += wordCount(entry.text);
        stat.spokenSec += spoken[index]!;

        if (entry.startSec !== undefined) {
            stat.firstSec ??= entry.startSec;
            stat.lastSec = endOf(index);
        }

        if (entry.startSec === undefined) {
            return;
        }

        const leftAt = entry.startSec;
        const reply = lines.find(
            (other) =>
                other.speaker !== entry.speaker &&
                other.startSec !== undefined &&
                other.startSec > leftAt &&
                other.startSec - leftAt <= FAREWELL_REPLY_WITHIN_SEC &&
                (FAREWELL_REPLY.test(other.text) || CLOSING_GREETING.test(other.text))
        );
        // A "čau" that answers another label's goodbye is a reply, not this label leaving.
        const answers = lines.some(
            (other) =>
                other.speaker !== entry.speaker &&
                other.startSec !== undefined &&
                other.startSec <= leftAt &&
                leftAt - other.startSec <= FAREWELL_REPLY_WITHIN_SEC &&
                isLeavePhrase(other.text)
        );
        const greetingGoodbye =
            runEnds.has(index) && CLOSING_GREETING.test(entry.text) && reply !== undefined && !answers;

        if (!isLeavePhrase(entry.text) && !greetingGoodbye) {
            return;
        }

        const later = lines.find(
            (other, otherIndex) =>
                otherIndex > index &&
                other.speaker === entry.speaker &&
                other.startSec !== undefined &&
                other.startSec - leftAt >= LEAVE_CONTINUES_AFTER_SEC
        );

        if (later?.startSec === undefined) {
            return;
        }

        const echoed = ECHO.test(entry.text)
            ? lines
                  .slice(0, index)
                  .findLast(
                      (other) =>
                          other.speaker !== entry.speaker &&
                          other.startSec !== undefined &&
                          leftAt - other.startSec <= ECHO_WITHIN_SEC &&
                          isLeavePhrase(other.text)
                  )
            : undefined;
        stat.leaves.push({
            atSec: leftAt,
            text: entry.text.trim(),
            continuesAtSec: later.startSec,
            ...(reply ? { confirmedBy: reply.speaker } : {}),
            ...(echoed?.startSec !== undefined ? { echoOf: { label: echoed.speaker, atSec: echoed.startSec } } : {}),
        });
    });

    for (const run of runs) {
        const stat = byLabel.get(run.label)!;
        stat.turns += 1;

        if (run.fromSec === undefined || run.toSec === undefined) {
            continue;
        }

        const span = stat.spans.at(-1);

        if (span && run.fromSec - span.toSec < gapSec) {
            span.toSec = run.toSec;
            span.turns += 1;
        } else {
            stat.spans.push({ fromSec: run.fromSec, toSec: run.toSec, turns: 1 });
        }
    }

    const speakers = [...byLabel.values()];
    const totalSpoken = speakers.reduce((sum, stat) => sum + stat.spokenSec, 0);
    const hints: SpeakerHint[] = [];

    for (const stat of speakers) {
        const strength = strengthFor(stat.origin);

        if (stat.leaves.length > 0) {
            // R13: a goodbye nobody answered is probably only an intention to leave.
            const confirmed = stat.leaves.some((leave) => leave.confirmedBy || leave.echoOf);
            hints.push({
                kind: "leave-then-continues",
                label: stat.label,
                strength: confirmed ? strength : "weak",
                leaves: stat.leaves,
            });
        }

        const share = totalSpoken > 0 ? stat.spokenSec / totalSpoken : 0;

        if (timed && stat.spans.length >= 2 && share >= SEVERAL_MIN_SHARE) {
            hints.push({ kind: "several-people", label: stat.label, strength, spans: stat.spans.length, share });
        }
    }

    for (const stat of speakers) {
        if (speakers.length < 2 || stat.turns > LONE_MAX_TURNS || (timed && stat.spokenSec > LONE_MAX_SEC)) {
            continue;
        }

        const runIndex = runs.findIndex((run) => run.label === stat.label);
        const run = runs[runIndex]!;
        const nextRun = runs[runIndex + 1];
        const neighbour = nextRun?.label ?? runs[runIndex - 1]?.label;

        if (!neighbour) {
            continue;
        }

        const lastLine = run.lines.at(-1)!;
        const join = nextRun ? splitJoin(lines[lastLine]!, endOf(lastLine), lines[nextRun.lines[0]!]) : undefined;
        hints.push({
            kind: "split-voice",
            label: stat.label,
            strength: join ? "strong" : "normal",
            neighbour,
            turns: stat.turns,
            spokenSec: stat.spokenSec,
            atSec: stat.firstSec,
            ...(join ? { join } : {}),
        });
    }

    if (timed && options.presence && options.presence.length > 0) {
        hints.unshift(...presenceHints(lines, speakers, options.presence));
    }

    return { timed, speakers, hints };
}

/** Lower case, no diacritics, no "(company)" suffix, as a set of words. */
function nameWords(name: string): Set<string> {
    const plain = name
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/\([^)]*\)/g, " ")
        .toLowerCase();
    return new Set(plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** "Bob Example" is "Example Bob (QT)": every word of the shorter name is in the longer one, and it has two words at least. */
export function sameName(a: string, b: string): boolean {
    const [short, long] = [nameWords(a), nameWords(b)].sort((x, y) => x.size - y.size);
    return (
        short!.size > 0 &&
        (short!.size >= 2 || short!.size === long!.size) &&
        [...short!].every((word) => long!.has(word))
    );
}

function presentAt(presence: Presence[], sec: number): Presence[] {
    return presence.filter(
        (stay) => sec >= stay.fromSec - PRESENCE_TOLERANCE_SEC && sec <= stay.toSec + PRESENCE_TOLERANCE_SEC
    );
}

/** Close times form one range; with `presence`, a range also ends where the set of people in the call changes. */
function toRanges(times: number[], presence?: Presence[]): PresenceRange[] {
    const ranges: PresenceRange[] = [];
    const poolAt = (sec: number) => [...new Set(presentAt(presence ?? [], sec).map((stay) => stay.name))].sort();

    for (const sec of times) {
        const last = ranges.at(-1);
        const present = presence ? poolAt(sec) : undefined;
        const samePool = present === undefined || last?.present?.join("\n") === present.join("\n");

        if (last && sec - last.toSec < PRESENCE_RANGE_GAP_SEC && samePool) {
            last.toSec = sec;
            last.lines += 1;
        } else {
            ranges.push({ fromSec: sec, toSec: sec, lines: 1, ...(present ? { present } : {}) });
        }
    }

    return ranges;
}

/**
 * Rule RA, before every content rule: a label cannot speak while its person is out of the call, and when only one
 * person is in the call, every voice is that person.
 */
/** R15: stretches of at least `LABEL_DRIFT_SEC` inside a person's stay with no line under a label of their name. */
function driftHints(lines: TranscriptEntry[], presence: Presence[]): SpeakerHint[] {
    const hints: SpeakerHint[] = [];

    for (const stay of presence) {
        if (stay.self || !Number.isFinite(stay.toSec)) {
            continue;
        }

        const own = lines
            .filter((line) => line.startSec !== undefined && sameName(line.speaker, stay.name))
            .map((line) => line.startSec!)
            .filter((sec) => sec >= stay.fromSec && sec <= stay.toSec);
        const edges = [stay.fromSec, ...own, stay.toSec];

        for (let index = 1; index < edges.length; index += 1) {
            const fromSec = edges[index - 1]!;
            const toSec = edges[index]!;

            if (toSec - fromSec >= LABEL_DRIFT_SEC) {
                hints.push({
                    kind: "label-drift",
                    label: stay.name,
                    strength: "normal",
                    person: stay.name,
                    fromSec,
                    toSec,
                });
            }
        }
    }

    return hints;
}

function presenceHints(lines: TranscriptEntry[], speakers: SpeakerStat[], presence: Presence[]): SpeakerHint[] {
    const hints: SpeakerHint[] = driftHints(lines, presence);
    const people = new Set(presence.map((stay) => stay.name));

    for (const stat of speakers) {
        const stays = presence.filter(
            (stay) => sameName(stat.label, stay.name) || (stay.self === true && stat.origin === "self")
        );
        const timesOf = (keep: (sec: number) => boolean) =>
            lines
                .filter((line) => line.speaker === stat.label && line.startSec !== undefined && keep(line.startSec))
                .map((line) => line.startSec!);

        if (stays.length > 0) {
            const absent = timesOf((sec) => presentAt(stays, sec).length === 0);

            if (absent.length > 0) {
                hints.push({
                    kind: "absent-speaker",
                    label: stat.label,
                    strength: "strong",
                    ranges: toRanges(absent, presence),
                });
            }
        }

        const byPerson = new Map<string, number[]>();

        for (const sec of timesOf(() => true)) {
            const here = new Set(presentAt(presence, sec).map((stay) => stay.name));

            if (here.size !== 1 || people.size < 2) {
                continue;
            }

            const person = [...here][0]!;
            const stay = presence.find((candidate) => candidate.name === person)!;

            if (stays.includes(stay)) {
                continue;
            }

            byPerson.set(person, [...(byPerson.get(person) ?? []), sec]);
        }

        for (const [person, times] of byPerson) {
            hints.push({
                kind: "sole-attendee",
                label: stat.label,
                strength: "strong",
                person,
                self: presence.some((stay) => stay.name === person && stay.self === true),
                ranges: toRanges(times),
            });
        }
    }

    return hints;
}
