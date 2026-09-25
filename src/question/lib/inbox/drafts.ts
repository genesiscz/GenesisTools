import { type DeliverDeps, resolveDeliveryTarget } from "../decisions/deliver";
import { optionLetters } from "../decisions/read";
import { type SendResult, sendAnsweredDecisions } from "../decisions/send";
import {
    type DecisionRecord,
    type HarvestedDecision,
    harvestDecisions,
    kindOf,
    readDecisions,
    recordDelivery,
    updateDecisions,
} from "../decisions/store";

/**
 * Pick, then send. A click on an option MARKS it as the user's draft; it is not answered or
 * delivered until Send. The Inbox, the session Decisions pane and /qa all write through here, so
 * the picks are one source of truth and survive a hub restart. `answer.ts` owns the send.
 */

export interface DraftInput {
    session: string;
    number: number;
    /** The chosen letters, several allowed (`"ac"`); an empty string clears the pick. */
    option?: string;
    /** The unsent note; an empty string clears it. */
    text?: string;
    provider?: string;
    cwd?: string;
}

export interface DraftDeps {
    file: string;
    events: string;
    /** The `❓ DECISION N` block of the last reply, so a transcript-only decision gets a row to draft on. */
    block: (session: string, number: number) => Promise<HarvestedDecision | null>;
}

function normalize(option: string | undefined): string | undefined {
    if (option === undefined) {
        return undefined;
    }

    return optionLetters(option).join("");
}

/**
 * Marks or clears a decision's draft pick and note. A decision the store does not have yet (its
 * last reply asks it, nobody posted it) is harvested first under its own number, so the draft has a
 * row to live on. Clearing both the pick and the note puts an open decision back to plain `open`;
 * otherwise it becomes `drafted`. Returns the stored row.
 */
