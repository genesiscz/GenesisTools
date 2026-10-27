import { join } from "node:path";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { routerLink } from "@genesiscz/utils/browser-router/router-link";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { json2md } from "@genesiscz/utils/json2md";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { isTestProcess } from "@genesiscz/utils/test-process";
import { DeliveryUnknownError, NotDeliveredError } from "./deliver";
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
    awaitsDelivery,
    type DecisionKind,
    type DecisionRecord,
    type DecisionState,
    type HarvestedDecision,
    kindOf,
    moveDecisions,
    promptReserved,
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

export function decisionFiles(root = genesisToolsDir("question", "decisions")): {
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
    superseded: "superseded",
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

/**
 * A link that scrolls the live Claude session to where this decision was first asked, so a later
 * short re-ask can point back at its context. Null outside Claude and where the router cannot serve it.
 */
function findLink(row: DecisionRecord): string | null {
    if ((row.provider ?? "claude") !== "claude") {
        return null;
    }

    return routerLink({
        preset: "claude-find",
        action: "decision",
        data: { session: row.sessionId, decision: row.number },
        render: ({ link }) => `[show in chat](${link})`,
        fallback: () => null,
    }).result;
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
                (row.revision ?? 1) > 1
                    ? `revision ${row.revision} (earlier text: ${toolCommand("question show")} ${row.id} --versions)`
                    : null,
                todo ? null : findLink(row),
                row.state === "superseded"
                    ? `superseded${row.supersededBy ? ` by ${row.supersededBy}` : ""}${row.comments?.length ? `: ${row.comments.at(-1)}` : ""}`
                    : null,
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
                                      `${letter(index)}) ${optionLabel(option, letter(index))}${row.recommended === letter(index) ? " (recommended)" : ""}`
                              ),
                          },
                      ]
                    : []),
            ];
        })
    );
}

/** Throws before calling `send` when nothing is answered and unsent. */
/** The rows a send delivers: answered, with an answer, and not reserved by a queue or an in-flight sidebar prompt. */
export function dueDecisions(rows: DecisionRecord[]): DecisionRecord[] {
    return rows.filter(
        (row) => row.state === "answered" && !row.delivery?.queueId && !promptReserved(row) && hasAnswer(row)
    );
}

