import { join } from "node:path";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { json2md } from "@genesiscz/utils/json2md";
import { isTestProcess } from "@genesiscz/utils/test-process";
import {
    boundContext,
    cleanBlock,
    isFooterLine,
    isHeadingLine,
    isNoteLine,
    recommendedLetterIn,
    stripRecommendation,
} from "./reply-text";
import { DECISION_STATES } from "./schema";
import {
    type DecisionKind,
    type DecisionRecord,
    type DecisionState,
    type HarvestedDecision,
    kindOf,
    moveDecisions,
    readDecisions,
    restoreUndelivered,
} from "./store";

/** Session id of the harness posting this process, or null for a human CLI and for tests. */
export function currentHarnessSession(): string | null {
    if (isTestProcess()) {
        return null;
    }

    const poster = gatherHarnessPoster();

    if (poster.agent === "unknown" || !poster.sessionId) {
        return null;
    }

    return poster.sessionId;
}

export function decisionFiles(root = join(env.tools.getHome(), ".genesis-tools", "question", "decisions")): {
    file: string;
    events: string;
} {
    return { file: join(root, "decisions.jsonl"), events: join(root, "events.jsonl") };
}

export interface DecisionSessionView {
    sessionId: string;
    provider: string | null;
    title: string | null;
    cwd: string | null;
    cmuxSurface: string | null;
    waiting: number;
    oldestAgeMs: number | null;
    decisions: Array<DecisionRecord & { type: DecisionKind; status: string; ageMs: number }>;
}

const STATUS: Record<DecisionState, string> = {
    open: "waiting",
    drafted: "drafted",
    answered: "answered",
    sent: "sent",
    acknowledged: "acknowledged",
    implemented: "implemented",
    dismissed: "dismissed",
};

/** Every status `listSessions` matches: the names it prints, then the stored state names (`open`). */
export const DECISION_STATUSES: readonly string[] = [...new Set([...Object.values(STATUS), ...DECISION_STATES])];

export interface ListSessionsOptions {
    now?: number;
    /** Status names (`waiting`) or stored states (`open`), mixed freely. */
    status?: string[];
    type?: DecisionKind;
}

export function listSessions(rows: DecisionRecord[], options: ListSessionsOptions = {}): DecisionSessionView[] {
    const now = options.now ?? Date.now();
    const wanted = options.status && options.status.length > 0 ? new Set(options.status) : null;
    const groups = new Map<string, DecisionRecord[]>();

    for (const row of rows) {
        const name = STATUS[row.state];

        if (wanted && !wanted.has(name) && !wanted.has(row.state)) {
            continue;
        }

        if (options.type && kindOf(row) !== options.type) {
            continue;
        }

        const group = groups.get(row.sessionId) ?? [];
        group.push(row);
        groups.set(row.sessionId, group);
    }

    return [...groups.entries()].map(([sessionId, decisions]) => {
        const first = decisions[0];
        const waiting = decisions.filter((row) => row.state === "open" || row.state === "drafted");
        const oldest = waiting.map((row) => Date.parse(row.createdTs ?? row.updatedTs)).filter(Number.isFinite);

        return {
            sessionId,
            provider: first?.provider ?? null,
            title: first?.sessionTitle ?? null,
            cwd: first?.cwd ?? null,
            cmuxSurface: first?.cmuxSurface ?? null,
            waiting: waiting.length,
            oldestAgeMs: oldest.length === 0 ? null : now - Math.min(...oldest),
            decisions: decisions.map((row) => ({
                ...row,
                type: kindOf(row),
                status: STATUS[row.state],
                ageMs: Math.max(0, now - Date.parse(row.updatedTs)),
            })),
        };
    });
}

/**
 * The answers of one session: decisions that carry an answer or a chosen option. A state past
 * `open` is not enough, since a `drafted` decision has a draft and no answer yet. The CLI and the
 * MCP tools both read through this, so the doors cannot disagree.
 */
export function sessionAnswers(rows: DecisionRecord[], session: string): DecisionRecord[] {
    return rows.filter((row) => row.sessionId === session && hasAnswer(row));
}

function hasAnswer(row: DecisionRecord): boolean {
    return (row.answer?.trim().length ?? 0) > 0 || Boolean(row.option);
}

function letter(index: number): string {
    return String.fromCharCode(97 + index);
}

