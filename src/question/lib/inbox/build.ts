import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { looksLikeDump, whySentence } from "../decisions/delivery-text";
import { parseDecisionBlocks } from "../decisions/read";
import { findRefs } from "../decisions/reply-text";
import { type DecisionDelivery, type DecisionRecord, type HarvestedDecision, kindOf } from "../decisions/store";
import type { AskForm } from "../pending/types";

/**
 * The "Waiting for you" inbox: every session whose last reply asks a ❓ DECISION, every open or
 * drafted decision in the store, and every pending question form, grouped by session. Pure: the
 * loader (load.ts) gathers the inputs, the hub renders the result, `drafts.ts` and `answer.ts`
 * write back.
 */

export type InboxStatus = "waiting" | "drafted" | "answered" | "sent" | "acknowledged" | "implemented" | "dismissed";

export interface InboxChoice {
    /** The option letter for a decision, the choice id for a form. */
    id: string;
    label: string;
    /** Why this option, when the reply says (a parenthetical, an indented line under it). */
    rationale: string | null;
    recommended: boolean;
}

export interface InboxRef {
    /** As written in the reply. */
    path: string;
    line: number | null;
    endLine: number | null;
    /** Resolved against the session's folder; null when no folder is known. */
    absolute: string | null;
    /** The real lines, read by the loader; null when the file could not be read. */
    excerpt: string | null;
    /** The 1-based line the excerpt starts at. */
    startLine: number | null;
    /** For syntax highlighting; null when the extension is unknown. */
    language: string | null;
    missing: boolean;
    /** Where the reference was found: the context, an option (`option:a`), or the posted refs. */
    from: string;
}

export interface InboxDecision {
    kind: "decision";
    id: string;
    number: number;
    title: string | null;
    prompt: string;
    choices: InboxChoice[];
    recommended: string | null;
    blocking: boolean;
    status: InboxStatus;
    /** The chosen letters once answered. */
    option: string | null;
    answer: string | null;
    /** `transcript`: read from the session's last reply only. `store`: a posted or harvested row. */
    source: "transcript" | "store";
    at: string;
    /** The reply text that leads to this decision (markdown): the findings for the first block, the lead-in for the rest. */
    context: string | null;
    /** Text under the options about this decision: a recommendation line, the why. */
    notes: string | null;
    /** What a posted decision adds: the agent's pick, its reasoning and confidence, the code it points at. */
    proposal: string | null;
    reasoning: string | null;
    confidence: "high" | "medium" | "low" | null;
    excerpt: string | null;
    refs: InboxRef[];
    /** The user's unsent pick (letters) and note. */
    draftOption: string | null;
    draft: string | null;
    /** Where the last send took the answer: cmux pane, codex worker, resume, or queued (with why). */
    delivery: InboxDeliveryView | null;
}

export interface InboxQuestion {
    itemId: string;
    prompt: string;
    choices: InboxChoice[];
    multiple: boolean;
    freeText: boolean;
    required: boolean;
}

export interface InboxForm {
    kind: "form";
    id: string;
    source: string | null;
    questions: InboxQuestion[];
    status: "waiting";
    at: string;
}

export type InboxItem = InboxDecision | InboxForm;

/** A delivery as the inbox shows it: the stored record, plus the raw dump an old row kept, behind `raw`. */
export type InboxDeliveryView = DecisionDelivery & { raw?: string };

/**
 * Rows stored before the rework put the raw cmux error in `target` of a queued delivery (a JSON dump
 * next to a green check, 2026-09-24). They are read through the same sentence rules as a live send:
 * `error` is one sentence, `target` is dropped (it was never a place), the dump goes behind `raw`.
 */
export function inboxDelivery(delivery: DecisionDelivery | undefined): InboxDeliveryView | null {
    if (!delivery) {
        return null;
    }

    if (delivery.route !== "queued" || delivery.error || !delivery.target) {
        return delivery;
    }

    const { target, ...rest } = delivery;
    return { ...rest, error: whySentence(target), ...(looksLikeDump(target) ? { raw: target } : {}) };
}

/** The last reply of a session, when its decisions come from the transcript. */
export interface InboxReply {
    at: string | null;
    /** The whole assistant message, markdown. */
    markdown: string;
    /** The user prompt that led to it: the first line, and the whole text. */
    ask: string | null;
    askFull: string | null;
    /** 0-based position of the reply in the transcript; null when not known. */
    turnIndex: number | null;
}

