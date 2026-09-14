import type { Database } from "bun:sqlite";
import { buildQaDeepLink } from "@app/dev-dashboard/lib/qa-deep-link";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { loadConfig } from "../config";
import { recordAnswer } from "../record";
import type { RecordResult } from "../types";
import { appendPendingEvent } from "./events";
import { createAskForm, missingRequiredItems, sanitizeAnswer } from "./form";
import { renderFormAnswer, renderFormQuestion, summarizeForm } from "./render";
import {
    claimForm,
    expireDueForms,
    getForm,
    getForms,
    insertForm,
    listForms,
    markAnswered,
    markCancelled,
    openPendingStore,
    releaseClaim,
} from "./store";
import {
    type AskAnswer,
    type AskForm,
    type CreateAskFormInput,
    DEFAULT_WAIT_BUDGET_MS,
    MAX_WAIT_BUDGET_MS,
    type WaiterStatus,
} from "./types";

const log = logger.child({ component: "question:ask" });

/**
 * Publish a lifecycle event, best effort.
 *
 * The JSONL append is synchronous filesystem I/O and happens AFTER the row is already
 * committed. Letting it throw would report failure for a form that exists, and would lose the
 * event as well. Every client reconciles from the REST snapshot, so a dropped frame costs a
 * refresh, while a thrown error costs the caller its question.
 */
function publishEvent(kind: Parameters<typeof appendPendingEvent>[0], form: AskForm, deps: AskDeps): void {
    try {
        appendPendingEvent(kind, form, deps.eventBase);
    } catch (err) {
        log.warn({ err, id: form.id, kind }, "could not publish a pending lifecycle event; the form itself is fine");
    }
}

/** How often a waiter re-reads the row. Waiters and answerers are separate processes. */
const WAIT_POLL_MS = 250;

export interface AskDeps {
    /** Injected by tests; production opens the shared `qa.db`. */
    db?: Database;
    dbPath?: string;
    eventBase?: string;
    logBase?: string;
    /** Off in tests so no banner fires. */
    notify?: boolean;
}

function withStore<T>(deps: AskDeps, fn: (db: Database) => T): T {
    if (deps.db) {
        return fn(deps.db);
    }

    const db = openPendingStore(deps.dbPath);

    try {
        return fn(db);
    } finally {
        // bun:sqlite has no GC finalizer — an unclosed handle leaks an FD per call.
        db.close();
    }
}

/** Retire overdue forms and publish their timeout events before any read answers. */
function sweep(db: Database, deps: AskDeps): void {
    for (const expired of expireDueForms(db)) {
        publishEvent("timeout", expired, deps);
    }
}

/**
 * Create a pending form and tell the user about it.
 *
 * The notification is NOT gated on `sinks.notify`: that flag governs the after-the-fact Q→A
 * firehose, while a pending form means an agent is blocked until Martin answers. Silence
 * there is a hang, so it is opt-OUT (`notifyPending`) rather than opt-in.
 */
export async function postAskForm(input: CreateAskFormInput, deps: AskDeps = {}): Promise<AskForm> {
    const form = createAskForm(input);
    withStore(deps, (db) => insertForm(db, form));
    publishEvent("created", form, deps);
    log.info({ id: form.id, items: form.items.length, source: form.source }, "pending ask form created");

    const wantsNotify = deps.notify ?? loadConfig().sinks.notifyPending !== false;

    if (wantsNotify) {
        try {
            await dispatchNotification({
                app: "question",
                title: "A question is waiting for you",
                message: summarizeForm(form),
                open: await buildQaDeepLink(form.id),
            });
        } catch (err) {
            // The form is already persisted, so a banner that cannot be delivered must never
            // lose the question. It is still visible on /qa and to every poller. The host-effect
            // guard under `bun test` throws here, and so can a misconfigured notify channel.
            log.warn({ err, id: form.id }, "could not notify about a new pending form; the form itself is fine");
        }
    }

    return form;
}

