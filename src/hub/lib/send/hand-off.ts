import { titleMatchKeys } from "@app/cmux/lib/title-match";
import { type FleetEntry, readFleetView } from "@genesiscz/utils/ai/live-sessions/fleet";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { logger } from "@genesiscz/utils/logger";
import { addressOfEntry, liveSendEdges, sendToSession } from "./index";
import type { SendEdges, SessionAddress, SessionSendReceipt } from "./types";

const log = logger.child({ component: "hub/send/hand-off" });

// M5's one hand-off intent: the hub's task senders (PR fix, check fix, saved prompts) write their task file
// themselves and then type one pointer line into the owning session here, through the session's harness sender
// (`sendToSession`, timing "now"). Before this they spawned `tools claude cmux send`, which resolved every session
// with Claude's resolver, so a Grok owner skipped its leader and a session without a cmux pane got nothing.

export interface HandOffDeps {
    /** The live sessions, to find the exact address (harness and home) of the session id. */
    fleet(): Promise<FleetEntry[]>;
    edges: SendEdges;
}

export function liveHandOffDeps(): HandOffDeps {
    return { fleet: () => readFleetView({ titleKeys: titleMatchKeys }), edges: liveSendEdges() };
}

/**
 * The session's address: its live fleet entry when it runs now, else the harness the caller knows (Claude when it
 * knows none, as the old `claude cmux send` assumed) with no home, so the durable queue cannot be its fallback.
 */
async function addressOf(
    input: { sessionId: string; provider?: string },
    deps: HandOffDeps
): Promise<SessionAddress | { reason: string }> {
    const entry = (await deps.fleet()).find((candidate) => candidate.sessionId === input.sessionId);

    if (entry) {
        return addressOfEntry(entry);
    }

    const provider = input.provider ?? "claude";

    if (!isAccountProviderAlias(provider)) {
        return { reason: `no sender knows the harness "${provider}"` };
    }

    return { provider, sessionId: input.sessionId, sourceHome: null };
}

/** Types one pointer line into the session now; the receipt says delivered, queued, refused or unknown. */
export async function handOffToSession(
    input: { sessionId: string; provider?: string; text: string },
    deps: HandOffDeps = liveHandOffDeps()
): Promise<SessionSendReceipt> {
    const address = await addressOf(input, deps);

    if ("reason" in address) {
        return { outcome: "refused", timing: "now", route: "none", detail: address.reason };
    }

    const receipt = await sendToSession({ ...address, text: input.text, timing: "now" }, deps.edges);
    log.debug({ sessionId: input.sessionId, outcome: receipt.outcome, route: receipt.route }, "hand-off settled");
    return receipt;
}

/** The old senders' contract: null when the line went (or waits in a queue for that session), else why not. */
export function handOffError(receipt: SessionSendReceipt): string | null {
    switch (receipt.outcome) {
        case "delivered":
        case "queued-daemon":
        case "queued-session":
            return null;
        case "unknown":
            return `the delivery is unknown (${receipt.detail}); check the session before you send again`;
        case "refused":
            return receipt.detail;
    }
}
