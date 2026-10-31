import { canonicalAgent } from "@app/handoff/targeting";
import { logger } from "@genesiscz/utils/logger";
import { deliverDueAnswers } from "./answers";
import { type DeliverDeps, type DeliveryResult, deliverToSession, type LocatedDelivery } from "./deliver";
import { relayedAnswerText } from "./delivery-text";
import { decisionFiles, decisionLine, decisionLines } from "./read";
import {
    awaitsDelivery,
    finishPromptDecisions,
    kindOf,
    type PromptReceipt,
    readDecisions,
    reservePromptDecisions,
} from "./store";

const { log } = logger.scoped("question-send");

export interface SendResult extends Partial<DeliveryResult> {
    session: string;
    provider: string | null;
    text: string;
    /** The decision numbers marked sent; empty for a dry run and for a queued batch. */
    numbers: number[];
    dryRun: boolean;
    /** Exact pending batch, acknowledged only after the session accepts its prompt. */
    promptReceipt?: PromptReceipt;
}

/** The provider name the delivery compares against (`claude`, `codex`, `grok`). */
export function providerOf(given: string | undefined, rows: ReadonlyArray<{ provider?: string }>): string | null {
    const named = given?.trim() || rows.find((row) => row.provider)?.provider;
    return named ? (canonicalAgent(named) ?? named) : null;
}

/**
 * Delivers answered decisions through an owned provider worker or an optional cmux pane.
 * Portable queued answers carry a queue ID and cannot also be replayed by the next-prompt hook.
 * A queued batch is a result, not an error. "nothing to send" still throws. The CLI `send` verb
 * and the dashboard's Send button both call this.
 *
 * `provider` is the caller's knowledge of the session (the hub and the inbox pass it); it wins
 * over the rows, since a row posted from outside a harness carries none and would otherwise be
 * typed into a cmux pane even for a Codex thread.
 */
export async function sendAnsweredDecisions({
    session,
    provider: given,
    sourceHome,
    deliveryKey,
    ids,
    dryRun = false,
    inSession = false,
    promptReceipt,
    releasePrompt,
    force = false,
    located,
    files = decisionFiles(),
    deps = {},
}: {
    session: string;
    provider?: string;
    sourceHome?: string;
    deliveryKey?: string;
    ids?: readonly string[];
    dryRun?: boolean;
    /**
     * The session delivers the message itself, through its own prompt (the mods Decisions sidebar): nothing is
     * typed and the pending answers are reserved for five minutes. After submitting `text`, acknowledge its
     * `promptReceipt`; if submission is rejected, pass the receipt with `releasePrompt` instead.
     */
    inSession?: boolean;
    promptReceipt?: PromptReceipt;
    /** A submission failed before the session accepted the prompt. Release only that preparation's lease. */
    releasePrompt?: boolean;
    /** Type the answer into the pane even while the session shows a dialog (`tools question send --force`). */
    force?: boolean;
    /** The live place the caller found just before (`locateDelivery`), so the delivery skips its own lookup. */
    located?: LocatedDelivery;
    files?: { file: string; events: string };
    deps?: DeliverDeps;
}): Promise<SendResult> {
    const { file, events } = files;
    const selectedIds = promptReceipt?.ids ?? ids;
    const selected = selectedIds ? new Set(selectedIds) : undefined;
    const rows = readDecisions(file).filter((row) => row.sessionId === session && (!selected || selected.has(row.id)));
    const provider = providerOf(given, rows);

    if (dryRun) {
        // What a real send would take: the ids asked for, else only the answers waiting to go out.
        const due = rows.filter(
            (row) =>
                row.state === "answered" &&
                kindOf(row) === "decision" &&
                (selected !== undefined || awaitsDelivery(row))
        );

        if (due.length === 0) {
            throw new Error("nothing to send");
        }

        return { session, provider, text: due.map(decisionLine).join("\n"), numbers: [], dryRun: true };
    }

    if (inSession && promptReceipt) {
        const moved = await finishPromptDecisions({
            file,
            events,
            session,
            receipt: promptReceipt,
            acknowledge: releasePrompt
                ? undefined
                : (due) => {
                      if (decisionLines(due) !== promptReceipt.text) {
                          throw new Error("The pending answers changed; the submitted batch was not marked sent");
                      }
                  },
        });
        return {
            session,
            provider,
            text: promptReceipt.text,
            numbers: releasePrompt ? [] : moved.map((row) => row.number),
            dryRun: false,
            channel: "prompt",
            delivered: !releasePrompt,
            ...(releasePrompt ? {} : { target: "the session's own prompt" }),
        };
    }

    if (inSession) {
        const reserved = await reservePromptDecisions({ file, events, session, ids });
        const text = decisionLines(reserved.rows);
        return {
            session,
            provider,
            text,
            numbers: [],
            dryRun: false,
            channel: "prompt",
            delivered: false,
            promptReceipt: { ids: reserved.rows.map((row) => row.id), text, token: reserved.token },
        };
    }

    const outcome = await deliverDueAnswers({
        file,
        events,
        session,
        ids: selectedIds,
        deliver: (text) =>
            deliverToSession(
                {
                    session,
                    provider: provider ?? undefined,
                    sourceHome,
                    text: relayedAnswerText(text),
                    deliveryKey,
                    force,
                    ...(located ? { located } : {}),
                },
                deps
            ),
    });

    if (outcome.kind === "delivered") {
        return { session, provider, ...outcome.sent, ...outcome.route, dryRun: false };
    }

    log.info({ session, error: outcome.route.error, raw: outcome.route.raw }, "decision answers queued");
    return { session, provider, text: outcome.text, numbers: [], ...outcome.route, dryRun: false };
}
