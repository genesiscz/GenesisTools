import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalAgent } from "@app/handoff/targeting";
import {
    type AgentRuntimeContext,
    callerCwd,
    currentCaller,
    gatherHarnessPoster,
} from "@genesiscz/utils/agent/runtime";
import { createTranscriptAnchor, type TranscriptAnchor } from "@genesiscz/utils/agent/source-anchor";
import { formatLocalDateTimeStamp } from "@genesiscz/utils/date";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { readJsonlRows } from "@genesiscz/utils/jsonl";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { isTestProcess } from "@genesiscz/utils/test-process";
import type { z } from "zod";
import { retractDecisionBanners } from "./banners";
import {
    type ANSWERED_VIA,
    type DECISION_KINDS,
    type DECISION_STATES,
    type DecisionPatch,
    type DecisionSource,
    type DecisionUpdate,
    decisionBatchUpdateSchema,
    decisionPatchSchema,
    parseDecisionInput,
    postDecisionsInputSchema,
    type postedDecisionSchema,
    type StoredTransclusion,
    storedDecisionSchema,
} from "./schema";

export type DecisionState = (typeof DECISION_STATES)[number];
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type AnsweredVia = (typeof ANSWERED_VIA)[number];

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
    uncertain?: boolean;
    queueId?: string;
    /** `resume`: the answers went as the first prompt of the session resumed in a new pane. */
    route: "cmux" | "codex" | "claude-peer" | "prompt" | "queued" | "resume";
    /** A short human place: `cmux · agents-window · pane 1`, `codex worker w1`. Never an error text. */
    target?: string;
    /** One sentence saying why a queued send delivered nothing. The raw output is in the log only. */
    error?: string;
    at: string;
}

export interface DecisionRecord {
    transcriptAnchor?: TranscriptAnchor;
    worktreePath?: string | null;
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
    /**
     * Who stored the answer, set by the store: `inbox` on the move to `answered` (the widget, the hub, the CLI),
     * `agent` on a move from open or drafted straight to `acknowledged` (an answer the user gave in chat).
     */
    answeredVia?: AnsweredVia;
    /** When the answer was stored: the move that set `answeredVia`. Later updates move `updatedTs`, not this. */
    answeredTs?: string;
    /** The decision that replaced this one (`superseded`); it exists in the store, in any session. */
    supersededBy?: string;
    commitRefs?: string[];
    verdict?: string;
    comments?: string[];
    /** Stored by the Stop hook's safety net from a reply, not posted by the agent. */
    harvested?: boolean;
    /** Staleness thresholds already notified, so each one fires once. */
    notified?: string[];
    /** The last send of this answer (`sendAnsweredDecisions`); absent on rows never sent. */
    delivery?: DecisionDelivery;
    /** A prepared sidebar prompt owns these answers until submission is acknowledged or the lease expires. */
    promptReservation?: { token: string; expiresAt: number };
    /** The fields as the agent wrote them, inline tokens included; only fields that had tokens. */
    source?: DecisionSource;
    /** Every inline token of the post, resolved or failed, with the field it was in. */
    transclusions?: StoredTransclusion[];
    /** Counts up each time a post supersedes this item; absent means the first version. */
    revision?: number;
    /** The superseded versions, oldest first. Never shown by the inbox, listed by `show --versions`. */
    versions?: DecisionVersion[];
    /** When the current version replaced the previous one. */
    revisedTs?: string;
    createdTs?: string;
    updatedTs: string;
}

/**
 * The optional fields a superseding post replaces, besides `prompt` and `options`; everything else
 * (id, number, comments) stays with the item.
 */
const VERSIONED_KEYS = [
    "transcriptAnchor",
    "provider",
    "cwd",
    "repoRoot",
    "branch",
    "project",
    "commitSha",
    "aiAgent",
    "isWorktree",
    "worktreePath",
    "sessionTitle",
    "cmuxSurface",
    "excerpt",
    "title",
    "proposal",
    "recommended",
    "for",
    "reevaluateWhen",
    "reasoning",
    "confidence",
    "refs",
    "blocking",
    "source",
    "transclusions",
    "draft",
    "draftOption",
    // Parallel to `options`, and the text around a harvested block: they go with the old version.
    "rationales",
    "context",
    "notes",
] as const satisfies readonly (keyof DecisionRecord)[];

type VersionedKey = (typeof VERSIONED_KEYS)[number];

/** One earlier version of an item, as it stood when a later post superseded it. */
export type DecisionVersion = Pick<DecisionRecord, "prompt" | "options" | VersionedKey> & {
    revision: number;
    state: DecisionState;
    /** When this version was posted. */
    createdTs?: string;
    supersededTs: string;
};

/** Only an item nobody has answered yet may be replaced: an answer must keep pointing at the text it answered. */
const SUPERSEDABLE: ReadonlySet<DecisionState> = new Set(["open", "drafted"]);

