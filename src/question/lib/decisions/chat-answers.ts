import type { NativeHistoryEntry } from "@genesiscz/utils/agent-sessions/types";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";

/**
 * Answers to `❓ DECISION N` that the user typed in the chat instead of the hub. The decision Stop hook reads the
 * session through its provider (`NativeSessionReader.readBackward`, back to the oldest open ask), and this finds, per
 * open decision, what the user's messages AFTER that decision was asked say about it. Pure text: no transcript format.
 *
 * An answer is unambiguous only in a form nobody types by accident, at the start of a line or after a `,` or `;`:
 * `D14 b)`, `14 b)`, `14 b`, `DECISION 14: b`, `D14 b - because…`, `D14: my own words`; or a bare `b)` opening a
 * message right after a reply that asked exactly one decision. Letters closed one by one (`D14: a) b)`) are one set.
 * Two different answers, a letter the decision does not have, or `D14` named without an option is ambiguous: the hook
 * names those for the agent to record or leave. An answer that rules a letter out (`D14: a) b) not e)`) is clear, but
 * its words say more than its letters, so it goes to `forAgent`: no reader records it, the agent does.
 */

/** An open decision as the finder needs it. */
export interface OpenDecisionRef {
    number: number;
    /** Defaults to the original revision. Revised asks require timestamped evidence to locate their boundary. */
    revision?: number;
    /** The option letters it offers, `a` to `c` for three options; none for a free-text decision. */
    letters: readonly string[];
    /**
     * It takes any set of its letters (`takesSeveral`). Otherwise an answer names one letter, and a run of letters
     * ("add", "bad") is a word.
     */
    several?: boolean;
    /**
     * When it was asked (its post, or its latest revision): only user entries at or after it count. Entries without
     * a time (Grok's chat history) count from the first assistant entry that shows `❓ DECISION N` only for the original
     * revision. Revised decisions without timestamped evidence remain open for explicit recording.
     */
    askedAt?: string;
    /**
     * Asked before the first entry given (the Stop hook's read from where it last stopped): every user entry comes
     * after its ask, also in history without timestamps where the ask itself is not among the entries.
     */
    askedBefore?: boolean;
}

export interface Evidence {
    text: string;
    /** Where it is in the read; a backward read counts back from the end of the file (-1 is the last line). */
    line: number;
    timestamp?: string;
}

export interface ChatAnswer {
    number: number;
    /** The letters picked, in order (`"b"`, `"ac"`); absent for an answer in own words only. */
    option?: string;
    /** The letters the user ruled out (`not e)`), in the order typed. Such an answer is in `forAgent`. */
    excluded?: string;
    /** The user's words after the letters, or the whole own-words answer. */
    answer: string;
    evidence: Evidence;
}

export interface AmbiguousAnswer {
    number: number;
    reason: "several answers" | "unknown option" | "mentioned without an option";
    evidence: Evidence;
}

export interface ChatAnswers {
    unambiguous: ChatAnswer[];
    /**
     * Clear answers that rule a letter out (`D14: a) b) not e)`). The words carry more than the letters, so no reader
     * records them: the agent records each with question_update and its reading, and the Stop hook only reminds it.
     */
    forAgent: ChatAnswer[];
    ambiguous: AmbiguousAnswer[];
}

interface Found {
    option?: string;
    excluded?: string;
    answer: string;
    /** Why this answer cannot be recorded as it is: a letter the decision does not have, or two answers in one. */
    problem?: AmbiguousAnswer["reason"];
}

