import { canonicalAgent } from "@app/handoff/targeting";
import type { DeliveryResult } from "./deliver";
import { DeliveryUnknownError, NotDeliveredError } from "./delivery-errors";
import { decisionLine, decisionLines, deliverDecisions, optionLetters } from "./read";
import {
    awaitsAnswer,
    awaitsDelivery,
    type DecisionRecord,
    type DecisionState,
    type HarvestedDecision,
    harvestDecisions,
    kindOf,
    moveDecisions,
    readDecisions,
    recordDelivery,
    restoreUndelivered,
    staleRevisionError,
    updateDecisions,
} from "./store";

/**
 * The rules every door applies an answer by (the inbox, the hub's composer, the staged and drafted sends, the CLI and
 * the dashboard): whether an answer may be taken, and why not, as one closed reason. The store's transition table
 * stays the authority on states; these rules read it through `awaitsAnswer` and the delivered states below.
 */

/** Why an answer cannot be taken. Each code has one sentence, the same at every door. */
export type AnswerRefusalCode =
    /** Neither a letter nor a text. */
    | "empty"
    /** The option is not letters a-z. */
    | "option-shape"
    /** The agent posted a new text since the answer was picked. */
    | "stale-revision"
    /** No stored row and no transcript block has this number in the session. */
    | "not-waiting"
    /** A letter past the decision's options. */
    | "option-range"
    /** The decision was answered (or dismissed, superseded) already. */
    | "already-answered"
    /** The row a door holds no longer matches the log (another session, number, revision or answer). */
    | "changed-elsewhere";

export class AnswerRefusedError extends Error {
    constructor(
        readonly code: AnswerRefusalCode,
        message: string
    ) {
        super(message);
        this.name = "AnswerRefusedError";
    }
}

/** One decision's answer: a letter, a text, or a letter with a note. */
export interface DecisionAnswer {
    expectedRevision?: number;
    number: number;
    /** One letter, a-z. Required unless `text` is given. */
    option?: string;
    /** A free-text answer, or a note after the letter. */
    text?: string;
}

/** An answer that passed every rule, with the row (or the transcript block) it answers. */
export interface CheckedAnswer {
    expectedRevision: number;
    number: number;
    option?: string;
    text?: string;
    row?: DecisionRecord;
    block?: HarvestedDecision;
}

/** The session's decision row with this number, if the log has one. */
export function decisionRow(rows: DecisionRecord[], session: string, number: number): DecisionRecord | undefined {
    return rows.find((row) => row.sessionId === session && row.number === number && kindOf(row) === "decision");
}

/**
 * Checks one answer against its stored row, else its transcript block (`block` is asked only when the log has no
 * row); throws `AnswerRefusedError` with the closed reason.
 */
export async function checkAnswer({
    session,
    answer,
    rows,
    block,
}: {
    session: string;
    answer: DecisionAnswer;
    rows: DecisionRecord[];
    block: (session: string, number: number) => Promise<HarvestedDecision | null>;
}): Promise<CheckedAnswer> {
    // The decision log allows several letters ("ac" when two apply); each must name an option.
    const option = optionLetters(answer.option).join("") || undefined;
    const text = answer.text?.trim() || undefined;

    if (!option && !text) {
        throw new AnswerRefusedError("empty", `DECISION ${answer.number}: pass an option letter or an answer text`);
    }

    if (answer.option?.trim() && !/^[a-z]+$/i.test(answer.option.trim())) {
        throw new AnswerRefusedError("option-shape", `the option is one or more letters a-z, not "${answer.option}"`);
    }

    const row = decisionRow(rows, session, answer.number);
    if (
        answer.expectedRevision !== undefined &&
        (!Number.isInteger(answer.expectedRevision) ||
            answer.expectedRevision < 1 ||
            answer.expectedRevision !== (row?.revision ?? 1))
    ) {
        throw new AnswerRefusedError("stale-revision", staleRevisionError(answer.number).message);
    }

    const found = row ? null : await block(session, answer.number);

    if (!row && !found) {
        throw new AnswerRefusedError("not-waiting", `DECISION ${answer.number} is not waiting in session ${session}`);
    }

    const options = row?.options ?? found?.options ?? [];

    if (option && options.length > 0 && [...option].some((letter) => letter.charCodeAt(0) - 97 >= options.length)) {
        throw new AnswerRefusedError(
            "option-range",
            `DECISION ${answer.number} has options a-${String.fromCharCode(96 + options.length)}`
        );
    }

    if (row && !awaitsAnswer(row)) {
        throw new AnswerRefusedError("already-answered", `DECISION ${answer.number} is already ${row.state}`);
    }

    return {
        number: answer.number,
        option,
        text,
        expectedRevision: answer.expectedRevision ?? row?.revision ?? 1,
        ...(row ? { row } : {}),
        ...(found ? { block: found } : {}),
    };
}

