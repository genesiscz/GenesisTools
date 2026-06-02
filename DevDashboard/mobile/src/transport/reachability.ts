import type { TransportTier } from "@/transport/Transport";

export type ReachState =
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "reachable" }
    | { kind: "unreachable" }
    | { kind: "needs-vpn" }
    | { kind: "needs-pair" };

export type ReachAction =
    | { type: "probe-start" }
    | { type: "probe-ok" }
    | { type: "probe-fail"; tier: TransportTier; paired?: boolean };

/** Pure FSM mapping a tier-specific probe failure to the right user-facing state. */
export function reachabilityReducer(_state: ReachState, action: ReachAction): ReachState {
    if (action.type === "probe-start") {
        return { kind: "probing" };
    }

    if (action.type === "probe-ok") {
        return { kind: "reachable" };
    }

    if (action.tier === "tailscale") {
        return { kind: "needs-vpn" };
    }

    if (action.tier === "managed" && action.paired === false) {
        return { kind: "needs-pair" };
    }

    return { kind: "unreachable" };
}