export async function draftDecision(input: DraftInput, deps: DraftDeps) {
    const before = readDecisions(deps.file);
    const existing = before.find(
        (row) =>
            row.sessionId === input.session && row.number === input.number && (row.type ?? "decision") === "decision"
    );

    if (!existing) {
        const block = await deps.block(input.session, input.number);

        if (!block) {
            throw new Error(`DECISION ${input.number} is not waiting in session ${input.session}`);
        }

        await harvestDecisions(deps.file, deps.events, {
            sessionId: input.session,
            ...(input.provider ? { provider: input.provider } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            found: [block],
        });
    }

    const rows = readDecisions(deps.file);
    const row = rows.find(
        (candidate) =>
            candidate.sessionId === input.session &&
            candidate.number === input.number &&
            (candidate.type ?? "decision") === "decision"
    );

    if (!row) {
        throw new Error(`DECISION ${input.number} could not be stored for session ${input.session}`);
    }

    if (row.state !== "open" && row.state !== "drafted") {
        throw new Error(`DECISION ${input.number} is already ${row.state}`);
    }

    const option = normalize(input.option);
    const draftOption = option ?? row.draftOption ?? "";
    const draft = input.text !== undefined ? input.text : (row.draft ?? "");
    const empty = draftOption.length === 0 && draft.trim().length === 0;

    if (option && row.options.length > 0) {
        const past = [...option].find((letter) => letter.charCodeAt(0) - 97 >= row.options.length);

        if (past) {
            const last = String.fromCharCode(96 + row.options.length);
            throw new Error(`DECISION ${input.number} has options a-${last}, not "${input.option}"`);
        }
    }

    const state = empty ? "open" : "drafted";
    // The state moves only when it changes: `open` to `open` is no transition, and clearing an
    // untouched decision used to fail with "cannot move ... from open to open".
    const [updated] = await updateDecisions(deps.file, deps.events, {
        updates: [{ id: row.id, ...(state === row.state ? {} : { state }), draftOption, draft }],
    });

    return updated;
}

/** Drops a decision that no longer matters (a scratch probe) without sending anything. */
export async function dismissDecision(
    { session, number }: { session: string; number: number },
    deps: Pick<DraftDeps, "file" | "events">
) {
    const rows = readDecisions(deps.file);
    const row = rows.find(
        (candidate) =>
            candidate.sessionId === session &&
            candidate.number === number &&
            (candidate.type ?? "decision") === "decision"
    );

    if (!row) {
        throw new Error(`DECISION ${number} is not waiting in session ${session}`);
    }

    if (row.state !== "open" && row.state !== "drafted") {
        throw new Error(`DECISION ${number} is already ${row.state}`);
    }

    const [updated] = await updateDecisions(deps.file, deps.events, {
        updates: [{ id: row.id, state: "dismissed" }],
    });

    return updated;
}

/** A drafted decision the send would promote: an unsent pick or note on an open row. */
function isDrafted(row: DecisionRecord): boolean {
    return (
        kindOf(row) === "decision" &&
        (row.state === "open" || row.state === "drafted") &&
        (Boolean(row.draftOption) || Boolean(row.draft?.trim()))
    );
}

export interface SendDraftsInput {
    session: string;
    provider?: string;
    /** Print the message and the route; promote nothing, deliver nothing. */
    dryRun?: boolean;
    /**
     * Given by the resume dialog after it reopened the session at this human place. The send then
     * waits for the session's pane to come up (`waitLiveMs`) and types into it; when it never does,
     * the answers stay queued and the delivery names the place, not an error.
     */
    recordResumeTarget?: string;
    /** How long to wait for a live pane before typing (a just-resumed session boots for a few seconds). */
    waitLiveMs?: number;
}

/** Polled once a second while waiting for a resumed session's pane; the deadline is a count, not a clock. */
const WAIT_STEP_MS = 1_000;

/**
 * Sends every drafted answer of one session as ONE message. The drafts are promoted to `answered`
 * (the pick becomes the option, the note the answer) in one transition, then delivered through
 * `sendAnsweredDecisions`: a live cmux pane or codex worker, else queued for the next prompt.
 *
 * The resume path (`recordResumeTarget` + `waitLiveMs`): the dialog reopened the session, so the
 * send waits for its pane to be live, then types as usual. The inject hook is not relied on: on a
 * machine where it is off, a queued answer would never arrive.
 */
export async function sendDrafts(
    input: SendDraftsInput,
    deps: DraftDeps & { deliver?: DeliverDeps; sleep?: (ms: number) => Promise<void> }
): Promise<SendResult & { promoted: number[] }> {
    const drafted = readDecisions(deps.file).filter((row) => row.sessionId === input.session && isDrafted(row));

    if (input.dryRun) {
        const result = await sendAnsweredDecisions({
            session: input.session,
            ...(input.provider ? { provider: input.provider } : {}),
            dryRun: true,
            files: deps,
            ...(deps.deliver ? { deps: deps.deliver } : {}),
        });
        return { ...result, promoted: [] };
    }

    if (drafted.length > 0) {
        await updateDecisions(deps.file, deps.events, {
            updates: drafted.map((row) => ({
                id: row.id,
                state: "answered" as const,
                ...(row.draftOption ? { option: optionLetters(row.draftOption).join("") } : {}),
                ...(row.draft?.trim() ? { answer: row.draft.trim() } : {}),
            })),
        });
    }

    // A just-resumed session boots for a few seconds: wait, bounded, for its pane to be live.
    let live = false;

    if (input.waitLiveMs && input.waitLiveMs > 0) {
        const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
        const attempts = Math.max(1, Math.ceil(input.waitLiveMs / WAIT_STEP_MS));

        for (let attempt = 0; attempt < attempts; attempt++) {
            const target = await resolveDeliveryTarget(
                { session: input.session, ...(input.provider ? { provider: input.provider } : {}) },
                deps.deliver ?? {}
            );

            if (target.kind !== "none") {
                live = true;
                break;
            }

            if (attempt + 1 < attempts) {
                await sleep(WAIT_STEP_MS);
            }
        }
    }

    // The resume dialog reopened the session, and its pane never came up in time: the answers stay
    // `answered`, and the delivery names where it resumed, not a queue error. With a live pane the
    // normal send below types them.
    if (input.recordResumeTarget && !live) {
        const answered = readDecisions(deps.file).filter(
            (row) => row.sessionId === input.session && kindOf(row) === "decision" && row.state === "answered"
        );
        await recordDelivery(
            deps.file,
            deps.events,
            answered.map((row) => row.id),
            { route: "resume", target: input.recordResumeTarget }
        );
        return {
            session: input.session,
            provider: input.provider ?? null,
            text: answered.map((row) => row.number).join(", "),
            numbers: [],
            channel: "resume",
            delivered: true,
            target: input.recordResumeTarget,
            dryRun: false,
            promoted: drafted.map((row) => row.number),
        };
    }

    const result = await sendAnsweredDecisions({
        session: input.session,
        ...(input.provider ? { provider: input.provider } : {}),
        files: deps,
        ...(deps.deliver ? { deps: deps.deliver } : {}),
    });

    return { ...result, promoted: drafted.map((row) => row.number) };
}
