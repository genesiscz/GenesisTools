import { canonicalAgent } from "@app/handoff/targeting";
import { logger } from "@genesiscz/utils/logger";
import { type DeliverDeps, type DeliveryResult, deliverToSession, NotDeliveredError } from "./deliver";
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
 * Delivers a session's answered decisions: typed into its cmux pane (Claude, Grok), steered into
 * its `tools codex` worker, or left `answered` for the next prompt when neither route works.
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
    dryRun = false,
    files = decisionFiles(),
    deps = {},
}: {
    session: string;
    provider?: string;
    dryRun?: boolean;
    files?: { file: string; events: string };
    deps?: DeliverDeps;
}): Promise<SendResult> {
    const { file, events } = files;
    const rows = readDecisions(file).filter((row) => row.sessionId === session);
    const provider = providerOf(given, rows);

    if (dryRun) {
        const due = rows.filter((row) => row.state === "answered");

        if (due.length === 0) {
            throw new Error("nothing to send");
        }

        return { session, provider, text: due.map(decisionLine).join("\n"), numbers: [], dryRun: true };
    }

    const delivery: { route?: DeliveryResult; text?: string } = {};
    // The rows a queued send leaves `answered` (the same filter as `sendSessionDecisions`).
    const due = rows.filter((row) => row.state === "answered" && kindOf(row) === "decision").map((row) => row.id);

    try {
        const sent = await sendSessionDecisions({
            file,
            events,
            session,
            emit: async (text) => {
                delivery.text = text;
                const route = await deliverToSession({ session, provider: provider ?? undefined, text }, deps);
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
        if (!(error instanceof NotDeliveredError)) {
            throw error;
        }

        // Not a failure: the answers stay `answered`, and the next prompt pulls them. The sentence
        // is stored; the raw output stays in the log and in this result only.
        log.info({ session, error: error.result.error, raw: error.result.raw }, "decision answers queued");
        await recordDelivery(file, events, due, {
            route: "queued",
            ...(error.result.error ? { error: error.result.error } : {}),
        });
        return { session, provider, text: delivery.text ?? "", numbers: [], ...error.result, dryRun: false };
    }
}