/** The chat rendering of posted items: the ❓ DECISION or TODO section the agent pastes. */
export function decisionsMarkdown(rows: DecisionRecord[]): string {
    return json2md(
        rows.flatMap((row) => {
            const todo = kindOf(row) === "todo";
            const heading = `${todo ? "☐ TODO" : "❓ DECISION"} ${row.number}${row.title ? ` — ${row.title}` : ""}`;
            const meta = [
                row.for ? `for: ${row.for}` : null,
                row.blocking ? "blocking" : null,
                row.reevaluateWhen ? `reevaluate when: ${row.reevaluateWhen}` : null,
            ].filter((part): part is string => part !== null);

            return [
                { h3: heading },
                { p: row.prompt },
                ...(meta.length > 0 ? [{ p: meta.join(" · ") }] : []),
                ...(row.proposal ? [{ p: `Proposal: ${row.proposal}` }] : []),
                ...(row.options.length > 0
                    ? [
                          {
                              ul: row.options.map(
                                  (option, index) =>
                                      `${letter(index)}) ${option}${row.recommended === letter(index) ? " (recommended)" : ""}`
                              ),
                          },
                      ]
                    : []),
            ];
        })
    );
}

/** Throws before calling `send` when nothing is answered and unsent. */
export function deliverDecisions(
    rows: DecisionRecord[],
    send: (text: string) => void
): { text: string; numbers: number[] } {
    const due = rows.filter((row) => row.state === "answered" && hasAnswer(row));

    if (due.length === 0) {
        throw new Error("nothing to send");
    }

    const text = decisionLines(due);
    send(text);
    return { text, numbers: due.map((row) => row.number) };
}

/** The letters of a pick, in order, each once: "ca" and "a,c" both read as ["a", "c"]. */
export function optionLetters(option: string | undefined | null): string[] {
    return [...new Set((option ?? "").toLowerCase().replace(/[^a-z]/g, ""))].sort();
}

/**
 * `DECISION 4: b) keep the cache`. Built from stored fields only: the option letters, then the
 * answer text, or the options' own labels when the answer was a bare pick. Two letters read
 * `DECISION 4: a) c) note`.
 */
export function decisionLine(row: DecisionRecord): string {
    const letters = optionLetters(row.option);
    const labels = letters.map((letter) => row.options[letter.charCodeAt(0) - 97]).filter(Boolean);
    const text = row.answer?.trim() || labels.join(" / ");
    const picks = letters.map((letter) => `${letter}) `).join("");

    return `DECISION ${row.number}: ${picks}${text}`.trimEnd();
}

function decisionLines(rows: DecisionRecord[]): string {
    return rows.map(decisionLine).join("\n");
}

export interface SentDecisions {
    text: string;
    numbers: number[];
}

/**
 * Delivers a session's answered decisions: the batch is marked `sent` in ONE store transition
 * FIRST, and only then handed to `emit`. Marking row by row after emitting let a crash leave
 * delivered answers still `answered`, and the next send delivered them again. Both the CLI and
 * the MCP door send through this. Throws "nothing to send" before any change when none is due.
 * An `emit` that throws puts the batch back to `answered`; one that returns normally delivered it.
 */
export async function sendSessionDecisions({
    file,
    events,
    session,
    emit,
}: {
    file: string;
    events: string;
    session: string;
    /**
     * Returns (or resolves) when delivered; throws (or rejects) when not. Its value is ignored.
     * `numbers` are the decisions in `text`, for a caller that frames the message.
     */
    emit: (text: string, numbers: number[]) => unknown;
}): Promise<SentDecisions> {
    const rows = readDecisions(file).filter((row) => row.sessionId === session && kindOf(row) === "decision");
    const due = deliverDecisions(rows, () => undefined);
    const ids = rows.filter((row) => due.numbers.includes(row.number)).map((row) => row.id);
    // The text comes from the rows as they stood UNDER the lock, not from the read above: an
    // answer edited in between would otherwise be marked sent while the old one was delivered.
    const moved = await moveDecisions(file, events, ids, "sent");
    const sent = { text: decisionLines(moved), numbers: moved.map((row) => row.number) };

    try {
        await emit(sent.text, sent.numbers);
    } catch (error) {
        // Nobody received these answers: put them back, so the next send delivers them.
        await restoreUndelivered(file, events, ids);
        throw error;
    }

    return sent;
}

