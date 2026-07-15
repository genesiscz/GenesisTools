import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { verifyStripeSignature } from "@app/youtube/lib/billing";

// Golden vector — recomputed via:
//   bun -e 'const c=require("node:crypto");const s="whsec_test_golden_secret";
//   const p="{\"id\":\"evt_test_golden\",\"type\":\"checkout.session.completed\"}";
//   const t=1700000000;console.log(c.createHmac("sha256",s).update(`${t}.${p}`).digest("hex"))'
const SECRET = "whsec_test_golden_secret";
const PAYLOAD = '{"id":"evt_test_golden","type":"checkout.session.completed"}';
const TIMESTAMP = 1700000000;
const GOLDEN_SIGNATURE = "37053143db07d5dcd1a63cfb607405fd917d97a8dc905ee9bb5b86dcccbc5efa";

// Fixed timestamp is far in the past relative to "now" — passing tests use a
// huge tolerance to isolate signature-correctness from freshness checks.
const HUGE_TOLERANCE = 10_000_000_000;

describe("verifyStripeSignature", () => {
    it("accepts a known-good signature (golden vector)", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(
            verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET, toleranceSec: HUGE_TOLERANCE })
        ).toBe(true);
    });

    it("rejects a tampered signature (flipped byte)", () => {
        const tampered = `${GOLDEN_SIGNATURE.slice(0, -1)}${GOLDEN_SIGNATURE.endsWith("a") ? "b" : "a"}`;
        const header = `t=${TIMESTAMP},v1=${tampered}`;

        expect(
            verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET, toleranceSec: HUGE_TOLERANCE })
        ).toBe(false);
    });

    it("rejects a tampered payload", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(
            verifyStripeSignature({
                payload: `${PAYLOAD} `,
                signature: header,
                secret: SECRET,
                toleranceSec: HUGE_TOLERANCE,
            })
        ).toBe(false);
    });

    it("rejects a stale timestamp outside the default tolerance", () => {
        const header = `t=${TIMESTAMP},v1=${GOLDEN_SIGNATURE}`;

        expect(verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET })).toBe(false);
    });

    it("rejects a malformed signature header", () => {
        expect(
            verifyStripeSignature({ payload: PAYLOAD, signature: "not-a-valid-header", secret: SECRET, toleranceSec: HUGE_TOLERANCE })
        ).toBe(false);
    });

    it("accepts a freshly signed payload within default tolerance", () => {
        const now = Math.floor(Date.now() / 1000);
        const sig = createHmac("sha256", SECRET).update(`${now}.${PAYLOAD}`).digest("hex");
        const header = `t=${now},v1=${sig}`;

        expect(verifyStripeSignature({ payload: PAYLOAD, signature: header, secret: SECRET })).toBe(true);
    });
});