export function deliverDecisions(
    rows: DecisionRecord[],
    send: (text: string) => void
): { text: string; numbers: number[] } {
    const due = dueDecisions(rows);

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
 * An option's label without the letter the agent wrote in front of it ("b) build it first" is "build it first"), so
 * the line's own pick prefix does not repeat it: "b) b) build it first" reached a session on 2026-10-26.
 */
function optionLabel(label: string, letter: string): string {
    const prefix = new RegExp(`^\\(?${letter}[).:](?:\\s+|$)`, "i");
    return label.replace(prefix, "");
}

function ledgerRef(number: number, id: string): string {
    return `Ledger decision ${number} (${id})`;
}

/** The first lines of a message that answers an inbox item: what it answers, then which item that is. */
function replyToLines({ title, ref }: { title: string; ref: string }): string[] {
    return [`Reply to: ${title.trim()}`, ref];
}

/** The inbox item a widget follow-up answers: what the user looked at when they wrote it. */
export interface ReplyTarget {
    id: string;
    kind: string;
    title?: string;
    /** The start of the item's text, for an item with no title. */
    excerpt?: string;
    /** A decision's number, so its line names it as a decision answer does. */
    number?: number;
}

/** A follow-up's "Reply to:" lines, in the decision answer's form; none when the item has neither title nor text. */
export function replyTargetLines(target: ReplyTarget): string[] {
    const title = target.title?.trim() || target.excerpt?.trim();
    if (!title) {
        return [];
    }

    const ref =
        target.kind === "decision" && target.number
            ? ledgerRef(target.number, target.id)
            : `Inbox ${target.kind} (${target.id})`;
    return replyToLines({ title, ref });
}

/** Preserves the card title and ledger identity before the user's literal answer or option labels. */
export function decisionLine(row: DecisionRecord): string {
    const letters = optionLetters(row.option);
    const labels = letters
        .map((letter) => {
            const label = row.options[letter.charCodeAt(0) - 97];
            return label ? optionLabel(label, letter) : undefined;
        })
        .filter(Boolean);
    const text = row.answer?.trim() || labels.join(" / ");
    const picks = letters.map((letter) => `${letter}) `).join("");

    const answer = `${picks}${text}`.trimEnd();
    if (row.title?.trim()) {
        return [...replyToLines({ title: row.title, ref: ledgerRef(row.number, row.id) }), answer].join("\n");
    }

    return `DECISION ${row.number}: ${answer}`.trimEnd();
}

export function decisionLines(rows: DecisionRecord[]): string {
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
    ids: selectedIds,
    emit,
}: {
    file: string;
    events: string;
    session: string;
    ids?: readonly string[];
    /**
     * Returns (or resolves) when delivered; throws (or rejects) when not. Its value is ignored.
     * `numbers` are the decisions in `text`, for a caller that frames the message.
     */
    emit: (text: string, numbers: number[]) => unknown;
}): Promise<SentDecisions> {
    const selected = selectedIds ? new Set(selectedIds) : undefined;
    // Without ids: only the answers waiting to go out, never a chat answer an agent recorded as `answered`.
    const rows = readDecisions(file).filter(
        (row) =>
            row.sessionId === session &&
            kindOf(row) === "decision" &&
            (selected ? selected.has(row.id) : awaitsDelivery(row))
    );
    const due = deliverDecisions(rows, () => undefined);
    const ids = rows.filter((row) => due.numbers.includes(row.number)).map((row) => row.id);
    // The text comes from the rows as they stood UNDER the lock, not from the read above: an
    // answer edited in between would otherwise be marked sent while the old one was delivered.
    const moved = await moveDecisions(file, events, ids, "sent");
    const sent = { text: decisionLines(moved), numbers: moved.map((row) => row.number) };

    try {
        await emit(sent.text, sent.numbers);
    } catch (error) {
        if (!(error instanceof DeliveryUnknownError)) {
            const queued = error instanceof NotDeliveredError && error.result.queueId ? error.result : undefined;
            await restoreUndelivered({
                file,
                events,
                ids,
                ...(queued ? { delivery: { route: "queued", queueId: queued.queueId, error: queued.error } } : {}),
            });
        }
        throw error;
    }

    return sent;
}

export interface StopHookConfig {
    stopHook: "off" | "warn" | "block";
    maxBlocksPerSession: number;
    blocksUsed?: number;
}