export interface StopHookConfig {
    stopHook: "off" | "warn" | "block";
    maxBlocksPerSession: number;
    blocksUsed?: number;
}

const DECISION_MARKER = /❓\s*\**\s*DECISION\s+(\d+)/g;

/** The `❓ DECISION N` numbers a reply mentions, in order, each once. */
export function mentionedDecisions(reply: string): number[] {
    return [...new Set([...reply.matchAll(DECISION_MARKER)].map((match) => Number(match[1])))];
}

export function stopHookVerdict(
    config: StopHookConfig,
    reply: string,
    postedNumbers: number[]
): { action: "off" | "warn" | "block" | "allow"; reason?: string; missing?: number[] } {
    if (config.stopHook === "off") {
        return { action: "off" };
    }

    const missing = mentionedDecisions(reply).filter((number) => !postedNumbers.includes(number));

    if (missing.length === 0) {
        return { action: "allow" };
    }

    const reason =
        `Your reply asks ❓ DECISION ${missing.join(", ")} without posting ${missing.length === 1 ? "it" : "them"}. ` +
        'Call question_post with items of type "decision" (prompt, options, and the rest you wrote), ' +
        "then paste the markdown it returns instead of the hand-written section.";

    if (config.stopHook === "warn" || (config.blocksUsed ?? 0) >= config.maxBlocksPerSession) {
        return { action: "warn", reason, missing };
    }

    return { action: "block", reason, missing };
}

const OPTION_LINE = /^\s*(?:[-*]\s*)?\**([a-z])\)\**\s*(.+)$/;
const MARKER_LINE = /❓\s*\**\s*DECISION\s+(\d+)\**\s*(?:[—–:-]+\s*(.*))?$/;
/** The reply text kept as one decision's context; the whole reply stays readable in the transcript. */
const CONTEXT_MAX = 16_000;

interface OpenBlock {
    number: number;
    title?: string;
    prompt: string[];
    options: string[];
    rationales: (string | null)[];
    recommended: string | null;
    notes: string[];
    /** True once a line ended the block: later lines belong to the reply, not to it. */
    closed: boolean;
    start: number;
    end: number;
}

function letterAt(index: number): string {
    return String.fromCharCode(97 + index);
}

function finish(block: OpenBlock, context: string): HarvestedDecision {
    const prompt = cleanBlock(block.prompt);
    const notes = cleanBlock(block.notes);
    const recommended = block.recommended ?? (notes ? recommendedLetterIn(notes) : null);
    const rationales = block.rationales.map((text) => text?.trim() || null);

    return {
        number: block.number,
        prompt: prompt || block.title || `DECISION ${block.number}`,
        options: block.options,
        ...(block.title ? { title: block.title } : {}),
        ...(rationales.some((text) => text !== null) ? { rationales } : {}),
        ...(recommended && recommended.charCodeAt(0) - 97 < block.options.length ? { recommended } : {}),
        ...(notes ? { notes } : {}),
        ...(context ? { context: boundContext(context, CONTEXT_MAX) } : {}),
    };
}

/**
 * The `❓ DECISION N` blocks of a reply, for the harvest safety net and the inbox. A block runs from
 * its marker line to the next marker or the end. The marker line's tail after a dash or colon is
 * the title and the question; lines before the first option are the prompt body. Lines shaped
 * like `a) text` (bulleted or bold) are its options; an indented line under an option is that
 * option's rationale. "(recommended)" or "(My recommendation, because …)" inside a label marks the
 * option and keeps the reason. Under the options, lines that still talk about the decision (a
 * recommendation, the why, a trade-off) are its notes; a heading or any other unindented line
 * ends the block. Footers (a graft tally, "STE100 is on.") never become a prompt or a note.
 *
 * `context` is the reply text that leads to the block: the whole preamble for the first block,
 * the lines between the previous block and this one for the rest.
 */