const NEXT: Record<DecisionKind, Record<DecisionState, DecisionState[]>> = {
    decision: {
        // `acknowledged` straight from open or drafted: an agent records an answer the user gave in chat (patched()
        // requires option or answer). Nothing is delivered: every send reads `answered` rows only.
        // `superseded`: a later decision replaced it (patched() requires supersededBy or a comment). Terminal.
        open: ["answered", "drafted", "dismissed", "acknowledged", "superseded"],
        // Saving a draft again replaces it: the user edits a draft more than once before sending.
        // Clearing the last pick puts it back to open; Dismiss drops it without an answer.
        drafted: ["answered", "drafted", "open", "dismissed", "acknowledged", "superseded"],
        // An agent that got the answer in chat records its progress without a send (patched() refuses it while a
        // queued delivery holds the row). No `superseded` here: the answer waits for its delivery.
        answered: ["sent", "acknowledged", "implemented"],
        sent: ["acknowledged", "implemented", "superseded"],
        acknowledged: ["implemented", "superseded"],
        implemented: [],
        dismissed: [],
        superseded: [],
    },
    // A todo is done, not answered: whoever it is for takes it and finishes it.
    todo: {
        open: ["acknowledged", "implemented", "dismissed"],
        drafted: [],
        answered: [],
        sent: [],
        acknowledged: ["implemented", "dismissed"],
        implemented: ["open"],
        dismissed: ["open"],
        superseded: [],
    },
};

const ID_PREFIX: Record<DecisionKind, string> = { decision: "d", todo: "t" };

export function kindOf(row: Pick<DecisionRecord, "type">): DecisionKind {
    return row.type ?? "decision";
}

function canMove(row: DecisionRecord, state: DecisionState): boolean {
    return NEXT[kindOf(row)][row.state].includes(state);
}

export interface PromptReceipt {
    ids: string[];
    text: string;
    token: string;
}

/**
 * Who asks for an update. `agent`: the doors agents write through (`question_update`, `tools question update`); an
 * agent records what happened and never queues or sends an answer (`agentPatch`). `user` (the store's default): the
 * inbox's own answer and send paths, the widget and the hub, which deliver what they move to `answered`. Every caller
 * of `updateDecisions` was classified on 2026-10-27; a new agent-facing door passes `actor: "agent"`.
 */
export type DecisionActor = "agent" | "user";

/**
 * An answered decision a whole-session send may deliver: one the inbox answered (`answeredVia: "inbox"`), or one an
 * earlier send already tried (`delivery`). An `answered` row with neither is a chat answer an agent recorded through
 * the old protocol (2026-10-27: 91 of them in 15 sessions), and sending it would type the user's own words back into
 * the session a second time.
 */
export function awaitsDelivery(row: DecisionRecord): boolean {
    return (
        kindOf(row) === "decision" &&
        row.state === "answered" &&
        (row.delivery !== undefined || row.answeredVia === "inbox")
    );
}

/**
 * An agent's `answered` or `sent`: the agent has the answer (the user gave it in chat, or a send reached it), and
 * only a send may queue or deliver one. It lands as `acknowledged`, which delivers nothing, with a comment that says
 * so. Other patches pass unchanged.
 */
function agentPatch(row: DecisionRecord, patch: DecisionPatch): DecisionPatch {
    if (kindOf(row) !== "decision" || (patch.state !== "answered" && patch.state !== "sent")) {
        return patch;
    }

    const asked = patch.state;
    const done = row.state === "acknowledged" || row.state === "implemented";
    const note = `Recorded as acknowledged: an agent asked for ${asked}, and only a send queues or delivers an answer.`;
    logger.info({ id: row.id, from: row.state, asked }, "[decisions] an agent's answered or sent became acknowledged");
    const { state: _state, ...rest } = patch;

    return {
        ...rest,
        ...(done ? {} : { state: "acknowledged" as const }),
        comment: [patch.comment?.trim(), note].filter(Boolean).join(" "),
    };
}

export function promptReserved(row: DecisionRecord): boolean {
    return (row.promptReservation?.expiresAt ?? 0) > Date.now();
}

/** Reserve before host.submit can trigger UserPromptSubmit. A crashed submitter releases its claim after five minutes. */
export async function reservePromptDecisions({
    file,
    events,
    session,
    ids,
    now = Date.now(),
}: {
    file: string;
    events: string;
    session: string;
    ids?: readonly string[];
    now?: number;
}): Promise<{ rows: DecisionRecord[]; token: string }> {
    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const selected = ids ? new Set(ids) : undefined;
        const due = rows.filter(
            (row) =>
                row.sessionId === session &&
                kindOf(row) === "decision" &&
                (selected ? selected.has(row.id) : awaitsDelivery(row)) &&
                row.state === "answered" &&
                !row.delivery?.queueId &&
                (row.promptReservation?.expiresAt ?? 0) <= now &&
                (Boolean(row.option) || Boolean(row.answer?.trim()))
        );
        if (due.length === 0) {
            throw new Error("nothing to send");
        }

        const token = randomUUID();
        const reserved = new Map(
            due.map((row) => [row.id, { ...row, promptReservation: { token, expiresAt: now + 5 * 60_000 } }])
        );
        rewrite(
            file,
            rows.map((row) => reserved.get(row.id) ?? row)
        );
        appendEvent(events, { ev: "prompt_reserved", ids: [...reserved.keys()], ts: new Date(now).toISOString() });
        return { rows: [...reserved.values()], token };
    });
}