export function listPendingForms(deps: AskDeps = {}, limit = 50): AskForm[] {
    return withStore(deps, (db) => {
        sweep(db, deps);

        return listForms(db, { status: "pending", limit });
    });
}

export function pollAskForms(ids: string[], deps: AskDeps = {}): Record<string, AskForm | null> {
    return withStore(deps, (db) => {
        sweep(db, deps);

        return getForms(db, ids);
    });
}

export function getAskForm(id: string, deps: AskDeps = {}): AskForm | null {
    return withStore(deps, (db) => {
        sweep(db, deps);

        return getForm(db, id);
    });
}

export type AnswerOutcome =
    | { ok: true; form: AskForm; entryId: string }
    | { ok: false; code: "not_found" | "not_pending" | "incomplete"; error: string; missing?: string[] };

/**
 * Claim the form, record the answer, then write the matching QaEntry so /qa history stays ONE
 * list.
 *
 * The claim comes FIRST and is exclusive, so only one submit ever reaches `recordAnswer`: a
 * loser is turned away before it can write a QaEntry that no form would ever point at. Two
 * concurrent answers, and a cancel racing an answer, used to produce exactly that orphan.
 *
 * Inside the claim the QaEntry is still written BEFORE the row flips to `answered`, so its id
 * can be stored on the form. A crash between the two leaves an orphan history entry, which is
 * recoverable; the reverse would leave an answered form that never reached history, which is
 * not. The claim itself is a lease (`ANSWER_CLAIM_TTL_MS`), so that crash costs one stale claim
 * rather than a form nobody can ever answer.
 */
export async function answerAskForm(id: string, answers: AskAnswer[], deps: AskDeps = {}): Promise<AnswerOutcome> {
    const form = getAskForm(id, deps);

    if (!form) {
        return { ok: false, code: "not_found", error: `unknown form: ${id}` };
    }

    if (form.status !== "pending") {
        return { ok: false, code: "not_pending", error: `form ${id} is already ${form.status}` };
    }

    const sanitized: Record<string, AskAnswer> = {};
    // A door hands this straight through from JSON, so `answers` can be any shape at all. A
    // non-array used to throw out of the `for…of` and a null entry out of `.itemId`, which the
    // HTTP door then reported as a 500 — a server fault for what is a malformed request. Dropping
    // the junk lets the required-item check below answer it as `incomplete` instead, naming what
    // is still missing.
    const submitted = Array.isArray(answers) ? answers : [];

    for (const answer of submitted) {
        if (!answer || typeof answer.itemId !== "string") {
            continue;
        }

        if (form.items.some((item) => item.id === answer.itemId)) {
            sanitized[answer.itemId] = sanitizeAnswer(answer, form);
        }
    }

    const missing = missingRequiredItems(form, sanitized);

    if (missing.length > 0) {
        return {
            ok: false,
            code: "incomplete",
            error: `${missing.length} required question(s) still unanswered`,
            missing: missing.map((item) => item.id),
        };
    }

    // Everything above is a pure read, so a malformed submit never costs a claim. Everything
    // below is durable, so it happens exactly once per form.
    const claim = withStore(deps, (db) => claimForm(db, id));

    if (!claim) {
        return {
            ok: false,
            code: "not_pending",
            error: `form ${id} is already being answered, or was resolved by someone else`,
        };
    }

    let recorded: RecordResult;

    try {
        recorded = await recordAnswer(
            {
                question: renderFormQuestion(form),
                answer: renderFormAnswer(form, sanitized),
                tag: "question",
                source: "ask",
                sessionId: form.sessionHint,
            },
            { logBase: deps.logBase }
        );
    } catch (err) {
        // Nothing was recorded, so nothing is orphaned — but the claim would otherwise hold the
        // form for its whole lease over a failure that is already known here.
        withStore(deps, (db) => releaseClaim(db, id, claim.claimedAt));
        throw err;
    }

    const answered = withStore(deps, (db) =>
        markAnswered(db, { id, answers: sanitized, entryId: recorded.id, claimedAt: claim.claimedAt })
    );

    if (!answered) {
        // Only reachable when this answer outlived its own lease and another one took over, so
        // the entry above belongs to no form. Name it, because nothing else will.
        log.warn(
            { id, entryId: recorded.id },
            "the answer lease expired during the history write; that entry has no form"
        );

        return { ok: false, code: "not_pending", error: `form ${id} was resolved by someone else` };
    }

    publishEvent("answered", answered, deps);
    log.info({ id, entryId: recorded.id }, "pending ask form answered");

    return { ok: true, form: answered, entryId: recorded.id };
}

