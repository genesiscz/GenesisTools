import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { type AnswerRefusalCode, AnswerRefusedError } from "../decisions/answers";
import { decisionOptionLabels, takesSeveral } from "../decisions/option-labels";
import { awaitsAnswer, type DecisionRecord } from "../decisions/store";
import type { AnswerDecisionInput, InboxAnswerResult } from "../inbox/answer";
import type { DraftInput } from "../inbox/drafts";
import { type ActTokenKind, type ActTokenStore, tokenKind } from "./tokens";

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
    /**
     * The decision and the letters of the act, when they were known: the token's letter, the letters a send or a
     * lettered reply answered with, or the letter a toggle ticked or unticked.
     */
    decision?: { id: string; session: string; number: number; option: string };
    /** What the pressed token does; absent on a receipt stored before the kinds existed (an answer). */
    tokenKind?: ActTokenKind;
    at: number;
}

/**
 * The outcome of a button press (`press`): an act's outcome, or the staged pick a toggle left, its `option` the staged
 * letters now ("" when the last one went). `act` never stages, so its HTTP wire (`ActReceiptDto`) stays closed.
 */
export type PressOutcome = ActOutcome | { kind: "staged"; option: string; detail?: string };
export type PressReceipt = Omit<ActReceipt, "outcome"> & { outcome: PressOutcome };