/** Acknowledge only this submitted batch under the lock, or release its still-owned rows after submission failed. */
export async function finishPromptDecisions({
    file,
    events,
    session,
    receipt,
    acknowledge,
}: {
    file: string;
    events: string;
    session: string;
    receipt: PromptReceipt;
    /** Validates the exact submitted text before any row is marked sent. Omitted for a failed submission. */
    acknowledge?: (rows: DecisionRecord[]) => void;
}): Promise<DecisionRecord[]> {
    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const wanted = new Set(receipt.ids);
        const owned = rows.filter(
            (row) =>
                row.sessionId === session &&
                wanted.has(row.id) &&
                kindOf(row) === "decision" &&
                row.state === "answered" &&
                typeof receipt.token === "string" &&
                receipt.token.length > 0 &&
                row.promptReservation?.token === receipt.token
        );
        if (acknowledge) {
            if (wanted.size === 0 || owned.length !== wanted.size || wanted.size !== receipt.ids.length) {
                throw new Error("The pending answers changed; the submitted batch was not marked sent");
            }

            acknowledge(owned);
        }

        const ts = new Date().toISOString();
        const changed = new Map(
            owned.map((row) => {
                const next: DecisionRecord = { ...row };
                delete next.promptReservation;
                if (acknowledge) {
                    next.state = "sent";
                    next.updatedTs = ts;
                    next.delivery = { route: "prompt", at: ts, target: "the session's own prompt" };
                }

                return [row.id, next] as const;
            })
        );
        if (changed.size > 0) {
            rewrite(
                file,
                rows.map((row) => changed.get(row.id) ?? row)
            );
            appendEvent(events, { ev: acknowledge ? "prompt_sent" : "prompt_released", ids: [...changed.keys()], ts });
        }
        return [...changed.values()];
    });
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
    const fallback = currentCaller()?.sessionId === null && input.cwd ? { cwd: input.cwd } : {};
    const poster = gatherHarnessPoster({ ...fallback, ...deps.ctx }, processEnv);
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

    const context: Partial<DecisionRecord> = {
        ...(provider ? { provider } : {}),
        ...(cwd ? { cwd } : {}),
        ...(poster.repoRoot ? { repoRoot: poster.repoRoot } : {}),
        ...(poster.branch ? { branch: poster.branch } : {}),
        ...(poster.project ? { project: poster.project } : {}),
        ...(poster.commitSha ? { commitSha: poster.commitSha } : {}),
        ...(poster.aiAgent ? { aiAgent: poster.aiAgent } : {}),
        isWorktree: poster.isWorktree,
        worktreePath: poster.worktreePath,
        ...(cmuxSurface ? { cmuxSurface } : {}),
        ...(sessionTitle ? { sessionTitle } : {}),
    };

    return withDecisionsLock(file, () => {
        const existing = readDecisions(file);
        const numbers = sessionNumbers(existing, sessionId);
        const byId = new Map(existing.map((row) => [row.id, row]));
        const revised = new Map<string, DecisionRecord>();
        const appended: DecisionRecord[] = [];
        const created: DecisionRecord[] = [];

        // Every row is built and checked before the first write, so a bad supersede stores nothing.
        for (const [index, decision] of input.decisions.entries()) {
            const kind = decision.type ?? "decision";
            const ts = now();
            const transcriptAnchor = createTranscriptAnchor({
                context: {
                    ...poster,
                    sessionId,
                    sourceMessage:
                        sessionId === poster.sessionId && provider === providerName(poster.agent)
                            ? poster.sourceMessage
                            : undefined,
                    agent:
                        provider === "claude"
                            ? "claude-code"
                            : provider === "codex" || provider === "grok" || provider === "copilot"
                              ? provider
                              : // Never the poster's harness for a provider override it does not match: the anchor
                                // would name a transcript that is not this row's.
                                "unknown",
                },
                receivedAt: Date.parse(ts),
                sourceMessage: input.sourceMessage,
            });
            const content = contentOf(decision, excerpts[index]);

            // A number the inbox or the Stop hook stored from the reply before the agent posted it: the agent's post
            // is that decision's next revision, not a clash (`decisions.harvestListed`).
            const harvested =
                decision.supersedes === undefined && decision.number !== undefined
                    ? existing.find(
                          (row) =>
                              row.harvested === true &&
                              row.sessionId === sessionId &&
                              kindOf(row) === kind &&
                              row.number === decision.number &&
                              SUPERSEDABLE.has(row.state) &&
                              !revised.has(row.id)
                      )
                    : undefined;
            const supersedes = decision.supersedes ?? harvested?.id;

            if (supersedes) {
                const row = supersede({
                    target: byId.get(supersedes),
                    id: supersedes,
                    kind,
                    sessionId,
                    revised,
                });
                // The staged pick was made on the old text, so it goes with the old version; say so on the row.
                const pick = [...(row.draftOption ?? "")].map((letter) => `${letter})`).join(" ");
                const dropped = [pick, row.draft?.trim() ? "note" : ""].filter(Boolean).join(" and ");
                const next: DecisionRecord = {
                    ...withoutVersioned(row),
                    ...(dropped
                        ? {
                              comments: [
                                  ...(row.comments ?? []),
                                  `The agent posted a new text (revision ${(row.revision ?? 1) + 1}), so the staged ${dropped} on the earlier text was cleared; it is kept in that version. Pick again.`,
                              ],
                          }
                        : {}),
                    ...content,
                    ...context,
                    // The provider is half of the item's session identity, which a revision keeps. The delivery pane
                    // and the session title stay too when the revising process does not know them (no CMUX_SURFACE_ID).
                    ...(context.provider || !row.provider ? {} : { provider: row.provider }),
                    ...(context.cmuxSurface || !row.cmuxSurface ? {} : { cmuxSurface: row.cmuxSurface }),
                    ...(context.sessionTitle || !row.sessionTitle ? {} : { sessionTitle: row.sessionTitle }),
                    transcriptAnchor,
                    state: "open",
                    revision: (row.revision ?? 1) + 1,
                    versions: [...(row.versions ?? []), versionOf(row, ts)],
                    revisedTs: ts,
                    updatedTs: ts,
                };
                delete next.notified;

                if (harvested) {
                    delete next.harvested;
                }

                revised.set(next.id, next);
                created.push(next);
                continue;
            }

            const used = numbers[kind];
            if (decision.number !== undefined && used.has(decision.number)) {
                throw new Error(
                    `${kind === "todo" ? "TODO" : "DECISION"} ${decision.number} is already in session ${sessionId}; ` +
                        "post a later number, or revise the earlier one with supersedes"
                );
            }

            const number = decision.number ?? (used.size === 0 ? 1 : Math.max(...used) + 1);
            const row: DecisionRecord = {
                id: `${ID_PREFIX[kind]}_${number}_${sessionId}`,
                sessionId,
                ...(kind === "decision" ? {} : { type: kind }),
                number,
                ...content,
                ...context,
                transcriptAnchor,
                state: "open",
                createdTs: ts,
                updatedTs: ts,
            };
            used.add(number);
            appended.push(row);
            created.push(row);
        }

        if (revised.size > 0) {
            rewrite(file, [...existing.map((row) => revised.get(row.id) ?? row), ...appended]);
        } else {
            for (const row of appended) {
                append(file, row);
            }
        }

        for (const row of created) {
            const superseded = revised.get(row.id) === row;
            appendEvent(events, {
                ev: superseded ? "superseded" : "created",
                id: row.id,
                ts: row.updatedTs,
                ...(superseded ? { revision: row.revision } : {}),
            });
        }

        if (revised.size > 0) {
            logger.debug(
                { ids: [...revised.keys()] },
                "[decisions] superseded items; the earlier text is kept in versions"
            );
        }

        return created;
    });
}