/**
 * A door that edits a decision before its answer exists (a staged pick, a dismissal) may do so only while it still
 * waits, at the revision the door read; else the closed refusal.
 */
export function refuseUnlessWaiting(row: DecisionRecord, number: number, expectedRevision?: number): void {
    if (!awaitsAnswer(row)) {
        throw new AnswerRefusedError("already-answered", `DECISION ${number} is already ${row.state}`);
    }

    if (expectedRevision !== undefined && expectedRevision !== (row.revision ?? 1)) {
        throw new AnswerRefusedError("stale-revision", staleRevisionError(number).message);
    }
}

/** Checks every answer before anything is written; the first refusal throws (`checkAnswer`). */
export async function checkAnswers({
    session,
    answers,
    rows,
    block,
}: {
    session: string;
    answers: readonly DecisionAnswer[];
    rows: DecisionRecord[];
    block: (session: string, number: number) => Promise<HarvestedDecision | null>;
}): Promise<CheckedAnswer[]> {
    const checked: CheckedAnswer[] = [];

    for (const answer of answers) {
        checked.push(await checkAnswer({ session, answer, rows, block }));
    }

    return checked;
}

/** The lines a send of these checked answers would deliver, for a dry run: the real send's own format. */
export function answerPreview(session: string, checked: readonly CheckedAnswer[]): string {
    return checked
        .map((item) => {
            // The title switches decisionLine to the "Reply to:" payload the real send delivers.
            const title = item.row?.title ?? item.block?.title;
            return decisionLine({
                id: item.row?.id ?? `d_${item.number}_${session}`,
                sessionId: session,
                number: item.number,
                prompt: item.row?.prompt ?? item.block?.prompt ?? "",
                options: item.row?.options ?? item.block?.options ?? [],
                state: "answered",
                updatedTs: new Date().toISOString(),
                ...(title ? { title } : {}),
                ...(item.option ? { option: item.option } : {}),
                ...(item.text ? { answer: item.text } : {}),
            });
        })
        .join("\n");
}

/**
 * Stores checked answers: a decision read from the transcript only is stored first through the harvest path (same
 * number, never renumbered), so every answer has a row to live on; then every row moves to `answered` in one
 * transition, as the user's own answer (an agent's update may not). Returns the rows' ids, for the send.
 */
export async function applyAnswers({
    file,
    events,
    session,
    provider,
    cwd,
    checked,
}: {
    file: string;
    events: string;
    session: string;
    provider?: string;
    cwd?: string;
    checked: readonly CheckedAnswer[];
}): Promise<string[]> {
    const found = checked.flatMap((item) => (item.block ? [item.block] : []));

    if (found.length > 0) {
        await harvestDecisions(file, events, { sessionId: session, provider, cwd, found });
    }

    const stored = readDecisions(file);
    const updates = checked.map((item) => {
        const row = decisionRow(stored, session, item.number);

        if (!row) {
            throw new Error(`DECISION ${item.number} could not be stored for session ${session}`);
        }

        return {
            id: row.id,
            expectedRevision: item.expectedRevision,
            state: "answered" as const,
            ...(item.option ? { option: item.option } : {}),
            ...(item.text ? { answer: item.text } : {}),
        };
    });
    await updateDecisions(file, events, { updates }, undefined, { actor: "user" });
    return updates.map((update) => update.id);
}

/**
 * An answer a session queue already holds: that session's next prompt takes it, so a re-send leaves it alone (a
 * second copy would reach the session twice).
 */
export function queueReserved(row: Pick<DecisionRecord, "delivery">): boolean {
    return Boolean(row.delivery?.queueId);
}

/** The states a decision reaches once its answer was typed into the agent. */
const DELIVERED_STATES: ReadonlySet<DecisionState> = new Set(["sent", "acknowledged", "implemented"]);