export interface ActDeps {
    store: ActTokenStore;
    /** The answer door (`answerInboxDecision` with the real decision files). Tests pass a fake. */
    answer: (input: AnswerDecisionInput) => Promise<InboxAnswerResult>;
    /** The stored decision rows, for the closed check before any answer is attempted. */
    rows: () => DecisionRecord[];
    /**
     * The staging door (`draftDecision`): a toggle writes the decision's staged pick through it, the same pick the
     * widget and the hub show. The real deps carry it; a door built without it refuses a toggle.
     */
    stage?: (input: DraftInput) => Promise<Pick<DecisionRecord, "draftOption"> | undefined>;
    /**
     * Runs a toggle's read of the staged pick and its write as one step, so two presses at once (Telegram's webhook
     * delivers updates in parallel) both land: a press read before the other wrote would drop the other's letter. The
     * real deps take a file lock beside the decision log; a door built without it runs the step as it is.
     */
    exclusive?: <T>(step: () => Promise<T>) => Promise<T>;
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
    | { kind: "done"; receipt: PressReceipt }
    | {
          kind: "go";
          decision: NonNullable<ActReceipt["decision"]>;
          tokenKind: ActTokenKind;
          revision?: number;
          provider?: string;
          reply: boolean;
      };

/** The letters of a pick, each once, in letter order ("ca" and "a, c" are "ac"). */
function pickLetters(pick: string | undefined): string {
    return [...new Set((pick ?? "").toLowerCase().replace(/[^a-z]/g, ""))].sort().join("");
}

/** The staged letters with `letter` added, or taken out when it was there. */
export function toggledPick(staged: string | undefined, letter: string): string {
    const letters = pickLetters(staged);
    return letters.includes(letter) ? letters.replace(letter, "") : pickLetters(`${letters}${letter}`);
}

/** Letters with separators between them: "a d", "a, c", "a+c", "a and c", or a run like "ac". */
const LETTER_REPLY = /^[a-z](?:(?:\s*[,+&/]\s*|\s+and\s+|\s*)[a-z])*$/;

/**
 * The letters a reply to a decision that takes several letters names, or undefined when the reply is text. Every
 * letter must be one of the decision's `count` options and named once, and a run of letters without separators must
 * rise ("ac", "abd"), so a word ("bad", "yes", "add") stays text.
 */
export function replyLetters(text: string, count: number): string | undefined {
    const plain = text.trim().toLowerCase();

    if (!LETTER_REPLY.test(plain)) {
        return undefined;
    }

    const runs = plain
        .replace(/\s+and\s+/g, " ")
        .split(/[^a-z]+/)
        .filter(Boolean);
    const named = runs.join("");
    const rises = (run: string) => [...run].every((char, index) => index === 0 || char > (run[index - 1] ?? ""));
    const inRange = [...named].every((char) => char.charCodeAt(0) - 97 < count);

    if (!runs.every(rises) || new Set(named).size !== named.length || !inRange) {
        return undefined;
    }

    return pickLetters(named);
}

/**
 * How many options `row` shows and whether it takes any set of them (`takesSeveral`), read on the options it shows: a
 * row may keep its options only in its prompt. Every button surface asks this before it draws letters.
 */
export function decisionChoice(row: Pick<DecisionRecord, "prompt" | "options" | "multiple" | "recommended">): {
    several: boolean;
    count: number;
} {
    const options = decisionOptionLabels(row.prompt, row.options);
    return { several: takesSeveral({ ...row, options }), count: options.length };
}

interface ActInput {
    token: string;
    key: string;
    deps: ActDeps;
    /** The answer of a reply token (the notification's Reply field); a letter token ignores it. */
    text?: string;
    now?: number;
}

/**
 * The one door that answers a decision from a stored token. The Mac banner button, the phone and `tools question act`
 * are its callers, and the Telegram keyboard through `press`. `key` is the caller's idempotency key (the Telegram
 * callback id, the phone's request id): a second act with the same key returns the first receipt and answers nothing
 * again, and the key goes to the delivery as its `deliveryKey`, so a queued message is not queued twice either. A
 * toggle token is refused here: only the Telegram keyboard ticks letters.
 */
export async function act(input: ActInput): Promise<ActReceipt> {
    const receipt = await settle({ ...input, toggles: false });
    const { outcome } = receipt;

    // Unreachable: with toggles off a toggle token is refused before its stored receipts are read.
    if (outcome.kind === "staged") {
        return { ...receipt, outcome: { kind: "refused", code: "invalid", detail: TOGGLE_ONLY_IN_TELEGRAM } };
    }

    return { ...receipt, outcome };
}

/**
 * The door of a button press on the Telegram keyboard: `act`, and a toggle token of a decision that takes several
 * letters, whose receipt is the staged pick it left (`staged`). Idempotent per key like `act`, so Telegram's retry of a
 * toggle does not untick what the first delivery ticked.
 */
export function press(input: ActInput): Promise<PressReceipt> {
    return settle({ ...input, toggles: true });
}

const TOGGLE_ONLY_IN_TELEGRAM = "This button ticks a letter on the Telegram keyboard; answer in the hub.";

async function settle({
    token,
    key,
    deps,
    text,
    now = Date.now(),
    toggles,
}: ActInput & { toggles: boolean }): Promise<PressReceipt> {
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

        if (!toggles && tokenKind(record) === "toggle") {
            return { kind: "done", receipt: refuse("invalid", TOGGLE_ONLY_IN_TELEGRAM, decision) };
        }

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
            tokenKind: tokenKind(record),
            revision: record.revision,
            provider: record.provider,
            reply: record.reply === true,
        };
    });

    if (claim.kind === "done") {
        return claim.receipt;
    }

    const row = deps.rows().find((entry) => entry.id === claim.decision.id);
    const receipt: PressReceipt = {
        ...(row && !awaitsAnswer(row)
            ? refuse("closed", `DECISION ${claim.decision.number} is ${row.state} already.`, claim.decision)
            : claim.tokenKind === "toggle"
              ? await toggle({ claim, row, key, deps, refuse, now })
              : await answer({ claim, row, key, deps, refuse, text, now })),
        tokenKind: claim.tokenKind,
    };

    await deps.store.update((tokens) => {
        const record = tokens[token];

        if (record) {
            record.receipts[key] = receipt;
        }
    });

    return receipt;
}

type Go = Extract<Claim, { kind: "go" }>;
type Refuse = (code: ActRefusalCode, detail: string, decision?: ActReceipt["decision"]) => ActReceipt;