type ContentFields = Pick<DecisionRecord, "prompt" | "options" | VersionedKey>;

/** The versioned fields of a posted item, without the keys it leaves empty. */
function contentOf(decision: PostedDecision, excerpt: string | undefined): ContentFields {
    return {
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
        ...(decision.source ? { source: decision.source } : {}),
        ...(decision.transclusions?.length ? { transclusions: decision.transclusions } : {}),
    };
}

/** The item a post may replace, or a thrown reason naming why it may not. */
function supersede({
    target,
    id,
    kind,
    sessionId,
    revised,
}: {
    target: DecisionRecord | undefined;
    id: string;
    kind: DecisionKind;
    sessionId: string;
    revised: Map<string, DecisionRecord>;
}): DecisionRecord {
    if (revised.has(id)) {
        throw new Error(`cannot supersede ${id} twice in one post`);
    }

    if (!target) {
        throw new Error(`cannot supersede ${id}: no such decision or todo`);
    }

    if (kindOf(target) !== kind) {
        throw new Error(`cannot supersede ${id}: it is a ${kindOf(target)}, and the new item is a ${kind}`);
    }

    // An item belongs to the session that posted it; another session may only post its own item.
    if (target.sessionId !== sessionId) {
        throw new Error(`cannot supersede ${id}: it belongs to another session; post a new item instead`);
    }

    if (!SUPERSEDABLE.has(target.state)) {
        throw new Error(
            `cannot supersede ${id}: it is ${target.state}, and only an open or drafted item can be replaced; post a new item instead`
        );
    }

    return target;
}

function versionOf(row: DecisionRecord, supersededTs: string): DecisionVersion {
    const version: DecisionVersion = {
        prompt: row.prompt,
        options: row.options,
        revision: row.revision ?? 1,
        state: row.state,
        createdTs: row.revisedTs ?? row.createdTs,
        supersededTs,
    };

    for (const key of VERSIONED_KEYS) {
        if (row[key] !== undefined) {
            Object.assign(version, { [key]: row[key] });
        }
    }

    return version;
}

