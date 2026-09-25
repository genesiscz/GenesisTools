import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalAgent } from "@app/handoff/targeting";
import { type AgentRuntimeContext, gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { isTestProcess } from "@genesiscz/utils/test-process";
import type { z } from "zod";
import {
    type DECISION_KINDS,
    type DECISION_STATES,
    type DecisionPatch,
    type DecisionUpdate,
    decisionBatchUpdateSchema,
    decisionPatchSchema,
    parseDecisionInput,
    postDecisionsInputSchema,
    type postedDecisionSchema,
    storedDecisionSchema,
} from "./schema";

export type DecisionState = (typeof DECISION_STATES)[number];
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionRef {
    path: string;
    line?: number;
    endLine?: number;
    sha?: string;
}

/**
 * Where a send took an answer: typed into a cmux pane, steered into a codex worker, handed to the
 * session's next prompt by the UserPromptSubmit hook, or queued for that prompt.
 */
export interface DecisionDelivery {
    /** `resume`: the answers went as the first prompt of the session resumed in a new pane. */
    route: "cmux" | "codex" | "prompt" | "queued" | "resume";
    /** A short human place: `cmux · agents-window · pane 1`, `codex worker w1`. Never an error text. */
    target?: string;
    /** One sentence saying why a queued send delivered nothing. The raw output is in the log only. */
    error?: string;
    at: string;
}

export interface DecisionRecord {
    id: string;
    sessionId: string;
    /** Absent on rows written before todos existed; those are decisions. */
    type?: DecisionKind;
    number: number;
    prompt: string;
    options: string[];
    excerpt?: string;
    title?: string;
    proposal?: string;
    recommended?: string;
    for?: string;
    reevaluateWhen?: string;
    reasoning?: string;
    confidence?: "high" | "medium" | "low";
    refs?: DecisionRef[];
    blocking?: boolean;
    provider?: string;
    cwd?: string;
    repoRoot?: string;
    branch?: string | null;
    project?: string;
    commitSha?: string | null;
    aiAgent?: string | null;
    isWorktree?: boolean;
    cmuxSurface?: string;
    sessionTitle?: string;
    /** The user's unsent note. Consumed by the move to `answered`. */
    draft?: string;
    /** The user's unsent pick: option letters, several allowed (`"ac"`). Consumed with `draft`. */
    draftOption?: string;
    /** Harvested from a reply: the text that led to the block, and the text under its options. */
    context?: string;
    notes?: string;
    /** Per-option rationale from the reply, parallel to `options`; null where the reply gave none. */
    rationales?: (string | null)[];
    state: DecisionState;
    answer?: string;
    /** The chosen option letters, when the answer picked one or more (`"b"`, `"ac"`). */
    option?: string;
    commitRefs?: string[];
    verdict?: string;
    comments?: string[];
    /** Stored by the Stop hook's safety net from a reply, not posted by the agent. */
    harvested?: boolean;
    /** Staleness thresholds already notified, so each one fires once. */
    notified?: string[];
    /** The last send of this answer (`sendAnsweredDecisions`); absent on rows never sent. */
    delivery?: DecisionDelivery;
    createdTs?: string;
    updatedTs: string;
}

const NEXT: Record<DecisionKind, Record<DecisionState, DecisionState[]>> = {
    decision: {
        open: ["answered", "drafted", "dismissed"],
        // Saving a draft again replaces it: the user edits a draft more than once before sending.
        // Clearing the last pick puts it back to open; Dismiss drops it without an answer.
        drafted: ["answered", "drafted", "open", "dismissed"],
        answered: ["sent"],
        sent: ["acknowledged"],
        acknowledged: ["implemented"],
        implemented: [],
        dismissed: [],
    },
    // A todo is done, not answered: whoever it is for takes it and finishes it.
    todo: {
        open: ["acknowledged", "implemented", "dismissed"],
        drafted: [],
        answered: [],
        sent: [],
        acknowledged: ["implemented"],
        implemented: [],
        dismissed: [],
    },
};

const ID_PREFIX: Record<DecisionKind, string> = { decision: "d", todo: "t" };

export function kindOf(row: Pick<DecisionRecord, "type">): DecisionKind {
    return row.type ?? "decision";
}

function canMove(row: DecisionRecord, state: DecisionState): boolean {
    return NEXT[kindOf(row)][row.state].includes(state);
}

/**
 * The provider name every reader compares against (`claude`, `codex`, `grok`): the harness
 * context calls Claude `claude-code`, the inbox, the hub and the delivery say `claude`.
 */
function providerName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? (canonicalAgent(trimmed) ?? trimmed) : undefined;
}