export function parseDecisionBlocks(reply: string): HarvestedDecision[] {
    const lines = reply.split("\n");
    const blocks: OpenBlock[] = [];
    let current: OpenBlock | null = null;
    /** The first line after the previous block that was not consumed by it. */
    let leadStart = 0;
    const leads: string[] = [];

    for (const [index, line] of lines.entries()) {
        const marker = MARKER_LINE.exec(line);

        if (marker) {
            leads.push(cleanBlock(lines.slice(leadStart, index)));
            const title = marker[2]?.replace(/\*+/g, "").trim();
            current = {
                number: Number(marker[1]),
                ...(title ? { title } : {}),
                prompt: [],
                options: [],
                rationales: [],
                recommended: null,
                notes: [],
                closed: false,
                start: index,
                end: index,
            };
            blocks.push(current);
            leadStart = index + 1;
            continue;
        }

        if (!current || current.closed) {
            continue;
        }

        if (isFooterLine(line)) {
            continue;
        }

        const option = OPTION_LINE.exec(line);

        if (option?.[2]) {
            const mark = stripRecommendation(option[2].replace(/\*+/g, "").trim());
            current.options.push(mark.label);
            current.rationales.push(mark.rationale);

            if (mark.recommended) {
                current.recommended = letterAt(current.options.length - 1);
            }

            current.end = index;
            leadStart = index + 1;
            continue;
        }

        if (current.options.length === 0) {
            if (isHeadingLine(line)) {
                current.closed = true;
                continue;
            }

            current.prompt.push(line);
            current.end = index;
            leadStart = index + 1;
            continue;
        }

        const trimmed = line.trim();

        if (trimmed.length === 0) {
            // A blank line inside the notes keeps the paragraph; one right after the options waits.
            if (current.notes.length > 0) {
                current.notes.push(line);
            }

            continue;
        }

        const indented = /^\s/.test(line);
        const lastNote = current.notes.at(-1);
        const continuesNote = lastNote !== undefined && lastNote.trim().length > 0;

        if (indented && current.notes.length === 0) {
            // Under an option: its rationale ("  - because the token lives only in .npmrc").
            const last = current.options.length - 1;
            const text = trimmed.replace(/^[-*]\s*/, "").replace(/\*+/g, "");
            const mark = stripRecommendation(text);
            current.rationales[last] = [current.rationales[last], mark.label].filter(Boolean).join(" ");

            if (mark.recommended || /\brecommend/i.test(text)) {
                current.recommended = letterAt(last);
            }

            current.end = index;
            leadStart = index + 1;
            continue;
        }

        if (!isHeadingLine(line) && (indented || continuesNote || isNoteLine(line))) {
            current.notes.push(line);
            current.end = index;
            leadStart = index + 1;
            continue;
        }

        // A heading, a ⏳ PENDING list, a recap: the next part of the reply, not this decision.
        current.closed = true;
    }

    return blocks.map((block, index) => finish(block, leads[index] ?? ""));
}

export interface StalenessConfig {
    warnAfterMinutes: number;
    alarmAfterMinutes: number;
}

export interface StaleCrossing {
    id: string;
    threshold: "warn" | "alarm";
    ageMinutes: number;
    row: DecisionRecord;
}

/**
 * Blocking decisions still waiting past a threshold that has not been notified yet. Each
 * threshold fires once per decision (`notified` remembers it), and only the highest one crossed
 * is reported, so a decision found at 3 hours raises the alarm without a stale warning first.
 */
export function staleCrossings(rows: DecisionRecord[], config: StalenessConfig, now = Date.now()): StaleCrossing[] {
    const crossings: StaleCrossing[] = [];

    for (const row of rows) {
        if (kindOf(row) !== "decision" || !row.blocking || (row.state !== "open" && row.state !== "drafted")) {
            continue;
        }

        const started = Date.parse(row.createdTs ?? row.updatedTs);

        if (!Number.isFinite(started)) {
            continue;
        }

        const ageMinutes = Math.floor((now - started) / 60_000);
        const threshold =
            ageMinutes >= config.alarmAfterMinutes ? "alarm" : ageMinutes >= config.warnAfterMinutes ? "warn" : null;

        if (
            !threshold ||
            row.notified?.includes(threshold) ||
            (threshold === "warn" && row.notified?.includes("alarm"))
        ) {
            continue;
        }

        crossings.push({ id: row.id, threshold, ageMinutes, row });
    }

    return crossings;
}

export function loadSessions(file: string, options: ListSessionsOptions = {}): DecisionSessionView[] {
    return listSessions(readDecisions(file), options);
}