export function withoutVersioned(row: DecisionRecord): DecisionRecord {
    const rest: DecisionRecord = { ...row };

    for (const key of VERSIONED_KEYS) {
        delete rest[key];
    }

    return rest;
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

/**
 * The patched row, or a thrown reason. Pure, so a batch can check every patch before it writes. `stored` names
 * the decision ids a `supersededBy` may point at: every row of the log, in any session.
 */
function patched(
    row: DecisionRecord,
    patch: DecisionPatch,
    ts: string,
    stored: ReadonlyMap<string, DecisionRecord>
): DecisionRecord {
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== (row.revision ?? 1)) {
        throw staleRevisionError(row.number);
    }

    if (patch.state && !canMove(row, patch.state)) {
        throw new Error(`cannot move ${row.id} from ${row.state} to ${patch.state}`);
    }

    if (row.state === "answered" && patch.state && patch.state !== "sent" && row.delivery?.queueId) {
        throw new Error(`${row.id} is reserved by a queued delivery; wait for its consumer acknowledgement`);
    }

    // A queued answer is matched by revision on ACK, and these fields do not bump it; the ACK must not confirm new text.
    const content = [patch.answer, patch.option, patch.draft, patch.draftOption].some((value) => value !== undefined);
    if (promptReserved(row) && (patch.state || content)) {
        throw new Error(`${row.id} is reserved by a submitted prompt; wait for its acknowledgement`);
    }

    if (row.delivery?.queueId && content) {
        throw new Error(`${row.id} is reserved by a queued delivery; cancel that message before changing its answer`);
    }

    const { comment, expectedRevision: _expectedRevision, ...fields } = patch;
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

    // A decision acknowledged before anyone answered it in the inbox carries the answer the user gave in chat.
    const recorded = kindOf(row) === "decision" && patch.state === "acknowledged" && SUPERSEDABLE.has(row.state);
    if (recorded && !next.answer?.trim() && !next.option) {
        throw new Error(
            `cannot move ${row.id} from ${row.state} to acknowledged without the user's answer: pass option or answer`
        );
    }

    if (patch.state === "superseded" && !patch.supersededBy && !comment?.trim()) {
        throw new Error(`cannot move ${row.id} to superseded without supersededBy or a comment saying why`);
    }

    if (patch.supersededBy !== undefined) {
        checkSupersededBy(row, next, patch.supersededBy, stored);
    }

    if (patch.state === "answered") {
        next.answeredVia = "inbox";
        next.answeredTs = ts;
    } else if (recorded) {
        next.answeredVia = "agent";
        next.answeredTs = ts;
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
    if (patch.state === "answered" || patch.state === "dismissed" || patch.state === "superseded" || recorded) {
        delete next.draft;
        delete next.draftOption;
    }

    // Nothing staged any more (an unstage, a cleared pick): plain `open` again, whichever surface cleared it. The
    // widget's unstage used to leave `drafted` with empty fields, which every list then showed as staged.
    if (next.state === "drafted" && !next.draftOption && !next.draft?.trim()) {
        next.state = "open";
        delete next.draft;
        delete next.draftOption;
    }

    return next;
}

export interface DecisionLogRepair {
    /** Chat answers agents recorded as `answered`, now `acknowledged`. */
    acknowledged: string[];
    /** `drafted` rows with nothing staged, now `open`. */
    reopened: string[];
}

/**
 * Repairs two shapes old code left in the log; `apply: false` only reports them.
 * - A chat answer an agent recorded as `answered` (no delivery, not answered in the inbox, `awaitsDelivery` false):
 *   it read as "waiting to send" with Send again, and a whole-session send typed it back into the session. It moves
 *   to `acknowledged` with its option and answer, `answeredVia: agent`, and a comment.
 * - A `drafted` row with nothing staged: back to `open`.
 * Nothing else changes, and every move is an event.
 */
export async function repairDecisionLog({
    file,
    events,
    apply,
    now = () => new Date().toISOString(),
}: {
    file: string;
    events: string;
    apply: boolean;
    now?: () => string;
}): Promise<DecisionLogRepair> {
    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const ts = now();
        const repair: DecisionLogRepair = { acknowledged: [], reopened: [] };
        const next = rows.map((row): DecisionRecord => {
            if (kindOf(row) !== "decision") {
                return row;
            }

            const chatAnswer =
                row.state === "answered" &&
                !awaitsDelivery(row) &&
                !promptReserved(row) &&
                (Boolean(row.option) || Boolean(row.answer?.trim()));

            if (chatAnswer) {
                repair.acknowledged.push(row.id);
                return {
                    ...row,
                    state: "acknowledged",
                    answeredVia: row.answeredVia ?? "agent",
                    answeredTs: row.answeredTs ?? row.updatedTs,
                    updatedTs: ts,
                    comments: [
                        ...(row.comments ?? []),
                        "Repaired: an agent recorded this chat answer as answered, which read as waiting to be sent. It is acknowledged; nothing sends it again.",
                    ],
                };
            }

            if (row.state === "drafted" && !row.draftOption && !row.draft?.trim()) {
                repair.reopened.push(row.id);
                const reopened: DecisionRecord = { ...row, state: "open", updatedTs: ts };
                delete reopened.draft;
                delete reopened.draftOption;
                return reopened;
            }

            return row;
        });

        if (apply && repair.acknowledged.length + repair.reopened.length > 0) {
            rewrite(file, next);

            for (const id of repair.acknowledged) {
                appendEvent(events, { ev: "repaired", id, ts, state: "acknowledged" });
            }

            for (const id of repair.reopened) {
                appendEvent(events, { ev: "repaired", id, ts, state: "open" });
            }
        }

        return repair;
    });
}

/**
 * The refusal for a write made on text the agent has since re-posted (`expectedRevision`), in the words every surface
 * shows: the widget's stage, the hub's and the sidebar's draft, an inbox answer. It used to read "stale decision
 * revision: d_…", which the widget showed as it was.
 */
export function staleRevisionError(number: number): Error {
    return new Error(
        `DECISION ${number} changed: the agent posted a new text since you read it. Read it again and pick again.`
    );
}

/** Throws unless `target` names another stored decision and `next` is (becoming) superseded. */
function checkSupersededBy(
    row: DecisionRecord,
    next: DecisionRecord,
    target: string,
    stored: ReadonlyMap<string, DecisionRecord>
): void {
    if (next.state !== "superseded") {
        throw new Error(`${row.id}: supersededBy goes with state superseded`);
    }

    if (target === row.id) {
        throw new Error(`${row.id} cannot be superseded by itself`);
    }

    const replacement = stored.get(target);
    if (!replacement || kindOf(replacement) !== "decision") {
        throw new Error(`${row.id}: supersededBy names no stored decision (${target}); post the new decision first`);
    }
}

/** Moves one decision. The patch is validated first, and unknown keys are dropped. */
export async function updateDecision(
    file: string,
    events: string,
    id: string,
    payload: unknown,
    now = () => new Date().toISOString(),
    { actor = "user" }: { actor?: DecisionActor } = {}
): Promise<DecisionRecord> {
    const patch = parseDecisionInput(decisionPatchSchema, payload, "decision update");
    const [row] = await applyUpdates({ file, events, updates: [{ ...patch, id }], now, actor });

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
    now = () => new Date().toISOString(),
    { actor = "user" }: { actor?: DecisionActor } = {}
): Promise<DecisionRecord[]> {
    const { updates } = parseDecisionInput(decisionBatchUpdateSchema, payload, "question update");
    return applyUpdates({ file, events, updates, now, actor });
}

