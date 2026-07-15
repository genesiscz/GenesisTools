import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Stripe webhook `Stripe-Signature` header per
 * https://stripe.com/docs/webhooks/signatures — HMAC-SHA256 of `"<t>.<payload>"`
 * using the webhook signing secret, timing-safe compared against each `v1=`
 * value in the header, with a timestamp tolerance to reject replayed bodies.
 */
export function verifyStripeSignature(opts: {
    payload: string;
    signature: string;
    secret: string;
    toleranceSec?: number;
}): boolean {
    const parsed = parseSignatureHeader(opts.signature);

    if (!parsed) {
        return false;
    }

    const tolerance = opts.toleranceSec ?? 300;
    const nowSec = Math.floor(Date.now() / 1000);

    if (Math.abs(nowSec - parsed.timestamp) > tolerance) {
        return false;
    }

    const expected = createHmac("sha256", opts.secret).update(`${parsed.timestamp}.${opts.payload}`).digest();
    let matched = false;

    for (const candidate of parsed.v1Signatures) {
        const candidateBuf = hexToBuffer(candidate);

        if (candidateBuf && candidateBuf.length === expected.length && timingSafeEqual(candidateBuf, expected)) {
            matched = true;
        }
    }

    return matched;
}

function parseSignatureHeader(header: string): { timestamp: number; v1Signatures: string[] } | null {
    const parts = header.split(",").map((part) => part.trim());
    let timestamp: number | null = null;
    const v1Signatures: string[] = [];

    for (const part of parts) {
        const [key, value] = part.split("=", 2);

        if (key === "t" && value) {
            timestamp = Number.parseInt(value, 10);
        } else if (key === "v1" && value) {
            v1Signatures.push(value);
        }
    }

    if (timestamp === null || Number.isNaN(timestamp) || v1Signatures.length === 0) {
        return null;
    }

    return { timestamp, v1Signatures };
}

function hexToBuffer(hex: string): Buffer | null {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
        return null;
    }

    return Buffer.from(hex, "hex");
}