export interface InboxSession {
    /** Null for forms that no session posted. */
    sessionId: string | null;
    provider: string | null;
    title: string | null;
    project: string | null;
    cwd: string | null;
    branch: string | null;
    account: string | null;
    /** When the newest item was asked. */
    lastAt: string;
    /** Items still needing an answer (waiting or drafted). */
    waiting: number;
    /** Items with an unsent pick or note. */
    drafted: number;
    /** Answered decisions no send has delivered yet: they ride the session's next prompt. */
    queued: number;
    reply: InboxReply | null;
    items: InboxItem[];
}

/** The session fields the inbox shows; a subset of `AgentSessionRow`. */
export interface InboxSessionInfo {
    provider: string;
    sessionId: string;
    title: string | null;
    cwd: string;
    project: string | null;
    gitBranch?: string | null;
    account: string | null;
    mtime: number;
}

/** What the last reply of a session asks, when no user turn came after it. */
export interface TranscriptScan {
    at: string | null;
    blocks: HarvestedDecision[];
    reply?: InboxReply;
}

const MARKER = /❓\s*\**\s*DECISION\s+\d+/;
const ASK_LINE_MAX = 200;

function firstLine(text: string): string {
    const line = text
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    return line && line.length > ASK_LINE_MAX ? `${line.slice(0, ASK_LINE_MAX - 1)}…` : (line ?? "");
}

/**
 * The decisions the session is waiting on: the last text turn is the agent's, and it carries at
 * least one `❓ DECISION N` block. A user turn after it means the question was answered in chat.
 * `firstIndex` is the 0-based transcript position of `turns[0]`, so the reply's own index is known.
 */
export function scanTurns(turns: readonly TranscriptTurn[], firstIndex: number | null = null): TranscriptScan | null {
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];

        if (!turn || turn.role === "system" || turn.text.trim().length === 0) {
            continue;
        }

        if (turn.role === "user" || !MARKER.test(turn.text)) {
            return null;
        }

        const blocks = parseDecisionBlocks(turn.text);

        if (blocks.length === 0) {
            return null;
        }

        const asked = turns
            .slice(0, index)
            .reverse()
            .find((earlier) => earlier.role === "user" && earlier.text.trim().length > 0);

        return {
            at: turn.at,
            blocks,
            reply: {
                at: turn.at,
                markdown: turn.text,
                ask: asked ? firstLine(asked.text) : null,
                askFull: asked?.text.trim() ?? null,
                turnIndex: firstIndex === null ? null : firstIndex + index,
            },
        };
    }

    return null;
}

function letter(index: number): string {
    return String.fromCharCode(97 + index);
}

function choicesOf(
    options: readonly string[],
    rationales: readonly (string | null)[] | undefined,
    recommended: string | null
): InboxChoice[] {
    return options.map((label, index) => ({
        id: letter(index),
        label,
        rationale: rationales?.[index] ?? null,
        recommended: recommended === letter(index),
    }));
}