export interface TodoUpdateSnapshot {
    revision: number;
    state: DecisionState;
    updatedTs: string;
    sessionId: string;
    provider: string;
}

/** An explicit local TODO action against the exact version and state the user saw. */
export async function updateTodo({
    file,
    events,
    id,
    state,
    expected,
    signal,
    now = () => new Date().toISOString(),
}: {
    file: string;
    events: string;
    id: string;
    state: "acknowledged" | "implemented" | "dismissed" | "open";
    expected: TodoUpdateSnapshot;
    signal?: AbortSignal;
    now?: () => string;
}): Promise<DecisionRecord> {
    const patch = parseDecisionInput(
        decisionPatchSchema,
        { state, expectedRevision: expected.revision },
        "todo update"
    );
    const [row] = await applyUpdates({
        file,
        events,
        updates: [{ ...patch, id }],
        signal,
        now: () => laterThan(expected.updatedTs, now),
        beforeUpdate: (current) => checkShownTodo(current, expected),
    });
    if (!row) {
        throw new Error(`no todo ${id}`);
    }
    return row;
}

/** A stamp after `previous`, so a change is always newer than the version the user saw. */
function laterThan(previous: string, now: () => string): string {
    const requested = Date.parse(now());
    const shown = Date.parse(previous);
    return new Date(Math.max(requested, Number.isFinite(shown) ? shown + 1 : requested)).toISOString();
}

/** Throws unless `current` is still the TODO, source and version the user acted on. */
function checkShownTodo(current: DecisionRecord, expected: TodoUpdateSnapshot): void {
    if (
        kindOf(current) !== "todo" ||
        current.sessionId !== expected.sessionId ||
        (providerName(current.provider) ?? "unknown") !== expected.provider
    ) {
        throw new Error("This task belongs to a different source or is not a TODO");
    }

    if (current.state !== expected.state || current.updatedTs !== expected.updatedTs) {
        throw new Error("This task changed since it was shown. Refresh before trying again.");
    }
}

export interface NewTodo {
    title: string;
    /** The longer text; the title alone when absent. */
    details?: string;
    sessionId: string;
    provider?: string;
    sessionTitle?: string;
    project?: string;
    cwd?: string;
}

/**
 * A TODO the user writes by hand (the widget's Tasks module). Unlike `postDecisions` it never reads the
 * calling harness: the process that runs it is the app, and the session is the one the user picked.
 */
export async function createTodo({
    file,
    events,
    todo,
    signal,
    now = () => new Date().toISOString(),
}: {
    file: string;
    events: string;
    todo: NewTodo;
    signal?: AbortSignal;
    now?: () => string;
}): Promise<DecisionRecord> {
    const title = todo.title.trim();
    const details = todo.details?.trim();
    // Trimmed once and used everywhere: " fixture" must number on with the session "fixture", not start at 1.
    const sessionId = todo.sessionId.trim();
    if (!title || !sessionId) {
        throw new Error("A task needs a title and a session");
    }

    signal?.throwIfAborted();
    const provider = providerName(todo.provider);
    return withDecisionsLock(file, () => {
        signal?.throwIfAborted();
        const used = sessionNumbers(readDecisions(file), sessionId).todo;
        const number = used.size === 0 ? 1 : Math.max(...used) + 1;
        const ts = now();
        const row: DecisionRecord = {
            id: `${ID_PREFIX.todo}_${number}_${sessionId}`,
            sessionId,
            type: "todo",
            number,
            prompt: details || title,
            options: [],
            ...(details ? { title } : {}),
            ...(provider ? { provider } : {}),
            ...(todo.sessionTitle ? { sessionTitle: todo.sessionTitle } : {}),
            ...(todo.project ? { project: todo.project } : {}),
            ...(todo.cwd ? { cwd: todo.cwd } : {}),
            state: "open",
            revision: 1,
            createdTs: ts,
            updatedTs: ts,
        };
        append(file, row);
        appendEvent(events, { ev: "created", id: row.id, ts });
        return row;
    });
}

/**
 * Changes an open TODO's title and text, keeping the earlier text as a prior version, the same way a
 * superseding post does. Only an open TODO can change: a taken or finished one keeps what was agreed.
 */
export async function reviseTodo({
    file,
    events,
    id,
    title,
    details,
    expected,
    signal,
    now = () => new Date().toISOString(),
    beforeRevise,
}: {
    file: string;
    events: string;
    id: string;
    title: string;
    details?: string;
    expected: TodoUpdateSnapshot;
    signal?: AbortSignal;
    now?: () => string;
    /** Throws to refuse the edit, seeing the stored row under the ledger lock (a caller's own limits). */
    beforeRevise?: (row: DecisionRecord) => void;
}): Promise<DecisionRecord> {
    const nextTitle = title.trim();
    const nextDetails = details?.trim();
    if (!nextTitle) {
        throw new Error("A task needs a title");
    }

    signal?.throwIfAborted();
    return withDecisionsLock(file, () => {
        signal?.throwIfAborted();
        const rows = readDecisions(file);
        const row = rows.find((entry) => entry.id === id);
        if (!row) {
            throw new Error(`no todo ${id}`);
        }

        checkShownTodo(row, expected);
        if ((row.revision ?? 1) !== expected.revision) {
            throw new Error("This task changed since it was shown. Refresh before trying again.");
        }

        if (!SUPERSEDABLE.has(row.state)) {
            throw new Error(`Only an open task can be edited; reopen ${row.id} first`);
        }

        beforeRevise?.(row);
        const ts = laterThan(expected.updatedTs, now);
        const next: DecisionRecord = {
            ...row,
            prompt: nextDetails || nextTitle,
            revision: (row.revision ?? 1) + 1,
            versions: [...(row.versions ?? []), versionOf(row, ts)],
            revisedTs: ts,
            updatedTs: ts,
        };
        if (nextDetails) {
            next.title = nextTitle;
        } else {
            delete next.title;
        }

        signal?.throwIfAborted();
        rewrite(
            file,
            rows.map((entry) => (entry.id === id ? next : entry))
        );
        appendEvent(events, { ev: "superseded", id, ts, revision: next.revision });
        return next;
    });
}