/** Whether the decision's answer reached its agent. */
export function answerDelivered(row: Pick<DecisionRecord, "state">): boolean {
    return DELIVERED_STATES.has(row.state);
}

/** The answer a door holds for one decision: the revision it read, the letters it picked, the note it wrote. */
export interface HeldAnswer {
    expectedRevision: number;
    option?: string;
    text: string;
}

/**
 * The row holds this answer, stored by an earlier attempt: answering keeps the revision, so the same revision, the
 * same letter and the same note mean nobody answered it differently since.
 */
export function holdsAnswer(row: DecisionRecord, held: HeldAnswer): boolean {
    const option = held.option?.trim().toLowerCase() || undefined;
    const note = held.text.trim();
    return (
        (row.revision ?? 1) === held.expectedRevision &&
        (row.option || undefined) === option &&
        (!note || (row.answer ?? "").includes(note))
    );
}

/** A door's answer to one decision of one session, as the widget's composer sends it. */
export interface DoorAnswer extends HeldAnswer {
    session: string;
    number: number;
    /** The harness the door addresses; a row spelling it `claude-code` (the runtime context's name) still matches. */
    provider: string;
}

/**
 * Whether a door may send this answer for this row before it attempts anything: the row is this session's decision
 * with this number and revision, and it still waits for an answer, or it already holds this very answer (a refused
 * transport left it `answered`, so a Retry sends it again; a delivery from elsewhere settles it).
 */
export function doorAnswerRefusal(row: DecisionRecord | undefined, answer: DoorAnswer): AnswerRefusedError | undefined {
    const matches =
        row !== undefined &&
        kindOf(row) === "decision" &&
        row.sessionId === answer.session &&
        row.number === answer.number &&
        (!row.provider || (canonicalAgent(row.provider) ?? row.provider) === answer.provider) &&
        (row.revision ?? 1) === answer.expectedRevision &&
        (awaitsAnswer(row) || ((row.state === "answered" || answerDelivered(row)) && holdsAnswer(row, answer)));

    return matches
        ? undefined
        : new AnswerRefusedError(
              "changed-elsewhere",
              "The decision changed or belongs to another session; refresh it before answering."
          );
}

/**
 * What sending a door's answer comes to now, read from the row as it stands: `delivered` (this answer reached the
 * agent already, from another door), `resend` (this answer is stored `answered` and no receiver took it), `answer`
 * (the decision still waits: apply the answer, then send it), `unresolved` (an earlier delivery of it has an unknown
 * outcome: nothing may send it until someone looks at the conversation), or a refusal.
 */
export type DoorAnswerPlan =
    | { kind: "unresolved" }
    | { kind: "delivered" }
    | { kind: "resend"; row: DecisionRecord }
    | { kind: "answer" }
    | { kind: "refused"; refusal: AnswerRefusedError };

export function planDoorAnswer(row: DecisionRecord | undefined, answer: HeldAnswer): DoorAnswerPlan {
    if (row?.delivery?.uncertain) {
        return { kind: "unresolved" };
    }

    const ours = row !== undefined && holdsAnswer(row, answer);

    if (row && ours && answerDelivered(row)) {
        return { kind: "delivered" };
    }

    if (row && ours && row.state === "answered") {
        return { kind: "resend", row };
    }

    if (row && awaitsAnswer(row)) {
        return { kind: "answer" };
    }

    return {
        kind: "refused",
        refusal: new AnswerRefusedError(
            "changed-elsewhere",
            "Decision changed elsewhere. Refresh it before answering."
        ),
    };
}

interface Claim {
    /** The due rows' ids, as read before the lock: what a failed send puts back to `answered`. */
    due: string[];
    /** The rows moved to `sent` under the lock, with the text and numbers built from them. */
    moved: string[];
    sent: SentDecisions;
}

/**
 * Claims what is due in one store transition: the batch is marked `sent` FIRST, and only then handed to the
 * transport. Marking row by row after emitting let a crash leave delivered answers still `answered`, and the next
 * send delivered them again. Throws "nothing to send" before any change when none is due.
 */