export function cancelAskForm(id: string, deps: AskDeps = {}): AskForm | null {
    const cancelled = withStore(deps, (db) => {
        sweep(db, deps);

        return markCancelled(db, id);
    });

    if (cancelled) {
        publishEvent("cancelled", cancelled, deps);
        log.info({ id }, "pending ask form cancelled");
    }

    return cancelled;
}

/**
 * Why a cancel was refused. `being_answered` is worth a RETRY; the other two are terminal.
 */
export type CancelRefusal =
    | { code: "not_found"; message: string }
    | { code: "being_answered"; message: string; form: AskForm }
    | { code: "already_resolved"; message: string; form: AskForm };

/**
 * Name the reason `cancelAskForm` returned null, so every door reports the SAME one.
 *
 * `markCancelled` refuses a form an answer holds, and that leaves the form `pending` — which at
 * the call site is indistinguishable from an id no form carries. Only a re-read separates the
 * three cases, and it belongs here rather than in one door: a door that guesses has to print
 * "not found, or already resolved" for a form that exists and is seconds from being answered.
 */
export function explainCancelRefusal(id: string, deps: AskDeps = {}): CancelRefusal {
    const form = getAskForm(id, deps);

    if (!form) {
        return { code: "not_found", message: `unknown form: ${id}` };
    }

    if (form.status === "pending") {
        return { code: "being_answered", message: `form ${id} is being answered right now; poll it instead`, form };
    }

    return { code: "already_resolved", message: `form ${id} is already ${form.status}`, form };
}

export interface WaitResult {
    form: AskForm | null;
    waiter: WaiterStatus;
}

async function pollUntilResolved(id: string, deadline: number, deps: AskDeps): Promise<WaitResult> {
    for (;;) {
        const form = getAskForm(id, deps);

        if (!form) {
            return { form: null, waiter: "not_found" };
        }

        if (form.status !== "pending") {
            return { form, waiter: form.status };
        }

        if (Date.now() >= deadline) {
            log.debug({ id }, "wait budget exhausted while the form is still pending");

            return { form, waiter: "budget_exhausted" };
        }

        await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
}

/**
 * Block until the form leaves `pending`, or until this caller's own budget runs out.
 *
 * Polls the row rather than subscribing: the waiting agent and the answering dashboard are
 * different processes, so an in-memory emitter would only ever see its own writes.
 *
 * The connection is opened ONCE for the whole wait, not once per poll. `withStore` cannot do
 * that here: its `finally` fires when an async callback RETURNS its promise, not when that
 * promise settles, so it would close the handle before the first sleep. At 250ms a poll, a
 * default 120s wait used to open, migrate and close the store 480 times.
 */
export async function waitForAskForm(
    id: string,
    budgetMs: number = DEFAULT_WAIT_BUDGET_MS,
    deps: AskDeps = {}
): Promise<WaitResult> {
    // A non-finite budget makes every deadline test false and every sleep 0ms, which is an
    // unkillable hot loop. `--wait-timeout abc` parsed to NaN and did exactly that, so clamp
    // before the loop rather than inside it.
    const budget = Number.isFinite(budgetMs)
        ? Math.min(MAX_WAIT_BUDGET_MS, Math.max(0, budgetMs))
        : DEFAULT_WAIT_BUDGET_MS;
    const deadline = Date.now() + budget;

    if (deps.db) {
        return pollUntilResolved(id, deadline, deps);
    }

    const db = openPendingStore(deps.dbPath);

    try {
        return await pollUntilResolved(id, deadline, { ...deps, db });
    } finally {
        db.close();
    }
}