function applyUpdates({
    file,
    events,
    updates,
    now,
    signal,
    beforeUpdate,
    answeredVia,
    actor = "user",
}: {
    file: string;
    events: string;
    updates: DecisionUpdate[];
    now: () => string;
    signal?: AbortSignal;
    beforeUpdate?: (row: DecisionRecord) => void;
    /** Who recorded a chat answer, in place of `agent`; never reachable from `question_update`. */
    answeredVia?: AnsweredVia;
    /** `agent` updates never queue or send an answer (`agentPatch`); see `DecisionActor`. */
    actor?: DecisionActor;
}): Promise<DecisionRecord[]> {
    signal?.throwIfAborted();
    // Decisions this write moved out of waiting: their banners go once the write is done (`retractDecisionBanners`).
    let closed: string[] = [];
    const written = withDecisionsLock(file, () => {
        signal?.throwIfAborted();
        const rows = readDecisions(file);
        const byId = new Map(rows.map((row) => [row.id, row]));
        const before = new Map(byId);
        const ts = now();

        for (const { id, ...patch } of updates) {
            const row = byId.get(id);

            if (!row) {
                throw new Error(`no decision ${id}`);
            }

            beforeUpdate?.(row);
            const next = patched(row, actor === "agent" ? agentPatch(row, patch) : patch, ts, byId);

            if (answeredVia && next.answeredVia === "agent") {
                next.answeredVia = answeredVia;
            }

            byId.set(id, next);
        }

        signal?.throwIfAborted();
        const changed = new Set(updates.map((update) => update.id));
        rewrite(
            file,
            rows.map((row) => byId.get(row.id) ?? row)
        );

        const result = [...changed].map((id) => byId.get(id)).filter((row): row is DecisionRecord => Boolean(row));

        for (const row of result) {
            appendEvent(events, { ev: "updated", id: row.id, ts, state: row.state });
        }

        closed = result
            .filter((row) => SUPERSEDABLE.has(before.get(row.id)?.state ?? "open") && !SUPERSEDABLE.has(row.state))
            .map((row) => row.id);
        return result;
    });

    return written.then((result) => {
        retractDecisionBanners(closed);
        return result;
    });
}

/** An answer the decision Stop hook read from the chat (`chatAnswers`), to record without the agent. */
export interface ChatAnswerRecord {
    id: string;
    /** The revision whose prompt and options the transcript answer was matched against. */
    expectedRevision: number;
    option?: string;
    /** The user's words beside the letters, or the whole answer when it names no letter. */
    answer: string;
    /** The user's line the answer was read from; kept as a comment, so the hub shows where it came from. */
    evidence: { text: string; timestamp?: string };
}

class MovedOn extends Error {}

/**
 * Records answers the user typed in the chat, found by a heuristic (`answeredVia: "automatic_heuristic"`). Each
 * decision moves from open or drafted to acknowledged, as an agent's own `question_update` of a chat answer does, so
 * nothing is delivered again. One transition per answer: a decision that moved on meanwhile (answered in the hub,
 * recorded by the agent) stays as it is and is not returned.
 */