/** A toggle: the staged pick gains the token's letter or loses it, through the staging door, at the token's revision. */
async function toggle({
    claim,
    row,
    key,
    deps,
    refuse,
    now,
}: {
    claim: Go;
    row: DecisionRecord | undefined;
    key: string;
    deps: ActDeps;
    refuse: Refuse;
    now: number;
}): Promise<PressReceipt> {
    const { decision } = claim;

    if (!deps.stage) {
        return refuse("invalid", "This door cannot tick letters; answer in the hub.", decision);
    }

    const stage = deps.stage;
    const exclusive = deps.exclusive ?? (<T>(step: () => Promise<T>) => step());

    try {
        // The staged pick is read again inside the step: the row read at the claim may be older than another press.
        const { staged, next } = await exclusive(async () => {
            const fresh = deps.rows().find((entry) => entry.id === decision.id) ?? row;
            const next = toggledPick(fresh?.draftOption, decision.option);
            const staged = await stage({
                session: decision.session,
                number: decision.number,
                option: next,
                ...(claim.revision === undefined ? {} : { expectedRevision: claim.revision }),
                ...(claim.provider ? { provider: claim.provider } : {}),
            });
            return { staged, next };
        });
        return {
            key,
            outcome: { kind: "staged", option: pickLetters(staged?.draftOption ?? next) },
            decision,
            at: now,
        };
    } catch (err) {
        if (err instanceof AnswerRefusedError) {
            return refuse(REFUSAL_OF[err.code], err.message, decision);
        }

        log.warn({ err, decision }, "a toggle failed after its claim");
        return {
            key,
            outcome: { kind: "uncertain", detail: err instanceof Error ? err.message : String(err) },
            decision,
            at: now,
        };
    }
}

/**
 * An answer: the token's letter or set, the staged letters for a send, or the text of a reply. A reply to a decision
 * that takes several letters that names only letters ("a, c") answers with those letters.
 */
async function answer({
    claim,
    row,
    key,
    deps,
    refuse,
    text,
    now,
}: {
    claim: Go;
    row: DecisionRecord | undefined;
    key: string;
    deps: ActDeps;
    refuse: Refuse;
    text: string | undefined;
    now: number;
}): Promise<ActReceipt> {
    const reply = claim.reply ? text?.trim() : undefined;
    const shown = row ? decisionChoice(row) : undefined;
    const lettered = reply && shown?.several ? replyLetters(reply, shown.count) : undefined;
    const option = claim.tokenKind === "send" ? pickLetters(row?.draftOption) : (lettered ?? claim.decision.option);
    const decision = { ...claim.decision, option: reply && !lettered ? claim.decision.option : option };

    if (claim.tokenKind === "send" && !option) {
        return refuse("invalid", "Nothing is ticked yet: tick one or more letters, then send.", decision);
    }

    try {
        const result = await deps.answer({
            session: decision.session,
            number: decision.number,
            ...(reply && !lettered ? { text: reply } : { option }),
            ...(claim.revision === undefined ? {} : { expectedRevision: claim.revision }),
            ...(claim.provider ? { provider: claim.provider } : {}),
            deliveryKey: key,
        });
        return { key, outcome: outcomeOf(result), decision, at: now };
    } catch (err) {
        if (err instanceof AnswerRefusedError) {
            return refuse(REFUSAL_OF[err.code], err.message, decision);
        }

        // The answer may be stored and on its way: never report it as refused, and never send it twice.
        log.warn({ err, decision }, "an act failed after its claim");
        return {
            key,
            outcome: { kind: "uncertain", detail: err instanceof Error ? err.message : String(err) },
            decision,
            at: now,
        };
    }
}

/** The real dependencies: the token file, the decision log, the inbox answer door and the staging door. */
export async function realActDeps(): Promise<ActDeps> {
    const [
        { decisionFiles },
        { readDecisions },
        { waitingBlock },
        { answerInboxDecision },
        { draftDecision },
        { fileActTokenStore },
    ] = await Promise.all([
        import("../decisions/paths"),
        import("../decisions/store"),
        import("../inbox/load"),
        import("../inbox/answer"),
        import("../inbox/drafts"),
        import("./tokens"),
    ]);
    const files = decisionFiles();

    return {
        store: fileActTokenStore(),
        rows: () => readDecisions(files.file),
        answer: (input) => answerInboxDecision(input, { ...files, block: waitingBlock }),
        stage: (input) => draftDecision(input, { ...files, block: waitingBlock }),
        exclusive: (step) => withFileLock(`${files.file}.toggle.lock`, step),
    };
}