/** The text of a `❓ DECISION N` ask, as the reply format and the harvest write it. */
const ASK = /❓\s*\**\s*DECISION\s+(\d+)\b/g;
/** A compaction or continuation summary is the harness's text about the past, not the user answering now. */
const SUMMARY = /^This session is being continued from a previous conversation/;
/** An attached image's own entry (`[Image: source: /var/…/clipboard-….png]`): an attachment, not the user's words. */
const IMAGE_ONLY = /^\[Image(?: #\d+)?: source: [^\]\n]*\]$/;
/** Where a second answer starts on the same line: `D14 b, D15 a` or `14 b); 15 a)`. */
const NEXT_ANSWER = /\s*[,;]\s*(?=(?:D|DECISION\s*)?#?\d+\s*[:.)\-–—]?\s*\(?[a-z]{1,4}\b)/i;
const LEAD = /^\s*[-–—:,]\s*/;
/**
 * The letters of an answer: one (`b`), a run (`ac`, `abcdef`), or single letters with separators (`a, c`, `a+c`,
 * `a c`, `a and c`, `a, b and f`), as a decision that takes a set of letters is answered. `lettersOf` refuses a run
 * that does not rise and a letter named twice, so a word ("bad", "add") is never read as letters.
 */
const LETTER_SET = String.raw`[a-z]{1,26}(?:(?:\s*[,+&/]\s*|\s+and\s+|\s+)[a-z](?![a-z]))*`;
/** One more letter closed with `)` after a closed pick: the `b)` of `a) b)`, `a), b)`, `a) and (b)`. */
const PICK = /^\s*(?:[,+&/]|and\b)?\s*\(?([a-z])\)/i;
/**
 * Letters the user rules out: `not e)`, `not (e)`, `except d) or e)`, or `not e` that ends a clause. A letter must be
 * closed with `)` or end the clause, so "not a good idea" rules nothing out.
 */
const RULED_OUT =
    /\b(?:not|no|except|without)\s+(\(?[a-z]\)(?:\s*(?:[,/]|\b(?:or|nor|and)\b)\s*\(?[a-z]\))*|\(?[a-z](?=\s*(?:[,;.]|$)))/gi;

/**
 * The letters a `LETTER_SET` match names, or undefined when it is a word rather than letters. The rule of
 * `replyLetters` in act.ts: every run rises and no letter repeats. A decision that takes one letter takes one only.
 */
function lettersOf(set: string, several: boolean): string | undefined {
    const runs = set
        .toLowerCase()
        .replace(/\s+and\s+/g, " ")
        .split(/[^a-z]+/)
        .filter(Boolean);
    const named = runs.join("");
    const rises = (run: string) => [...run].every((char, index) => index === 0 || char > (run[index - 1] ?? ""));

    if (!runs.every(rises) || new Set(named).size !== named.length || (!several && named.length !== 1)) {
        return undefined;
    }

    return named;
}

function asksIn(text: string): number[] {
    return [...new Set([...answerLines(text).join("\n").matchAll(ASK)].map((match) => Number(match[1])))];
}

type Choice = Pick<OpenDecisionRef, "letters" | "several">;

/** The letters `text` rules out, each once, in the order typed. A decision with no letters has none to rule out. */
function ruledOut(text: string, decision: Choice): string {
    if (decision.letters.length === 0) {
        return "";
    }

    const letters = [...text.matchAll(RULED_OUT)].flatMap((match) => [
        ...(match[1] ?? "")
            .toLowerCase()
            .replace(/\b(?:or|nor|and)\b/g, " ")
            .replace(/[^a-z]/g, ""),
    ]);

    return [...new Set(letters)].join("");
}

/** A letter the decision does not offer, or a letter both picked and ruled out. */
function problemOf(option: string, excluded: string, decision: Choice): Pick<Found, "problem"> {
    if ([...option, ...excluded].some((letter) => !decision.letters.includes(letter))) {
        return { problem: "unknown option" };
    }

    return [...excluded].some((letter) => option.includes(letter)) ? { problem: "several answers" } : {};
}

/** An answer in own words, with the letters it rules out. */
function words(answer: string, decision: Choice): Found {
    const excluded = ruledOut(answer, decision);

    return { ...(excluded ? { excluded } : {}), answer, ...problemOf("", excluded, decision) };
}

function found(letters: string, rest: string, decision: Choice): Found | undefined {
    const option = lettersOf(letters, decision.several === true);

    if (option === undefined) {
        return undefined;
    }

    const answer = rest.replace(LEAD, "").trim();
    const excluded = ruledOut(answer, decision);

    return { option, ...(excluded ? { excluded } : {}), answer, ...problemOf(option, excluded, decision) };
}

/** Letters closed with `)`, and the closed letters after them (`a) b) not e)`): one set, then the words. */
function closedFound(letters: string, rest: string, decision: Choice): Found | undefined {
    const more: string[] = [];
    let left = rest;

    for (let pick = PICK.exec(left); pick; pick = PICK.exec(left)) {
        more.push(pick[1] ?? "");
        left = left.slice(pick[0].length);
    }

    if (more.length > 0 && decision.several !== true) {
        // `a) b)` on a decision that takes one letter names two answers; a word before them ("bad)") names none.
        return lettersOf(letters, false) === undefined
            ? undefined
            : { answer: left.replace(LEAD, "").trim(), problem: "several answers" };
    }

    return found([letters, ...more].join(" "), left, decision);
}

/** What one segment of a user line says about decision `n` (digits only, so it goes into the patterns as it is). */
function answerIn(segment: string, n: number, decision: Choice): Found | undefined {
    const head = `^\\s*(?:[-*]\\s+)?`;
    // `D14 b)`, `14 b)`, `DECISION 14 - (b)`, `D14 ac)`, `14 (a, c)`: the letters close with `)`.
    const closed = new RegExp(
        `${head}(?:D|DECISION\\s*)?#?${n}\\s*[:.)\\-–—]?\\s*\\(?(${LETTER_SET})\\)(.*)$`,
        "i"
    ).exec(segment);

    if (closed) {
        return closedFound(closed[1] ?? "", closed[2] ?? "", decision);
    }

    // A colon introduces own words, except an option alone or followed by an explicit explanation separator.
    const own = new RegExp(`${head}D(?:ECISION)?\\s*#?${n}\\s*:\\s*(.+)$`, "i").exec(segment);

    if (own?.[1]) {
        const answer = own[1].trim();
        const choice = new RegExp(`^(${LETTER_SET})(?:\\s*[-–—:]\\s*(.*))?$`, "i").exec(answer);
        const letters =
            choice && decision.letters.length > 0 ? found(choice[1] ?? "", choice[2] ?? "", decision) : undefined;
        const option = letters?.option ?? "";
        const separated = /[^a-z]/i.test((choice?.[1] ?? "").trim());

        // Own words that only look like letters ("D14: ok") stay words: a set must name the decision's letters. One
        // letter past the options ("D14: z") is still a letter, so it reads as an unknown option, and so are letters
        // written apart ("D14: a, z"): no word is spelled that way.
        return letters &&
            ([...option].every((letter) => decision.letters.includes(letter)) || option.length === 1 || separated)
            ? letters
            : words(answer, decision);
    }

    // `D14 b`, `D14 b - because`, `D14 a, c`: prose after the letters requires `)`, `-`, `–`, `—` or `:`.
    const prefixed = new RegExp(
        `${head}(?:D|DECISION\\s*)#?${n}\\s*[.\\-–—]?\\s*(${LETTER_SET})(?:\\s*[-–—:]\\s*(.*)|\\s*)$`,
        "i"
    ).exec(segment);

    if (prefixed) {
        return found(prefixed[1] ?? "", prefixed[2] ?? "", decision);
    }

    // `14 b`, `14 ac`, `14 a, c` alone on its line or segment.
    const bare = new RegExp(`${head}#?${n}\\s*[:.\\-–—]?\\s*(${LETTER_SET})\\s*$`, "i").exec(segment);

    if (bare) {
        return found(bare[1] ?? "", "", decision);
    }

    return undefined;
}

function mentions(text: string, n: number): boolean {
    return new RegExp(`\\bD(?:ECISION)?\\s*#?${n}\\b`, "i").test(text);
}

/** The user's own words: harness wrappers and summaries are not the user answering. */
export function userText(entry: NativeHistoryEntry): string | undefined {
    if (entry.role !== "user") {
        return undefined;
    }

    const text = entry.text.trim();

    if (!text || isWrapperUserText(text) || SUMMARY.test(text) || IMAGE_ONLY.test(text)) {
        return undefined;
    }

    return entry.text.trimEnd();
}

/** Only prose outside code and block quotes can be an instruction to record an answer. */
function answerLines(text: string): string[] {
    let fence: { marker: string; length: number } | undefined;

    return text.split("\n").map((line) => {
        if (/^\s*>/.test(line)) {
            return "";
        }

        const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);

        if (marker) {
            const run = marker[1] ?? "";

            if (!fence) {
                fence = { marker: run[0] ?? "", length: run.length };
            } else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]?.trim()) {
                fence = undefined;
            }

            return "";
        }

        return fence || /^(?: {4}|\t)/.test(line) ? "" : line.replace(/(`+)[\s\S]*?\1/g, "");
    });
}

function time(value: string | undefined): number | undefined {
    const parsed = value ? Date.parse(value) : Number.NaN;

    return Number.isNaN(parsed) ? undefined : parsed;
}

/** Whether `entry` comes after decision `n` was asked: by time when both have one, else after its first ask. */
function afterAsk(entry: NativeHistoryEntry, index: number, askedAt: number | undefined, firstAsk: number): boolean {
    const at = time(entry.timestamp);

    if (askedAt !== undefined && at !== undefined) {
        return at >= askedAt;
    }

    return firstAsk >= 0 && index > firstAsk;
}

/** Per open decision, what the user's messages after its ask say about it. `entries` are in conversation order. */
export function chatAnswers(entries: readonly NativeHistoryEntry[], open: readonly OpenDecisionRef[]): ChatAnswers {
    // A provider emits one entry per text block. Prose, fences and ask context belong to the whole message row.
    const messages: NativeHistoryEntry[] = [];

    for (const entry of entries) {
        if (entry.role !== "assistant" && entry.role !== "user") {
            continue;
        }

        const previous = messages.at(-1);

        if (previous?.role === entry.role && previous.line === entry.line && previous.timestamp === entry.timestamp) {
            messages[messages.length - 1] = { ...previous, text: `${previous.text}\n${entry.text}` };
        } else {
            messages.push(entry);
        }
    }

    const unambiguous: ChatAnswer[] = [];
    const forAgent: ChatAnswer[] = [];
    const ambiguous: AmbiguousAnswer[] = [];

    for (const decision of open) {
        const askedAt = time(decision.askedAt);
        const firstAsk = messages.findIndex(
            (entry) => entry.role === "assistant" && asksIn(entry.text).includes(decision.number)
        );
        const hits: { found: Found; evidence: Evidence }[] = [];
        let mentioned: Evidence | undefined;
        // The decisions the newest assistant entry that asked any asked: a bare `b)` answers one asked alone.
        let lastAsked: number[] = [];

        for (const [index, entry] of messages.entries()) {
            if (entry.role === "assistant") {
                const asked = asksIn(entry.text);
                lastAsked = asked;
                continue;
            }

            const text = userText(entry);

            if (!text) {
                continue;
            }

            const alone = lastAsked.length === 1 && lastAsked[0] === decision.number;
            lastAsked = [];

            // A repeated number cannot locate a revised ask in timestamp-free history. Leave it for explicit recording.
            const knownRevision =
                decision.askedBefore === true ||
                (decision.revision ?? 1) === 1 ||
                (askedAt !== undefined && time(entry.timestamp) !== undefined);

            if (!knownRevision || (!decision.askedBefore && !afterAsk(entry, index, askedAt, firstAsk))) {
                continue;
            }

            const evidence = (line: string): Evidence => ({
                text: line.trim(),
                line: entry.line,
                ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
            });
            const lines = answerLines(text);
            let answered = false;

            for (const line of lines) {
                for (const segment of line.split(NEXT_ANSWER)) {
                    const hit = answerIn(segment, decision.number, decision);

                    if (hit) {
                        hits.push({ found: hit, evidence: evidence(segment) });
                        answered = true;
                    }
                }
            }

            const first = lines.find((line) => line.trim() !== "") ?? "";
            // `b)`, `ac)`, `(a, c)` alone answer the one decision the last reply asked.
            const bare = new RegExp(`^\\s*\\(?(${LETTER_SET})\\)(.*)$`, "i").exec(first);
            const bareHit =
                bare && alone && !/DECISION/.test(text)
                    ? closedFound(bare[1] ?? "", bare[2] ?? "", decision)
                    : undefined;

            if (!answered && bareHit) {
                hits.push({ found: bareHit, evidence: evidence(first) });
                answered = true;
            }

            if (!answered && lines.some((line) => mentions(line, decision.number))) {
                mentioned = evidence(lines.find((line) => mentions(line, decision.number)) ?? first);
            }
        }

        const last = hits.at(-1);

        if (!last) {
            if (mentioned) {
                ambiguous.push({ number: decision.number, reason: "mentioned without an option", evidence: mentioned });
            }

            continue;
        }

        const problem = hits.find((hit) => hit.found.problem);

        if (problem?.found.problem) {
            ambiguous.push({ number: decision.number, reason: problem.found.problem, evidence: problem.evidence });
            continue;
        }

        if (new Set(hits.map((hit) => hit.found.option ?? `words:${hit.found.answer}`)).size > 1) {
            ambiguous.push({ number: decision.number, reason: "several answers", evidence: last.evidence });
            continue;
        }

        // Ruling a letter out says more than the letters: the agent records it with its reading of the words.
        (last.found.excluded ? forAgent : unambiguous).push({
            number: decision.number,
            ...(last.found.option ? { option: last.found.option } : {}),
            ...(last.found.excluded ? { excluded: last.found.excluded } : {}),
            answer: last.found.answer,
            evidence: last.evidence,
        });
    }

    return { unambiguous, forAgent, ambiguous };
}