/** `❓ DECISION 21`, `❓ **DECISION 21**`, and the linked form a later mention uses, `❓ [DECISION 21](…)`. */
const DECISION_MARKER = /❓\s*\**\s*\[?\s*\**\s*DECISION\s+(\d+)/g;

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

/**
 * What makes a question a decision for the user: one of these whole words in any case, or ❓.
 * "decided" and "chose" are left out on purpose, because they report a choice already made.
 */
const DECISION_CUE = /\b(?:decisions?|decide|choose)\b|❓/i;
/** A sentence that ends in "?": the mark before a space, a closing bracket, quote or emphasis, or the line end. */
const QUESTION_END = /\?(?=[\s)\]"'*_]|$)/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const QUOTED_LINE = /^\s*>/;
const INLINE_CODE = /`[^`\n]*`/g;
/** Text in quotation marks: a dialog's own question or a tab name the reply quotes, not the reply asking. */
const QUOTED_TEXT = /"[^"\n]*"|“[^”\n]*”/g;
const QUESTION_LINE_MAX = 200;

/** A decision named any way a reply names one: `DECISION 21`, `D21`, or a link to `…/decision/21`. */
const DECISION_REF = /\bDECISION\s*#?(\d+)\b|\bD(\d+)\b|\/decision\/(\d+)\b/g;
/** How many prose lines above a question still belong to it (a `❓ DECISION N — title` line, then the question). */
const QUESTION_LEAD_LINES = 3;

/** The reply's own prose, line by line: fenced code blocks, `>` quoted lines and inline code are left out. */
function proseLines(reply: string): string[] {
    const lines: string[] = [];
    let fence: string | null = null;

    for (const line of reply.split("\n")) {
        const marker = FENCE.exec(line)?.[1];

        if (fence) {
            if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
                fence = null;
            }

            continue;
        }

        if (marker) {
            fence = marker;
            continue;
        }

        if (!QUOTED_LINE.test(line)) {
            lines.push(line.replace(INLINE_CODE, ""));
        }
    }

    return lines;
}

/**
 * The line of a reply that asks the user to decide, or null. The prose (see `proseLines`) must hold a decision cue
 * (`DECISION_CUE`) and a sentence that ends in "?", both outside quotation marks: a reply that quotes a dialog's
 * "Discard 0:21 of recording?" and names the "Decisions" tab asks nothing (2026-10-23). The line returned is the first
 * question that carries the cue, else the first question.
 */
export function decisionQuestion(reply: string): string | null {
    const found = questionLine(reply);

    if (!found) {
        return null;
    }

    const trimmed = found.lines[found.index]?.trim() ?? "";

    return trimmed.length > QUESTION_LINE_MAX ? `${trimmed.slice(0, QUESTION_LINE_MAX - 1)}…` : trimmed;
}

/**
 * The decision numbers the reply's question names (`decisionQuestion`): on its line, or on the lines just above it in
 * the same paragraph. The question nudge checks them against the decision log, so a question about a decision posted
 * in an earlier turn is known as logged.
 */
export function decisionQuestionRefs(reply: string): number[] {
    const found = questionLine(reply);

    if (!found) {
        return [];
    }

    const near: string[] = [];

    for (let index = found.index; index >= 0 && index >= found.index - QUESTION_LEAD_LINES; index--) {
        const line = found.lines[index] ?? "";

        if (index < found.index && !line.trim()) {
            break;
        }

        near.push(line);
    }

    const numbers = [...near.join("\n").matchAll(DECISION_REF)].map((match) =>
        Number(match[1] ?? match[2] ?? match[3])
    );

    return [...new Set(numbers)];
}

/** The prose lines of a reply and the index of the line that asks the user to decide, or null. */
function questionLine(reply: string): { lines: string[]; index: number } | null {
    const lines = proseLines(reply);
    const own = (line: string) => line.replace(QUOTED_TEXT, "");

    if (!lines.some((line) => DECISION_CUE.test(own(line)))) {
        return null;
    }

    const asks = (line: string) => QUESTION_END.test(own(line));
    const cued = lines.findIndex((line) => asks(line) && DECISION_CUE.test(own(line)));
    const index = cued >= 0 ? cued : lines.findIndex(asks);

    return index >= 0 ? { lines, index } : null;
}

export interface QuestionNudgeConfig {
    questionNudge: "off" | "warn" | "block";
    maxBlocksPerSession: number;
    blocksUsed?: number;
}

/**
 * The question nudge for a reply whose `question` asks the user to decide (`decisionQuestion`). `loggedThisTurn`:
 * the session posted a decision after the turn's prompt, or the question names a decision already in the session's
 * log, from any turn (`decisionQuestionRefs`). Past `maxBlocksPerSession` blocks it only warns.
 */
export function questionNudgeVerdict(
    config: QuestionNudgeConfig,
    question: string,
    loggedThisTurn: boolean
): { action: "off" | "warn" | "block" | "allow"; reason?: string } {
    if (config.questionNudge === "off") {
        return { action: "off" };
    }

    if (loggedThisTurn) {
        return { action: "allow" };
    }

    const reason =
        `Your reply asks the user to decide ("${question}"), but this session logged no decision ` +
        "this turn, so it does not reach the user's widget inbox. If it is a decision for the user, post it with " +
        'question_post as an item of type "decision" (pass `number` when your reply numbers it) and keep working. ' +
        "If it is not a decision for the user, say so in one line and stop.";

    if (config.questionNudge === "warn" || (config.blocksUsed ?? 0) >= config.maxBlocksPerSession) {
        return { action: "warn", reason };
    }

    return { action: "block", reason };
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
