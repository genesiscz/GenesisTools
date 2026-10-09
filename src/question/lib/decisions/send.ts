import { canonicalAgent } from "@app/handoff/targeting";
import { logger } from "@genesiscz/utils/logger";
import {
    type DeliverDeps,
    type DeliveryResult,
    DeliveryUnknownError,
    deliverToSession,
    NotDeliveredError,
} from "./deliver";
import { decisionFiles, decisionLine, sendSessionDecisions } from "./read";
import { kindOf, readDecisions, recordDelivery } from "./store";

const { log } = logger.scoped("question-send");

export interface SendResult extends Partial<DeliveryResult> {
    session: string;
    provider: string | null;
    text: string;
    /** The decision numbers marked sent; empty for a dry run and for a queued batch. */
    numbers: number[];
    dryRun: boolean;
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
    files = decisionFiles(),
    deps = {},
}: {
    session: string;
    provider?: string;
    sourceHome?: string;
    deliveryKey?: string;
    ids?: readonly string[];
    dryRun?: boolean;
    files?: { file: string; events: string };
    deps?: DeliverDeps;
}): Promise<SendResult> {
    const { file, events } = files;
    const selected = ids ? new Set(ids) : undefined;
    const rows = readDecisions(file).filter((row) => row.sessionId === session && (!selected || selected.has(row.id)));
    const provider = providerOf(given, rows);

    if (dryRun) {
        const due = rows.filter((row) => row.state === "answered" && kindOf(row) === "decision");

        if (due.length === 0) {
            throw new Error("nothing to send");
        }

        return { session, provider, text: due.map(decisionLine).join("\n"), numbers: [], dryRun: true };
    }

    const delivery: { route?: DeliveryResult; text?: string; numbers?: number[] } = {};
    // Only the rows this send claimed under the lock; a row already reserved by another queue keeps its stamp.
    const claimed = () =>
        rows
            .filter((row) => kindOf(row) === "decision" && (delivery.numbers ?? []).includes(row.number))
            .map((row) => row.id);

    try {
        const sent = await sendSessionDecisions({
            ids,
            file,
            events,
            session,
            emit: async (text, numbers) => {
                delivery.text = text;
                delivery.numbers = numbers;
                const route = await deliverToSession(
                    { session, provider: provider ?? undefined, sourceHome, text, deliveryKey },
                    deps
                );
                delivery.route = route;

                if (!route.delivered) {
                    throw new NotDeliveredError(route);
                }
            },
        });

        const moved = rows.filter((row) => kindOf(row) === "decision" && sent.numbers.includes(row.number));
        await recordDelivery(
            file,
            events,
            moved.map((row) => row.id),
            {
                route: delivery.route?.channel ?? "cmux",
                ...(delivery.route?.target ? { target: delivery.route.target } : {}),
            }
        );
        return { session, provider, ...sent, ...delivery.route, dryRun: false };
    } catch (error) {
        if (error instanceof DeliveryUnknownError) {
            await recordDelivery(file, events, claimed(), { route: "queued", uncertain: true, error: error.message });
            throw error;
        }

        if (!(error instanceof NotDeliveredError)) {
            throw error;
        }

        // Not a failure: the answers stay `answered`, and the next prompt pulls them. The sentence
        // is stored; the raw output stays in the log and in this result only.
        log.info({ session, error: error.result.error, raw: error.result.raw }, "decision answers queued");
        await recordDelivery(file, events, claimed(), {
            route: "queued",
            ...(error.result.queueId ? { queueId: error.result.queueId } : {}),
            ...(error.result.error ? { error: error.result.error } : {}),
        });
        return { session, provider, text: delivery.text ?? "", numbers: [], ...error.result, dryRun: false };
    }
}