export type PostedDecision = z.infer<typeof postedDecisionSchema>;

export interface PostDecisionDeps {
    now?: () => string;
    readFile?: (path: string) => string;
    /** Test override. Production gathers from the live process. */
    env?: NodeJS.ProcessEnv;
    ctx?: Partial<AgentRuntimeContext>;
}

/**
 * The CLI, the MCP server and every agent write this file from separate processes. A read, the
 * number allocation or the patch, and the write run as ONE critical section under this lock, so
 * two posts cannot take the same number and a rewrite cannot drop a row another writer added.
 * The lock is not reentrant: never call a writer from inside it.
 */
function withDecisionsLock<T>(file: string, fn: () => T): Promise<T> {
    return withFileLock(`${file}.lock`, async () => fn());
}

/**
 * Appends a validated batch: a payload with any malformed decision is refused whole, before the
 * first row is written. `payload` is untyped on purpose, since the CLI reads it from stdin and the
 * MCP server from a client.
 */
export async function postDecisions(
    file: string,
    events: string,
    payload: unknown,
    deps: PostDecisionDeps = {}
): Promise<DecisionRecord[]> {
    const input = parseDecisionInput(postDecisionsInputSchema, payload, "decision post");
    const now = deps.now ?? (() => new Date().toISOString());
    const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
    const processEnv = deps.env ?? (isTestProcess() ? {} : env.getProcessEnv());
    const poster = gatherHarnessPoster(deps.ctx, processEnv);
    const harnessSession = poster.agent !== "unknown" && poster.sessionId ? poster.sessionId : null;
    // The pane the agent runs in, when it runs in cmux: the hub opens it and `send` types there.
    const cmuxSurface = input.cmuxSurface ?? processEnv.CMUX_SURFACE_ID;
    const requested = input.sessionId?.trim() ?? "";
    // A live harness owns the session. A typed id is only for a human CLI or a test.
    const sessionId = !isTestProcess() && harnessSession ? harnessSession : requested || harnessSession || "unknown";
    const provider = providerName(input.provider ?? (poster.agent === "unknown" ? undefined : poster.agent));
    const cwd = input.cwd ?? poster.cwd;
    const sessionTitle = input.title ?? poster.sessionTitle ?? undefined;
    const excerpts = input.decisions.map((decision) => decision.excerpt ?? excerptFrom(decision.refs, readFile, cwd));

    return withDecisionsLock(file, () => {
        const numbers = sessionNumbers(readDecisions(file), sessionId);
        const created: DecisionRecord[] = [];

        for (const [index, decision] of input.decisions.entries()) {
            const kind = decision.type ?? "decision";
            const used = numbers[kind];
            const number = used.size === 0 ? 1 : Math.max(...used) + 1;
            const excerpt = excerpts[index];
            const ts = now();
            const row: DecisionRecord = {
                id: `${ID_PREFIX[kind]}_${number}_${sessionId}`,
                sessionId,
                ...(kind === "decision" ? {} : { type: kind }),
                number,
                prompt: decision.prompt,
                options: decision.options,
                ...(excerpt ? { excerpt } : {}),
                ...(decision.title ? { title: decision.title } : {}),
                ...(decision.proposal ? { proposal: decision.proposal } : {}),
                ...(decision.recommended ? { recommended: decision.recommended } : {}),
                ...(decision.for ? { for: decision.for } : {}),
                ...(decision.reevaluateWhen ? { reevaluateWhen: decision.reevaluateWhen } : {}),
                ...(decision.reasoning ? { reasoning: decision.reasoning } : {}),
                ...(decision.confidence ? { confidence: decision.confidence } : {}),
                ...(decision.refs ? { refs: decision.refs } : {}),
                ...(decision.blocking === undefined ? {} : { blocking: decision.blocking }),
                ...(provider ? { provider } : {}),
                ...(cwd ? { cwd } : {}),
                ...(poster.repoRoot ? { repoRoot: poster.repoRoot } : {}),
                ...(poster.branch ? { branch: poster.branch } : {}),
                ...(poster.project ? { project: poster.project } : {}),
                ...(poster.commitSha ? { commitSha: poster.commitSha } : {}),
                ...(poster.aiAgent ? { aiAgent: poster.aiAgent } : {}),
                isWorktree: poster.isWorktree,
                ...(cmuxSurface ? { cmuxSurface } : {}),
                ...(sessionTitle ? { sessionTitle } : {}),
                state: "open",
                createdTs: ts,
                updatedTs: ts,
            };
            used.add(number);
            created.push(row);
            append(file, row);
            appendEvent(events, { ev: "created", id: row.id, ts: row.updatedTs });
        }

        return created;
    });
}

