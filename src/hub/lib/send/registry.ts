import type { AgentSendTimings } from "@app/dev-dashboard/contract/agents";
import { ACCOUNT_PROVIDER_ALIASES } from "@genesiscz/utils/ai/providers/alias-list";
import { hasMembers, toolParts } from "@genesiscz/utils/harness/tool-parts";
import { type HarnessSender, SEND_TIMINGS, type SendTiming, type SessionAddress, type TimingSupport } from "./types";

/**
 * Each harness's sender (M5): `senders/<id>.ts` exports it as `sessionSender` (`toolParts`), so a new harness adds its
 * module and edits no table. This file loads no transport, so the board reads the timings without the delivery code.
 */
const SESSION_SENDERS = toolParts<HarnessSender>({
    meta: import.meta,
    folder: "senders",
    exportName: "sessionSender",
    isPart: hasMembers<HarnessSender>("timings", "interrupt"),
});

export function senderOf(provider: SessionAddress["provider"]): HarnessSender {
    return SESSION_SENDERS.of(provider);
}

/** What each timing does for one harness, for a door that offers the choice. */
export function sendTimingsOf(provider: SessionAddress["provider"]): Record<SendTiming, TimingSupport> {
    const timings = senderOf(provider).timings;
    const support = (timing: SendTiming): TimingSupport => {
        const route = timings[timing];
        return "refused" in route
            ? { supported: false, reason: route.refused }
            : { supported: true, meaning: route.meaning };
    };

    return { now: support("now"), "next-turn": support("next-turn"), later: support("later") };
}

/** Every harness's timings, as the board sends them. */
export function allSendTimings(): AgentSendTimings {
    return Object.fromEntries(
        ACCOUNT_PROVIDER_ALIASES.map((provider) => [provider, sendTimingsOf(provider)])
    ) as AgentSendTimings;
}

export { SEND_TIMINGS };