export async function recordChatAnswers({
    file,
    events,
    answers,
    now = () => new Date().toISOString(),
}: {
    file: string;
    events: string;
    answers: ChatAnswerRecord[];
    now?: () => string;
}): Promise<DecisionRecord[]> {
    const recorded: DecisionRecord[] = [];

    for (const item of answers) {
        // The hub shows comments as written, so the time is local, never the transcript's UTC stamp.
        const when = item.evidence.timestamp
            ? ` (${formatLocalDateTimeStamp(item.evidence.timestamp, { seconds: false })})`
            : "";

        try {
            const [row] = await applyUpdates({
                file,
                events,
                updates: [
                    {
                        id: item.id,
                        expectedRevision: item.expectedRevision,
                        state: "acknowledged",
                        ...(item.option ? { option: item.option } : {}),
                        ...(item.answer ? { answer: item.answer } : {}),
                        comment: `Read from the chat by the decision Stop hook: "${item.evidence.text}"${when}`,
                    },
                ],
                now,
                answeredVia: "automatic_heuristic",
                beforeUpdate: (current) => {
                    if (!SUPERSEDABLE.has(current.state)) {
                        throw new MovedOn(`${current.id} is ${current.state}`);
                    }
                },
            });

            if (row) {
                recorded.push(row);
            }
        } catch (error) {
            if (error instanceof MovedOn) {
                logger.debug({ id: item.id, reason: error.message }, "[decisions] chat answer not recorded: moved on");
                continue;
            }

            logger.warn({ error, id: item.id }, "[decisions] chat answer not recorded");
        }
    }

    return recorded;
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
 * (`sent`, or back to `answered` when queued). A later send overwrites the record, except that a row
 * reserved by a queued message keeps its `queueId`: dropping it would let the next prompt deliver the
 * answer a second time while the queue consumer delivers it too.
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
        const stampedIds: string[] = [];
        rewrite(
            file,
            readDecisions(file).map((row) => {
                const reservedElsewhere =
                    row.delivery?.queueId !== undefined && row.delivery.queueId !== delivery.queueId;

                if (!wanted.has(row.id) || reservedElsewhere) {
                    return row;
                }

                stampedIds.push(row.id);
                return { ...row, delivery: stamped };
            })
        );

        for (const id of stampedIds) {
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
export async function restoreUndelivered({
    file,
    events,
    ids,
    delivery,
    now = () => new Date().toISOString(),
}: {
    file: string;
    events: string;
    ids: string[];
    delivery?: Omit<DecisionDelivery, "at">;
    now?: () => string;
}): Promise<void> {
    const wanted = new Set(ids);

    await withDecisionsLock(file, () => {
        const ts = now();
        const rows = readDecisions(file);
        const restored = rows.map((row) =>
            wanted.has(row.id) && row.state === "sent"
                ? {
                      ...row,
                      state: "answered" as const,
                      updatedTs: ts,
                      ...(delivery ? { delivery: { ...delivery, at: ts } } : {}),
                  }
                : row
        );
        rewrite(file, restored);

        for (const row of restored) {
            if (wanted.has(row.id) && row.updatedTs === ts) {
                appendEvent(events, { ev: "send_failed", id: row.id, ts, state: "answered" });
            }
        }
    });
}

/** Reconcile only the exact answer revision reserved by this queue message. */
export async function reconcileQueuedDecision({
    file,
    events,
    id,
    session,
    revision,
    queueId,
    received,
    consumer,
}: {
    file: string;
    events: string;
    id: string;
    session: string;
    revision: number;
    queueId: string;
    received: boolean;
    consumer?: string;
}): Promise<boolean> {
    return withDecisionsLock(file, () => {
        const rows = readDecisions(file);
        const row = rows.find((entry) => entry.id === id);
        if (!row || row.sessionId !== session || (row.revision ?? 1) !== revision) {
            return false;
        }
        if (!received && row.state === "open" && !row.delivery?.queueId) {
            return true;
        }
        if (row.delivery?.queueId !== queueId || !["answered", "sent"].includes(row.state)) {
            return false;
        }
        if (received && row.state === "sent") {
            return true;
        }
        const ts = new Date().toISOString();
        row.state = received ? "sent" : "open";
        row.updatedTs = ts;
        if (received) {
            row.delivery = {
                route: "queued",
                queueId,
                at: ts,
                target: `Received by ${consumer ?? "session consumer"}`,
            };
        } else {
            delete row.delivery;
            delete row.answer;
            delete row.option;
            delete row.answeredVia;
            delete row.answeredTs;
        }
        rewrite(file, rows);
        appendEvent(events, { ev: received ? "sent" : "queue_cancelled", id, ts, state: row.state });
        return true;
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
            if (promptReserved(row)) {
                throw new Error(`Decision ${row.id} is reserved by a submitted prompt; wait for its acknowledgement.`);
            }
            if (state === "sent" && row.delivery?.queueId) {
                throw new Error(
                    `Decision ${row.id} is reserved by a queued message; wait for its consumer acknowledgement.`
                );
            }
            if (!canMove(row, state)) {
                throw new Error(`cannot move ${row.id} from ${row.state} to ${state}`);
            }
        }

        const ts = now();
        const moved = new Map(
            moving.map((row) => {
                const next = { ...row, state, updatedTs: ts };
                delete next.promptReservation;
                return [row.id, next] as const;
            })
        );
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
    return readDecisionsWithIntegrity(file).rows;
}

/** The same decision read, including whether the file was missing or any torn or invalid row was skipped. */
export function readDecisionsWithIntegrity(file: string): { rows: DecisionRecord[]; complete: boolean } {
    const { rows, skipped, missing } = readJsonlRows<unknown>(file);
    const valid = rows.filter(isStoredDecision);
    const malformed = rows.length - valid.length;

    if (skipped > 0 || malformed > 0) {
        logger.warn({ file, skipped, malformed }, "[decisions] skipped unreadable lines in the decision log");
    }

    return { rows: valid, complete: !missing && skipped === 0 && malformed === 0 };
}

function isStoredDecision(value: unknown): value is DecisionRecord {
    return storedDecisionSchema.safeParse(value).success;
}

/** The test {@link readDecisions} applies to one line: it parses as strict JSON and has a decision's shape. */
function isReadableDecisionLine(line: string): boolean {
    try {
        return isStoredDecision(SafeJSON.parse(line, { strict: true }));
    } catch {
        // Not an error here: the line is one readDecisions skips and warns about, and the caller keeps it.
        return false;
    }
}

/** The raw lines {@link readDecisions} skips (torn, unparseable or the wrong shape), in file order. */
function unreadableLines(file: string): string[] {
    let text: string;

    try {
        text = readFileSync(file, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }

        throw error;
    }

    return text.split("\n").filter((line) => line.trim().length > 0 && !isReadableDecisionLine(line));
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

    const path = isAbsolute(ref.path) ? ref.path : resolve(cwd ?? callerCwd(), ref.path);

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

/**
 * Atomic, so a reader never catches a half-written log. The rows come from {@link readDecisions}, which skips
 * the lines it cannot read; those lines are carried over verbatim at the top, or the rewrite would delete them
 * for good. Every caller holds the decisions lock, so the file has not changed since that read.
 */
function rewrite(file: string, rows: DecisionRecord[]): void {
    const lines = [...unreadableLines(file), ...rows.map((row) => SafeJSON.stringify(row))];
    atomicWriteFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}
