/** What a failed probe means for the user; each tier names its own (`TIERS[tier].probeFailure`). */
export type ProbeFailure = "unreachable" | "needs-vpn" | "needs-pair";

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
    | { type: "probe-fail"; failure: ProbeFailure };

/** Pure FSM of the reachability badge; the tier table says which failure state a failed probe is. */
export function reachabilityReducer(_state: ReachState, action: ReachAction): ReachState {
    if (action.type === "probe-start") {
        return { kind: "probing" };
    }

    if (action.type === "probe-ok") {
        return { kind: "reachable" };
    }

    return { kind: action.failure };
}

/** The sentence a failed connect shows, per failure. */
export const FAILURE_MESSAGE: Record<ProbeFailure | "error", string> = {
    unreachable: "The Mac did not answer. Check the address and that the dashboard runs on it.",
    "needs-vpn": "The Mac is not reachable over Tailscale. Turn Tailscale on on this phone, then try again.",
    "needs-pair": "The Mac did not accept this phone. Pair it again with the code the Mac shows.",
    error: "The connection failed.",
};