async function claimDue({
    file,
    events,
    session,
    ids: selectedIds,
}: {
    file: string;
    events: string;
    session: string;
    ids?: readonly string[];
}): Promise<Claim> {
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
    return {
        due: ids,
        moved: moved.map((row) => row.id),
        sent: { text: decisionLines(moved), numbers: moved.map((row) => row.number) },
    };
}

/**
 * A claim whose transport failed goes back to `answered`, except after an unknown outcome: that one may have
 * arrived, so it stays `sent` (marked uncertain by the caller) and is never put back on an automatic queue.
 */
async function releaseClaim({
    file,
    events,
    claim,
    error,
}: {
    file: string;
    events: string;
    claim: Claim;
    error: unknown;
}): Promise<void> {
    if (error instanceof DeliveryUnknownError) {
        return;
    }

    const queued = error instanceof NotDeliveredError && error.result.queueId ? error.result : undefined;
    await restoreUndelivered({
        file,
        events,
        ids: claim.due,
        ...(queued ? { delivery: { route: "queued", queueId: queued.queueId, error: queued.error } } : {}),
    });
}

/**
 * Delivers a session's answered decisions through `emit`: claim, emit, and on failure release (`claimDue`,
 * `releaseClaim`). An `emit` that throws puts the batch back to `answered`; one that returns normally delivered it.
 * It records no delivery route; `deliverDueAnswers` is the send that does.
 */
export async function sendSessionDecisions({
    file,
    events,
    session,
    ids,
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
    const claim = await claimDue({ file, events, session, ids });

    try {
        await emit(claim.sent.text, claim.sent.numbers);
    } catch (error) {
        await releaseClaim({ file, events, claim, error });
        throw error;
    }

    return claim.sent;
}

/** What delivering the due answers came to: delivered (and recorded), or not delivered and stored as queued. */
export type DueAnswersOutcome =
    | { kind: "delivered"; sent: SentDecisions; route: DeliveryResult }
    | { kind: "queued"; text: string; route: DeliveryResult };

/**
 * The whole send of a session's due answers, in one place: claim them (`sent`), hand them to `deliver`, then record
 * the route. A delivery that did not reach the agent puts the batch back to `answered` and records it as queued (with
 * its session-queue entry, when one was saved); an unknown outcome records the batch as uncertain and rethrows, so
 * nothing resends it; any other failure puts the batch back and rethrows.
 *
 * The CLI `send`, the hub, the inbox, the dashboard and the next-prompt hook all send through this. A record that
 * fails after the answers reached the agent throws, unless `onRecordError` takes it (the hook logs it: the bytes are
 * already in the harness).
 */
export async function deliverDueAnswers({
    file,
    events,
    session,
    ids,
    deliver,
    onRecordError,
}: {
    file: string;
    events: string;
    session: string;
    ids?: readonly string[];
    /** The transport: resolves with its result; `delivered: false` means nothing reached the agent. */
    deliver: (text: string, numbers: number[]) => Promise<DeliveryResult>;
    onRecordError?: (error: unknown) => void;
}): Promise<DueAnswersOutcome> {
    const claim = await claimDue({ file, events, session, ids });
    let route: DeliveryResult;

    try {
        route = await deliver(claim.sent.text, claim.sent.numbers);
        if (!route.delivered) {
            throw new NotDeliveredError(route);
        }
    } catch (error) {
        await releaseClaim({ file, events, claim, error });

        if (error instanceof DeliveryUnknownError) {
            await recordDelivery(file, events, claim.moved, { route: "queued", uncertain: true, error: error.message });
            throw error;
        }

        if (!(error instanceof NotDeliveredError)) {
            throw error;
        }

        // Not a failure: the answers stay `answered`, and the next prompt pulls them. The sentence is stored; the raw
        // output stays in the log and in the result only.
        await recordDelivery(file, events, claim.moved, {
            route: "queued",
            ...(error.result.queueId ? { queueId: error.result.queueId } : {}),
            ...(error.result.error ? { error: error.result.error } : {}),
        });
        return { kind: "queued", text: claim.sent.text, route: error.result };
    }

    try {
        await recordDelivery(file, events, claim.moved, {
            route: route.channel,
            ...(route.target ? { target: route.target } : {}),
        });
    } catch (error) {
        if (!onRecordError) {
            throw error;
        }

        onRecordError(error);
    }

    return { kind: "delivered", sent: claim.sent, route };
}

export interface SentDecisions {
    text: string;
    numbers: number[];
}
