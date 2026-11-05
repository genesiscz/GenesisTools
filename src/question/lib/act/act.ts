import { logger } from "@genesiscz/utils/logger";
import { type AnswerRefusalCode, AnswerRefusedError } from "../decisions/answers";
import { awaitsAnswer, type DecisionRecord } from "../decisions/store";
import type { AnswerDecisionInput, InboxAnswerResult } from "../inbox/answer";
import type { ActTokenStore } from "./tokens";

const log = logger.child({ component: "question:act" });

/** Why an act was refused. One code per reason, the same for every surface (Telegram, banner, phone). */
export type ActRefusalCode =
    /** No stored token has this value (never issued, or dropped after it expired). */
    | "unknown-token"
    /** The token is past its expiry. */
    | "expired"
    /** The decision was answered, dismissed or superseded already. */
    | "closed"
    /** The agent posted a new text since the button was shown. */
    | "changed"
    /** The answer itself was refused (a letter past the options, an empty answer). */
    | "invalid";

/** The closed outcome of one act. */
export type ActOutcome =
    | { kind: "delivered"; detail?: string }
    /** Stored as answered; it goes with the session's next prompt. */
    | { kind: "queued"; detail?: string }
    /** It may have arrived; nothing can confirm it. */
    | { kind: "uncertain"; detail?: string }
    | { kind: "refused"; code: ActRefusalCode; detail: string };

export interface ActReceipt {
    key: string;
    outcome: ActOutcome;
    /** The decision and letter the token stood for, when it was known. */
    decision?: { id: string; session: string; number: number; option: string };
    at: number;
}

export interface ActDeps {
    store: ActTokenStore;
    /** The answer door (`answerInboxDecision` with the real decision files). Tests pass a fake. */
    answer: (input: AnswerDecisionInput) => Promise<InboxAnswerResult>;
    /** The stored decision rows, for the closed check before any answer is attempted. */
    rows: () => DecisionRecord[];
}

const REFUSAL_OF: Record<AnswerRefusalCode, ActRefusalCode> = {
    empty: "invalid",
    "option-shape": "invalid",
    "option-range": "invalid",
    "stale-revision": "changed",
    "changed-elsewhere": "changed",
    "not-waiting": "closed",
    "already-answered": "closed",
};

function outcomeOf(result: InboxAnswerResult): ActOutcome {
    const detail = result.detail;

    if (result.uncertain) {
        return { kind: "uncertain", ...(detail ? { detail } : {}) };
    }

    if (result.delivered) {
        return { kind: "delivered", ...(detail ? { detail } : {}) };
    }

    return { kind: "queued", ...(detail ? { detail } : {}) };
}

type Claim =
    | { kind: "done"; receipt: ActReceipt }
    | {
          kind: "go";
          decision: NonNullable<ActReceipt["decision"]>;
          revision?: number;
          provider?: string;
          reply: boolean;
      };

/**
 * The one door that answers a decision from a stored token. The Telegram button, the Mac banner button and the phone
 * are its callers. `key` is the caller's idempotency key (the Telegram callback id, the phone's request id): a second
 * act with the same key returns the first receipt and answers nothing again, and the key goes to the delivery as its
 * `deliveryKey`, so a queued message is not queued twice either.
 */
export async function act({
    token,
    key,
    deps,
    text,
    now = Date.now(),
}: {
    token: string;
    key: string;
    deps: ActDeps;
    /** The answer of a reply token (the notification's Reply field); a letter token ignores it. */
    text?: string;
    now?: number;
}): Promise<ActReceipt> {
    const refuse = (code: ActRefusalCode, detail: string, decision?: ActReceipt["decision"]): ActReceipt => ({
        key,
        outcome: { kind: "refused", code, detail },
        ...(decision ? { decision } : {}),
        at: now,
    });

    // A read first: the act route is public, so an unknown token must cost no lock and no write. A known token is
    // checked again under the lock below.
    if (!(await deps.store.has(token))) {
        return refuse("unknown-token", "This button is not known; answer in the hub.");
    }

    const claim = await deps.store.update((tokens): Claim => {
        const record = tokens[token];

        if (!record) {
            return { kind: "done", receipt: refuse("unknown-token", "This button is not known; answer in the hub.") };
        }

        const decision = {
            id: record.decisionId,
            session: record.session,
            number: record.number,
            option: record.option,
        };
        const earlier = record.receipts[key];

        if (earlier && "outcome" in earlier) {
            return { kind: "done", receipt: earlier };
        }

        if (earlier) {
            return {
                kind: "done",
                receipt: {
                    key,
                    outcome: { kind: "uncertain", detail: "this answer is still being sent" },
                    decision,
                    at: now,
                },
            };
        }

        if (record.expiresAt <= now) {
            const receipt = refuse("expired", "This button expired; answer in the hub.", decision);
            record.receipts[key] = receipt;
            return { kind: "done", receipt };
        }

        if (record.reply && !text?.trim()) {
            return { kind: "done", receipt: refuse("invalid", "A reply needs text.", decision) };
        }

        record.receipts[key] = { pending: true, at: now };
        return {
            kind: "go",
            decision,
            revision: record.revision,
            provider: record.provider,
            reply: record.reply === true,
        };
    });

    if (claim.kind === "done") {
        return claim.receipt;
    }

    const { decision } = claim;
    const row = deps.rows().find((entry) => entry.id === decision.id);
    let receipt: ActReceipt;

    if (row && !awaitsAnswer(row)) {
        receipt = refuse("closed", `DECISION ${decision.number} is ${row.state} already.`, decision);
    } else {
        try {
            const result = await deps.answer({
                session: decision.session,
                number: decision.number,
                ...(claim.reply ? { text: text?.trim() } : { option: decision.option }),
                ...(claim.revision === undefined ? {} : { expectedRevision: claim.revision }),
                ...(claim.provider ? { provider: claim.provider } : {}),
                deliveryKey: key,
            });
            receipt = { key, outcome: outcomeOf(result), decision, at: now };
        } catch (err) {
            if (err instanceof AnswerRefusedError) {
                receipt = refuse(REFUSAL_OF[err.code], err.message, decision);
            } else {
                // The answer may be stored and on its way: never report it as refused, and never send it twice.
                log.warn({ err, decision }, "an act failed after its claim");
                receipt = {
                    key,
                    outcome: { kind: "uncertain", detail: err instanceof Error ? err.message : String(err) },
                    decision,
                    at: now,
                };
            }
        }
    }

    await deps.store.update((tokens) => {
        const record = tokens[token];

        if (record) {
            record.receipts[key] = receipt;
        }
    });

    return receipt;
}

/** The real dependencies: the token file, the decision log and the inbox answer door. */
export async function realActDeps(): Promise<ActDeps> {
    const [{ decisionFiles }, { readDecisions }, { waitingBlock }, { answerInboxDecision }, { fileActTokenStore }] =
        await Promise.all([
            import("../decisions/paths"),
            import("../decisions/store"),
            import("../inbox/load"),
            import("../inbox/answer"),
            import("./tokens"),
        ]);
    const files = decisionFiles();

    return {
        store: fileActTokenStore(),
        rows: () => readDecisions(files.file),
        answer: (input) => answerInboxDecision(input, { ...files, block: waitingBlock }),
    };
}