/** Numbers already taken in one session, per kind: a decision and a todo may both be number 1. */
function sessionNumbers(rows: DecisionRecord[], sessionId: string): Record<DecisionKind, Set<number>> {
    const numbers: Record<DecisionKind, Set<number>> = { decision: new Set(), todo: new Set() };

    for (const row of rows) {
        if (row.sessionId === sessionId) {
            numbers[kindOf(row)].add(row.number);
        }
    }

    return numbers;
}

/** The patched row, or a thrown reason. Pure, so a batch can check every patch before it writes. */
function patched(row: DecisionRecord, patch: DecisionPatch, ts: string): DecisionRecord {
    if (patch.state && !canMove(row, patch.state)) {
        throw new Error(`cannot move ${row.id} from ${row.state} to ${patch.state}`);
    }

    const { comment, ...fields } = patch;
    const next: DecisionRecord = {
        ...row,
        ...fields,
        ...(comment ? { comments: [...(row.comments ?? []), comment] } : {}),
        updatedTs: ts,
    };

    // Checked on the MERGED row, since an earlier patch may have supplied the answer. An
    // `answered` row without one is never delivered and cannot move anywhere else.
    if (patch.state === "answered" && !next.answer?.trim() && !next.option) {
        throw new Error(`cannot move ${row.id} to answered without an answer`);
    }

    // A letter past the options would be delivered as `DECISION 1: z)`, naming nothing.
    for (const pick of [patch.option, patch.draftOption]) {
        const past = [...(pick ?? "")].find((letter) => letter.charCodeAt(0) - 97 >= row.options.length);

        if (past && row.options.length > 0) {
            const last = String.fromCharCode(96 + row.options.length);
            throw new Error(`DECISION ${row.number} has options a-${last}, not "${pick}" (${row.id})`);
        }
    }

    // The answer consumes the draft: a sent decision must not still show an unsent pick.
    if (patch.state === "answered" || patch.state === "dismissed") {
        delete next.draft;
        delete next.draftOption;
    }

    return next;
}

/** Moves one decision. The patch is validated first, and unknown keys are dropped. */
export async function updateDecision(
    file: string,
    events: string,
    id: string,
    payload: unknown,
    now = () => new Date().toISOString()
): Promise<DecisionRecord> {
    const patch = parseDecisionInput(decisionPatchSchema, payload, "decision update");
    const [row] = await applyUpdates(file, events, [{ ...patch, id }], now);

    if (!row) {
        throw new Error(`no decision ${id}`);
    }

    return row;
}

/**
 * Several updates as ONE transition (`question_update`): one lock, every patch checked before
 * any is written, one rewrite. A batch with one bad id or one illegal move changes nothing.
 */
export async function updateDecisions(
    file: string,
    events: string,
    payload: unknown,
    now = () => new Date().toISOString()
): Promise<DecisionRecord[]> {
    const { updates } = parseDecisionInput(decisionBatchUpdateSchema, payload, "question update");
    return applyUpdates(file, events, updates, now);
}

function applyUpdates(
    file: string,
    events: string,
    updates: DecisionUpdate[],
    now: () => string
): Promise<DecisionRecord[]> {
    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const ts = now();

        for (const { id, ...patch } of updates) {
            const row = byId.get(id);

            if (!row) {
                throw new Error(`no decision ${id}`);
            }

            byId.set(id, patched(row, patch, ts));
        }

        const changed = new Set(updates.map((update) => update.id));
        rewrite(
            file,
            rows.map((row) => byId.get(row.id) ?? row)
        );

        const result = [...changed].map((id) => byId.get(id)).filter((row): row is DecisionRecord => Boolean(row));

        for (const row of result) {
            appendEvent(events, { ev: "updated", id: row.id, ts, state: row.state });
        }

        return result;
    });
}

export interface HarvestedDecision {
    number: number;
    prompt: string;
    options: string[];
    title?: string;
    /** Per-option rationale from the reply, parallel to `options`. */
    rationales?: (string | null)[];
    /** The letter the reply marks as recommended. */
    recommended?: string;
    /** Text under the options that still talks about the decision. */
    notes?: string;
    /** The reply text that leads to the block (the preamble for the first block). */
    context?: string;
}

