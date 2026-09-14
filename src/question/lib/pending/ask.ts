import type { Database } from "bun:sqlite";
import { buildQaDeepLink } from "@app/dev-dashboard/lib/qa-deep-link";
import { logger } from "@genesiscz/utils/logger";
import { dispatchNotification } from "@genesiscz/utils/notifications";
import { loadConfig } from "../config";
import { recordAnswer } from "../record";
import { appendPendingEvent } from "./events";
import { createAskForm, missingRequiredItems, sanitizeAnswer } from "./form";
import { renderFormAnswer, renderFormQuestion, summarizeForm } from "./render";
import {
    expireDueForms,
    getForm,
    getForms,
    insertForm,
    listForms,
    markAnswered,
    markCancelled,
    openPendingStore,
} from "./store";
import {
    type AskAnswer,
    type AskForm,
    type CreateAskFormInput,
    DEFAULT_WAIT_BUDGET_MS,
    type WaiterStatus,
} from "./types";

const log = logger.child({ component: "question:ask" });

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
        appendPendingEvent("timeout", expired, deps.eventBase);
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
    appendPendingEvent("created", form, deps.eventBase);
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
 * Record an answer, then write the matching QaEntry so /qa history stays ONE list.
 *
 * The QaEntry is written BEFORE the row flips to `answered`, so its id can be stored on the
 * form. A crash between the two leaves an orphan history entry, which is recoverable; the
 * reverse would leave an answered form that never reached history, which is not.
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

    for (const answer of answers) {
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

    const recorded = await recordAnswer(
        {
            question: renderFormQuestion(form),
            answer: renderFormAnswer(form, sanitized),
            tag: "question",
            source: "ask",
            sessionId: form.sessionHint,
        },
        { logBase: deps.logBase }
    );

    const answered = withStore(deps, (db) => markAnswered(db, id, sanitized, recorded.id));

    if (!answered) {
        // Another submit won the race between the read above and this write.
        return { ok: false, code: "not_pending", error: `form ${id} was resolved by someone else` };
    }

    appendPendingEvent("answered", answered, deps.eventBase);
    log.info({ id, entryId: recorded.id }, "pending ask form answered");

    return { ok: true, form: answered, entryId: recorded.id };
}

export function cancelAskForm(id: string, deps: AskDeps = {}): AskForm | null {
    const cancelled = withStore(deps, (db) => {
        sweep(db, deps);

        return markCancelled(db, id);
    });

    if (cancelled) {
        appendPendingEvent("cancelled", cancelled, deps.eventBase);
        log.info({ id }, "pending ask form cancelled");
    }

    return cancelled;
}

export interface WaitResult {
    form: AskForm | null;
    waiter: WaiterStatus;
}

/**
 * Block until the form leaves `pending`, or until this caller's own budget runs out.
 *
 * Polls the row rather than subscribing: the waiting agent and the answering dashboard are
 * different processes, so an in-memory emitter would only ever see its own writes.
 */
export async function waitForAskForm(
    id: string,
    budgetMs: number = DEFAULT_WAIT_BUDGET_MS,
    deps: AskDeps = {}
): Promise<WaitResult> {
    const deadline = Date.now() + budgetMs;

    for (;;) {
        const form = getAskForm(id, deps);

        if (!form) {
            return { form: null, waiter: "budget_exhausted" };
        }

        if (form.status !== "pending") {
            return { form, waiter: form.status };
        }

        if (Date.now() >= deadline) {
            log.debug({ id, budgetMs }, "wait budget exhausted while the form is still pending");

            return { form, waiter: "budget_exhausted" };
        }

        await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
}
