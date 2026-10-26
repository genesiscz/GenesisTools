import type { NativeHistoryEntry } from "@genesiscz/utils/agent-sessions/types";
import { isWrapperUserText } from "@genesiscz/utils/agent-sessions/user-text";

/**
 * Answers to `❓ DECISION N` that the user typed in the chat instead of the hub. The decision Stop hook reads the
 * session through its provider (`NativeSessionReader.readBackward`, back to the oldest open ask), and this finds, per
 * open decision, what the user's messages AFTER that decision was asked say about it. Pure text: no transcript format.
 *
 * An answer is unambiguous only in a form nobody types by accident, at the start of a line or after a `,` or `;`:
 * `D14 b)`, `14 b)`, `14 b`, `DECISION 14: b`, `D14 b - because…`, `D14: my own words`; or a bare `b)` opening a
 * message right after a reply that asked exactly one decision. Two different answers, a letter the decision does not
 * have, or `D14` named without an option is ambiguous: the hook names those for the agent to record or leave.
 */

/** An open decision as the finder needs it. */
export interface OpenDecisionRef {
    number: number;
    /** The option letters it offers, `a` to `c` for three options; none for a free-text decision. */
    letters: readonly string[];
    /**
     * When it was asked (its post, or its latest revision): only user entries at or after it count. Entries without
     * a time (Grok's chat history) count from the first assistant entry that shows `❓ DECISION N` instead.
     */
    askedAt?: string;
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
    ambiguous: AmbiguousAnswer[];
}

interface Found {
    option?: string;
    answer: string;
    invalid: boolean;
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

function asksIn(text: string): number[] {
    return [...answerLines(text).join("\n").matchAll(ASK)].map((match) => Number(match[1]));
}

function found(letters: string, rest: string, allowed: readonly string[]): Found {
    const option = [...new Set(letters.toLowerCase())].join("");

    return {
        option,
        answer: rest.replace(LEAD, "").trim(),
        invalid: [...option].some((letter) => !allowed.includes(letter)),
    };
}

/** What one segment of a user line says about decision `n` (digits only, so it goes into the patterns as it is). */
function answerIn(segment: string, n: number, allowed: readonly string[]): Found | undefined {
    const head = `^\\s*(?:[-*]\\s+)?`;
    // `D14 b)`, `14 b)`, `DECISION 14 - (b)`, `D14 ac)`: the letters close with `)`.
    const closed = new RegExp(`${head}(?:D|DECISION\\s*)?#?${n}\\s*[:.)\\-–—]?\\s*\\(?([a-z]{1,4})\\)(.*)$`, "i").exec(
        segment
    );

    if (closed) {
        return found(closed[1] ?? "", closed[2] ?? "", allowed);
    }

    // `D14 b`, `DECISION 14: b - because`: a single letter after the D prefix, not the start of a word.
    const prefixed = new RegExp(`${head}(?:D|DECISION\\s*)#?${n}\\s*[:.\\-–—]?\\s*([a-z])(?![a-z])(.*)$`, "i").exec(
        segment
    );

    if (prefixed) {
        return found(prefixed[1] ?? "", prefixed[2] ?? "", allowed);
    }

    // `14 b` alone on its line or segment.
    const bare = new RegExp(`${head}#?${n}\\s*[:.\\-–—]?\\s*([a-z]{1,4})\\s*$`, "i").exec(segment);

    if (bare) {
        return found(bare[1] ?? "", "", allowed);
    }

    // `D14: my own words`.
    const own = new RegExp(`${head}D(?:ECISION)?\\s*#?${n}\\s*:\\s*(.+)$`, "i").exec(segment);

    return own?.[1] ? { answer: own[1].trim(), invalid: false } : undefined;
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
    const unambiguous: ChatAnswer[] = [];
    const ambiguous: AmbiguousAnswer[] = [];

    for (const decision of open) {
        const askedAt = time(decision.askedAt);
        const firstAsk = entries.findIndex(
            (entry) => entry.role === "assistant" && asksIn(entry.text).includes(decision.number)
        );
        const hits: { found: Found; evidence: Evidence }[] = [];
        let mentioned: Evidence | undefined;
        // The decisions the newest assistant entry that asked any asked: a bare `b)` answers one asked alone.
        let lastAsked: number[] = [];

        for (const [index, entry] of entries.entries()) {
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

            if (!afterAsk(entry, index, askedAt, firstAsk)) {
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
                    const hit = answerIn(segment, decision.number, decision.letters);

                    if (hit) {
                        hits.push({ found: hit, evidence: evidence(segment) });
                        answered = true;
                    }
                }
            }

            const first = lines.find((line) => line.trim() !== "") ?? "";
            const bare = /^\s*\(?([a-z]{1,4})\)(.*)$/i.exec(first);

            if (!answered && bare && alone && !/DECISION/.test(text)) {
                hits.push({ found: found(bare[1] ?? "", bare[2] ?? "", decision.letters), evidence: evidence(first) });
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

        if (hits.some((hit) => hit.found.invalid)) {
            ambiguous.push({ number: decision.number, reason: "unknown option", evidence: last.evidence });
            continue;
        }

        if (new Set(hits.map((hit) => hit.found.option ?? `words:${hit.found.answer}`)).size > 1) {
            ambiguous.push({ number: decision.number, reason: "several answers", evidence: last.evidence });
            continue;
        }

        unambiguous.push({
            number: decision.number,
            ...(last.found.option ? { option: last.found.option } : {}),
            answer: last.found.answer,
            evidence: last.evidence,
        });
    }

    return { unambiguous, ambiguous };
}