/**
 * The Stop hook's safety net: `❓ DECISION N` blocks the agent wrote but never posted are stored
 * as open decisions under THEIR number, so the hub still shows them. A number the session already
 * has is skipped, never overwritten or renumbered.
 */
export async function harvestDecisions(
    file: string,
    events: string,
    {
        sessionId,
        provider,
        cwd,
        found,
    }: { sessionId: string; provider?: string; cwd?: string; found: HarvestedDecision[] },
    now = () => new Date().toISOString()
): Promise<DecisionRecord[]> {
    if (found.length === 0) {
        return [];
    }

    const name = providerName(provider);

    return withDecisionsLock(file, () => {
        const used = sessionNumbers(readDecisions(file), sessionId).decision;
        const ts = now();
        const stored: DecisionRecord[] = [];

        for (const item of found) {
            if (used.has(item.number)) {
                continue;
            }

            const row: DecisionRecord = {
                id: `d_${item.number}_${sessionId}`,
                sessionId,
                number: item.number,
                prompt: item.prompt,
                options: item.options,
                ...(item.title ? { title: item.title } : {}),
                ...(item.rationales ? { rationales: item.rationales } : {}),
                ...(item.recommended ? { recommended: item.recommended } : {}),
                ...(item.notes ? { notes: item.notes } : {}),
                ...(item.context ? { context: item.context } : {}),
                ...(name ? { provider: name } : {}),
                ...(cwd ? { cwd } : {}),
                harvested: true,
                state: "open",
                createdTs: ts,
                updatedTs: ts,
            };
            used.add(item.number);
            stored.push(row);
            append(file, row);
            appendEvent(events, { ev: "harvested", id: row.id, ts });
        }

        return stored;
    });
}

/**
 * Records where a send took these rows. It never changes a state: the send already moved them
 * (`sent`, or back to `answered` when queued). A later send overwrites the record.
 */
export async function recordDelivery(
    file: string,
    events: string,
    ids: string[],
    delivery: Omit<DecisionDelivery, "at">,
    now = () => new Date().toISOString()
): Promise<void> {
    if (ids.length === 0) {
        return;
    }

    const wanted = new Set(ids);

    await withDecisionsLock(file, () => {
        const ts = now();
        const stamped: DecisionDelivery = { ...delivery, at: ts };
        rewrite(
            file,
            readDecisions(file).map((row) => (wanted.has(row.id) ? { ...row, delivery: stamped } : row))
        );

        for (const id of ids) {
            appendEvent(events, { ev: "delivery", id, ts, route: delivery.route });
        }
    });
}

/** Records that a staleness threshold was notified, so the next check does not notify it again. */
export async function markNotified(
    file: string,
    events: string,
    marks: Array<{ id: string; threshold: string }>,
    now = () => new Date().toISOString()
): Promise<void> {
    if (marks.length === 0) {
        return;
    }

    await withDecisionsLock(file, () => {
        const ts = now();
        const rows = readDecisions(file).map((row) => {
            const added = marks.filter((mark) => mark.id === row.id).map((mark) => mark.threshold);

            if (added.length === 0) {
                return row;
            }

            return { ...row, notified: [...new Set([...(row.notified ?? []), ...added])] };
        });
        rewrite(file, rows);

        for (const mark of marks) {
            appendEvent(events, { ev: "stale", id: mark.id, ts, threshold: mark.threshold });
        }
    });
}

/**
 * The compensating move for a send whose delivery failed: rows marked `sent` go back to
 * `answered`, the one backward move the store allows, and only from `sent`. The next send then
 * delivers them again instead of reporting "nothing to send" for answers nobody received.
 */
export async function restoreUndelivered(
    file: string,
    events: string,
    ids: string[],
    now = () => new Date().toISOString()
): Promise<void> {
    const wanted = new Set(ids);

    await withDecisionsLock(file, () => {
        const ts = now();
        const rows = readDecisions(file);
        const restored = rows.map((row) =>
            wanted.has(row.id) && row.state === "sent" ? { ...row, state: "answered" as const, updatedTs: ts } : row
        );
        rewrite(file, restored);

        for (const row of restored) {
            if (wanted.has(row.id) && row.updatedTs === ts) {
                appendEvent(events, { ev: "send_failed", id: row.id, ts, state: "answered" });
            }
        }
    });
}

/**
 * Moves several decisions to one state as ONE transition: one lock, every move validated before
 * any is written, one rewrite. A send that delivered a batch must mark the whole batch, or none,
 * so a crash between rows cannot leave answers that the next send delivers again.
 */
