import type { DecisionDelivery } from "@app/question/lib/decisions/store";
import { formatClock } from "@genesiscz/utils/format";

/**
 * Where and when a decision's answer went, as the /qa history row says it: "sent 22:40 via cmux
 * work · pane 3", "sent 22:40 via codex fixer", or "queued 22:40: no cmux pane runs this session".
 * Null for a row that was never sent, and for rows stored before deliveries were recorded.
 */
export function deliveryLabel(delivery: DecisionDelivery | null | undefined): string | null {
    if (!delivery) {
        return null;
    }

    const at = formatClock(delivery.at, { date: "short" });

    if (delivery.route === "queued") {
        // `error` is the one sentence; `target` on a queued row is a pre-rework "why", never a place.
        const why = delivery.error ?? delivery.target;
        return `queued ${at}${why ? `: ${why.split("\n")[0]}` : ""}`;
    }

    if (delivery.route === "prompt") {
        return `sent ${at} with the session's next prompt`;
    }

    if (delivery.route === "resume") {
        return `resumed ${at}${delivery.target ? ` at ${delivery.target}` : ""}; the answer rides its first prompt`;
    }

    return `sent ${at} via ${delivery.route}${delivery.target ? ` ${delivery.target}` : ""}`;
}
