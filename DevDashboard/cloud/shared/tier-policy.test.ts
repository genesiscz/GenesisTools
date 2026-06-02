import { describe, expect, it } from "bun:test";
import { TIER_POLICY, tierById, type TrustTierId } from "./tier-policy";

describe("tier-policy", () => {
    it("defines exactly the four ADR §4 tiers in order", () => {
        const ids = TIER_POLICY.map((t) => t.id);
        expect(ids).toEqual(["lan", "tailscale", "cloudflared-self", "managed"]);
    });

    it("states no-see UNCONDITIONALLY for lan, tailscale, cloudflared-self", () => {
        for (const id of ["lan", "tailscale", "cloudflared-self"] as TrustTierId[]) {
            expect(tierById(id).noSee).toBe("unconditional");
        }
    });

    it("states managed no-see ONLY as a property of the E2E layer, with a metadata caveat", () => {
        const managed = tierById("managed");
        expect(managed.noSee).toBe("e2e-conditional");
        expect(managed.claim.toLowerCase()).toContain("end-to-end");
        expect(managed.caveat?.toLowerCase()).toContain("metadata");
        expect(managed.claim.toLowerCase()).toContain("never");
    });

    it("self-hosted cloudflared attributes the no-see to the USER'S OWN cloudflare account", () => {
        const cf = tierById("cloudflared-self");
        expect(cf.claim.toLowerCase()).toContain("your own");
        expect(cf.noSee).toBe("unconditional");
    });

    it("no tier claims more than it delivers (managed must NOT use the word 'unconditional')", () => {
        const managed = tierById("managed");
        expect(managed.noSee).not.toBe("unconditional");
    });

    it("throws for an unknown tier id", () => {
        // @ts-expect-error — intentionally passing an invalid id
        expect(() => tierById("nope")).toThrow(/unknown trust tier/);
    });
});