export async function moveDecisions(
    file: string,
    events: string,
    ids: string[],
    state: DecisionState,
    now = () => new Date().toISOString()
): Promise<DecisionRecord[]> {
    const wanted = new Set(ids);

    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const moving = rows.filter((row) => wanted.has(row.id));

        if (moving.length !== wanted.size) {
            const known = new Set(moving.map((row) => row.id));
            throw new Error(`no decision ${ids.filter((id) => !known.has(id)).join(", ")}`);
        }

        for (const row of moving) {
            if (!canMove(row, state)) {
                throw new Error(`cannot move ${row.id} from ${row.state} to ${state}`);
            }
        }

        const ts = now();
        const moved = new Map(moving.map((row) => [row.id, { ...row, state, updatedTs: ts }]));
        rewrite(
            file,
            rows.map((row) => moved.get(row.id) ?? row)
        );

        for (const row of moved.values()) {
            appendEvent(events, { ev: "updated", id: row.id, ts, state });
        }

        return [...moved.values()];
    });
}

/**
 * A missing log has no decisions. A torn line (a writer killed mid-append) is skipped and
 * logged, so it can no longer empty the whole log, which made the next post reuse `d_1_<session>`
 * and merged two decisions on the following update. A line that parses but lacks a field every
 * reader relies on (a hand edit, an older shape) is skipped the same way: the state machine and the
 * sort would otherwise throw on it and break every listing and update. Any other read error throws.
 */
export function readDecisions(file: string): DecisionRecord[] {
    const { rows, skipped } = readJsonlRows<unknown>(file);
    const valid = rows.filter(isStoredDecision);
    const malformed = rows.length - valid.length;

    if (skipped > 0 || malformed > 0) {
        logger.warn({ file, skipped, malformed }, "[decisions] skipped unreadable lines in the decision log");
    }

    return valid;
}

function isStoredDecision(value: unknown): value is DecisionRecord {
    return storedDecisionSchema.safeParse(value).success;
}

/**
 * Up to 40 lines of the first ref. A relative ref is resolved against the DECISION's cwd (the
 * agent's), not this process's: the CLI or the MCP server storing it usually runs elsewhere.
 */
function excerptFrom(
    refs: DecisionRef[] | undefined,
    readFile: (path: string) => string,
    cwd: string | undefined
): string | undefined {
    const ref = refs?.[0];

    if (!ref) {
        return undefined;
    }

    const path = isAbsolute(ref.path) ? ref.path : resolve(cwd ?? process.cwd(), ref.path);

    try {
        const lines = readFile(path).split("\n");
        const start = Math.max(1, ref.line ?? 1);
        const end = Math.min(lines.length, ref.endLine ?? start + 39, start + 39);
        const text = lines.slice(start - 1, end).join("\n");
        return text.length > 0 ? text : undefined;
    } catch (error) {
        logger.debug({ error, path }, "[decisions] no excerpt: the first ref could not be read");
        return undefined;
    }
}

/**
 * The decisions log is the record; the events log is a feed that lets a watcher notice a change
 * sooner. An event is therefore written AFTER the decision is durable and can never fail the
 * operation: a caller told "failed" about a post that committed would retry it and create a second
 * numbered decision, and a retried update would be refused as an invalid transition. A lost event
 * is logged; a reader that missed it still sees the change in the decisions log.
 */
function appendEvent(events: string, value: Record<string, unknown>): void {
    try {
        append(events, value);
    } catch (error) {
        logger.warn({ error, events, event: value }, "[decisions] event not recorded; the decision itself is saved");
    }
}

/** Starts on a fresh line when the last write was torn, so one bad row cannot swallow the next. */
function append(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${endsTorn(file) ? "\n" : ""}${SafeJSON.stringify(value)}\n`);
}

function endsTorn(file: string): boolean {
    if (!existsSync(file)) {
        return false;
    }

    const size = statSync(file).size;

    if (size === 0) {
        return false;
    }

    const last = Buffer.alloc(1);
    const fd = openSync(file, "r");

    try {
        readSync(fd, last, 0, 1, size - 1);
    } finally {
        closeSync(fd);
    }

    return last[0] !== 0x0a;
}

/** Through a temp file and a rename, so a reader never catches a half-written log. */
function rewrite(file: string, rows: DecisionRecord[]): void {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(temp, rows.map((row) => SafeJSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
    renameSync(temp, file);
}
