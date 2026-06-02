import { reachabilityReducer } from "@/transport/reachability";
import { describe, expect, it } from "bun:test";

describe("reachabilityReducer", () => {
    it("starts probing", () => {
        expect(reachabilityReducer({ kind: "idle" }, { type: "probe-start" })).toEqual({ kind: "probing" });
    });

    it("probe success -> reachable", () => {
        expect(reachabilityReducer({ kind: "probing" }, { type: "probe-ok" })).toEqual({ kind: "reachable" });
    });

    it("a tailscale probe failure -> needs-vpn (not generic unreachable)", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "tailscale" });
        expect(s).toEqual({ kind: "needs-vpn" });
    });

    it("a managed probe failure with no keys -> needs-pair", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "managed", paired: false });
        expect(s).toEqual({ kind: "needs-pair" });
    });

    it("a lan probe failure -> unreachable", () => {
        const s = reachabilityReducer({ kind: "probing" }, { type: "probe-fail", tier: "lan" });
        expect(s).toEqual({ kind: "unreachable" });
    });
});