/** The references a decision's text names: its context, notes and options; each path once. */
function refsOf(
    parts: Array<{ text: string | null | undefined; from: string }>,
    posted: DecisionRecord["refs"] | undefined
): InboxRef[] {
    const refs: InboxRef[] = [];
    const seen = new Set<string>();
    const push = (ref: Omit<InboxRef, "absolute" | "excerpt" | "startLine" | "language" | "missing">) => {
        const key = `${ref.path}:${ref.line}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        refs.push({ ...ref, absolute: null, excerpt: null, startLine: null, language: null, missing: false });
    };

    for (const ref of posted ?? []) {
        push({ path: ref.path, line: ref.line ?? null, endLine: ref.endLine ?? null, from: "posted" });
    }

    for (const part of parts) {
        for (const ref of findRefs(part.text ?? "")) {
            push({ path: ref.path, line: ref.line, endLine: ref.endLine, from: part.from });
        }
    }

    return refs;
}

function optionParts(options: readonly string[], rationales?: readonly (string | null)[]) {
    return options.map((label, index) => ({
        text: [label, rationales?.[index]].filter(Boolean).join("\n"),
        from: `option:${letter(index)}`,
    }));
}

const STATUS: Record<DecisionRecord["state"], InboxStatus> = {
    open: "waiting",
    drafted: "drafted",
    answered: "answered",
    sent: "sent",
    acknowledged: "acknowledged",
    implemented: "implemented",
    dismissed: "dismissed",
};

function isOpen(status: InboxStatus): boolean {
    return status === "waiting" || status === "drafted";
}

function hasDraft(item: InboxDecision): boolean {
    return isOpen(item.status) && (Boolean(item.draftOption) || Boolean(item.draft?.trim()));
}

export function decisionItemId(sessionId: string, number: number): string {
    return `d_${number}_${sessionId}`;
}

function fromRecord(row: DecisionRecord): InboxDecision {
    return {
        kind: "decision",
        id: row.id,
        number: row.number,
        title: row.title ?? null,
        prompt: row.prompt,
        choices: choicesOf(row.options, row.rationales, row.recommended ?? null),
        recommended: row.recommended ?? null,
        blocking: row.blocking === true,
        status: STATUS[row.state],
        option: row.option ?? null,
        answer: row.answer ?? null,
        source: "store",
        at: row.createdTs ?? row.updatedTs,
        context: row.context ?? row.reasoning ?? null,
        notes: row.notes ?? null,
        proposal: row.proposal ?? null,
        reasoning: row.reasoning ?? null,
        confidence: row.confidence ?? null,
        excerpt: row.excerpt ?? null,
        refs: refsOf(
            [
                { text: row.context, from: "context" },
                { text: row.notes, from: "notes" },
                { text: row.reasoning, from: "reasoning" },
                { text: row.proposal, from: "proposal" },
                ...optionParts(row.options, row.rationales),
            ],
            row.refs
        ),
        draftOption: row.draftOption || null,
        draft: row.draft || null,
        delivery: inboxDelivery(row.delivery),
    };
}

function fromBlock(sessionId: string, block: HarvestedDecision, at: string): InboxDecision {
    return {
        kind: "decision",
        id: decisionItemId(sessionId, block.number),
        number: block.number,
        title: block.title ?? null,
        prompt: block.prompt,
        choices: choicesOf(block.options, block.rationales, block.recommended ?? null),
        recommended: block.recommended ?? null,
        blocking: false,
        status: "waiting",
        option: null,
        answer: null,
        source: "transcript",
        at,
        context: block.context ?? null,
        notes: block.notes ?? null,
        proposal: null,
        reasoning: null,
        confidence: null,
        excerpt: null,
        refs: refsOf(
            [
                { text: block.context, from: "context" },
                { text: block.notes, from: "notes" },
                ...optionParts(block.options, block.rationales),
            ],
            undefined
        ),
        draftOption: null,
        draft: null,
        delivery: null,
    };
}

/**
 * A stored row for a decision the transcript still shows, with the reply's text merged in: the
 * store keeps the answer state, the transcript keeps the freshest context. A harvested row of an
 * older parser has no context; the reply fills it.
 */
function merged(row: DecisionRecord, block: HarvestedDecision): InboxDecision {
    const item = fromRecord(row);
    const fresh = fromBlock(row.sessionId, block, item.at);

    return {
        ...item,
        context: item.context ?? fresh.context,
        notes: item.notes ?? fresh.notes,
        recommended: item.recommended ?? fresh.recommended,
        choices: item.choices.map((choice, index) => ({
            ...choice,
            rationale: choice.rationale ?? fresh.choices[index]?.rationale ?? null,
            recommended:
                choice.recommended || (item.recommended === null && fresh.choices[index]?.recommended === true),
        })),
        refs: item.refs.length > 0 ? item.refs : fresh.refs,
    };
}

function fromForm(form: AskForm): InboxForm {
    return {
        kind: "form",
        id: form.id,
        source: form.source ?? null,
        questions: form.items.map((item) => ({
            itemId: item.id,
            prompt: item.promptMarkdown,
            choices: (item.choices ?? []).map((choice) => ({
                id: choice.id,
                label: choice.label,
                rationale: null,
                recommended: false,
            })),
            multiple: item.allowMultiple === true,
            freeText: item.allowFreeText !== false,
            required: item.required !== false,
        })),
        status: "waiting",
        at: new Date(form.createdAt).toISOString(),
    };
}

export interface BuildInboxInput {
    sessions: readonly InboxSessionInfo[];
    /** Transcript scans by session id; a session without an entry asks nothing in its last reply. */
    scans: ReadonlyMap<string, TranscriptScan>;
    rows: readonly DecisionRecord[];
    forms: readonly AskForm[];
}

interface Group {
    sessionId: string | null;
    info: Partial<Omit<InboxSession, "items" | "waiting" | "drafted" | "queued" | "lastAt" | "reply">>;
    reply: InboxReply | null;
    items: InboxItem[];
}

/**
 * One entry per session with something waiting. A decision the store knows wins over the same
 * number read from the transcript (it carries the answer state). An answered or sent decision
 * stays listed only while the transcript still ends on it, so the row shows the delivery until
 * the agent replies. A dismissed decision is never listed. Sessions are ordered newest first; the
 * hub re-sorts on the user's choice.
 */
export function buildInbox({ sessions, scans, rows, forms }: BuildInboxInput): InboxSession[] {
    const known = new Map(sessions.map((session) => [session.sessionId, session]));
    const groups = new Map<string, Group>();

    const group = (key: string, sessionId: string | null): Group => {
        let found = groups.get(key);

        if (!found) {
            const info = sessionId ? known.get(sessionId) : undefined;
            found = {
                sessionId,
                info: info
                    ? {
                          provider: info.provider,
                          title: info.title,
                          project: info.project,
                          cwd: info.cwd || null,
                          branch: info.gitBranch ?? null,
                          account: info.account,
                      }
                    : {},
                reply: null,
                items: [],
            };
            groups.set(key, found);
        }

        return found;
    };

    const decisions = rows.filter((row) => kindOf(row) === "decision");
    const stored = new Map(decisions.map((row) => [decisionItemId(row.sessionId, row.number), row]));

    for (const [sessionId, scan] of scans) {
        const at = scan.at ?? new Date(known.get(sessionId)?.mtime ?? 0).toISOString();
        const target = group(sessionId, sessionId);
        target.reply = scan.reply ?? null;

        for (const block of scan.blocks) {
            const row = stored.get(decisionItemId(sessionId, block.number));

            if (row?.state === "dismissed") {
                continue;
            }

            target.items.push(row ? merged(row, block) : fromBlock(sessionId, block, at));
        }
    }

    for (const row of decisions) {
        const item = fromRecord(row);
        const target = group(row.sessionId, row.sessionId);

        if (!isOpen(item.status) || target.items.some((existing) => existing.id === item.id)) {
            continue;
        }

        target.items.push(item);
        target.info.provider ??= row.provider ?? null;
        target.info.title ??= row.sessionTitle ?? null;
        target.info.cwd ??= row.cwd ?? null;
        target.info.project ??= row.project ?? null;
        target.info.branch ??= row.branch ?? null;
    }

    for (const form of forms) {
        if (form.status !== "pending") {
            continue;
        }

        const sessionId = form.sessionHint ?? null;
        const target = group(sessionId ?? `form:${form.projectPath}`, sessionId);
        target.items.push(fromForm(form));
        target.info.cwd ??= form.cwd || form.projectPath;
        target.info.project ??= form.projectPath.split("/").filter(Boolean).pop() ?? null;
    }

    const result: InboxSession[] = [];

    for (const entry of groups.values()) {
        if (entry.items.length === 0) {
            continue;
        }

        entry.items.sort((a, b) => a.at.localeCompare(b.at));
        result.push({
            sessionId: entry.sessionId,
            provider: entry.info.provider ?? null,
            title: entry.info.title ?? null,
            project: entry.info.project ?? null,
            cwd: entry.info.cwd ?? null,
            branch: entry.info.branch ?? null,
            account: entry.info.account ?? null,
            lastAt: entry.items.reduce((latest, item) => (item.at > latest ? item.at : latest), ""),
            waiting: entry.items.filter((item) => item.kind === "form" || isOpen(item.status)).length,
            drafted: entry.items.filter((item) => item.kind === "decision" && hasDraft(item)).length,
            queued: entry.items.filter((item) => item.kind === "decision" && item.status === "answered").length,
            reply: entry.reply,
            items: entry.items,
        });
    }

    return result.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/**
 * Every decision of one session, in every state, for the hub's Decisions pane: the stored rows,
 * plus the blocks of the last reply that the store does not have yet. Numbered order.
 */
export function sessionDecisions({
    sessionId,
    rows,
    scan,
}: {
    sessionId: string;
    rows: readonly DecisionRecord[];
    scan: TranscriptScan | null;
}): InboxDecision[] {
    const blocks = new Map((scan?.blocks ?? []).map((block) => [block.number, block]));
    const stored = rows
        .filter((row) => row.sessionId === sessionId && kindOf(row) === "decision")
        .map((row) => {
            const block = blocks.get(row.number);
            return block ? merged(row, block) : fromRecord(row);
        });
    const numbers = new Set(stored.map((item) => item.number));
    const fresh = [...blocks.values()]
        .filter((block) => !numbers.has(block.number))
        .map((block) => fromBlock(sessionId, block, scan?.at ?? new Date().toISOString()));

    return [...stored, ...fresh].sort((a, b) => a.number - b.number);
}
