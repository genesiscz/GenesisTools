import { createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { DIAMOND_PACKS, type DiamondPack } from "@app/youtube/lib/billing.types";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { YtUser } from "@app/youtube/lib/users.types";

/**
 * Creates a Stripe Checkout session for a diamond pack via the Stripe REST API
 * directly (no SDK dependency). `origin` is accepted for interface symmetry
 * with the route layer but unused — per spec, success/cancel both point at
 * https://www.youtube.com (the extension polls balance; no landing page).
 */
export async function createCheckoutSession(opts: {
    user: YtUser;
    packId: string;
    origin: string;
}): Promise<{ url: string }> {
    const pack = DIAMOND_PACKS.find((candidate) => candidate.id === opts.packId);

    if (!pack) {
        throw new Error(`unknown diamond pack: ${opts.packId}`);
    }

    const secretKey = env.stripe.getSecretKey();

    if (!secretKey) {
        throw new Error("billing not configured");
    }

    const priceEnvKey = priceEnvKeyForPack(pack.id);
    const priceId = env.getTrimmed(priceEnvKey);

    if (!priceId) {
        throw new Error(`billing not configured: ${priceEnvKey} unset`);
    }

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("client_reference_id", String(opts.user.id));
    body.set("line_items[0][price]", priceId);
    body.set("line_items[0][quantity]", "1");
    body.set("metadata[packId]", pack.id);
    body.set("metadata[userId]", String(opts.user.id));
    // Session-level metadata does not auto-propagate to the resulting charge —
    // set it on the PaymentIntent too so charge.refunded can attribute the refund.
    body.set("payment_intent_data[metadata][userId]", String(opts.user.id));
    body.set("payment_intent_data[metadata][packId]", pack.id);
    body.set("success_url", "https://www.youtube.com");
    body.set("cancel_url", "https://www.youtube.com");

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    if (!res.ok) {
        const detail = await res.text().catch((err) => {
            logger.debug({ error: err }, "youtube billing: failed to read stripe error body");
            return "";
        });
        logger.warn(
            { status: res.status, detail: detail.slice(0, 500) },
            "youtube billing: checkout session create failed"
        );
        throw new Error(`stripe checkout session create failed: ${res.status}`);
    }

    const data = (await res.json()) as { url?: string };

    if (!data.url) {
        throw new Error("stripe checkout session response missing url");
    }

    return { url: data.url };
}

interface StripeEvent {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
}

/**
 * Verifies and applies a Stripe webhook event. `checkout.session.completed`
 * grants the purchased pack's diamonds (idempotent on the ledger reason
 * `stripe:<sessionId>`); `charge.refunded` reverses it (idempotent on
 * `stripe-refund:<chargeId>`). All other event types are acknowledged and
 * ignored.
 */
export async function handleStripeEvent(db: YoutubeDatabase, payload: string, signature: string): Promise<void> {
    const secret = env.stripe.getWebhookSecret();

    if (!secret) {
        throw new Error("STRIPE_WEBHOOK_SECRET not configured");
    }

    if (!verifyStripeSignature({ payload, signature, secret })) {
        throw new Error("invalid stripe webhook signature");
    }

    const event = SafeJSON.parse(payload, { strict: true }) as StripeEvent;

    if (event.type === "checkout.session.completed") {
        applyCheckoutCompleted(db, event.data.object);
        return;
    }

    if (event.type === "charge.refunded") {
        applyChargeRefunded(db, event.data.object);
        return;
    }

    logger.debug({ type: event.type, id: event.id }, "youtube billing: unhandled stripe event type");
}

function applyCheckoutCompleted(db: YoutubeDatabase, session: Record<string, unknown>): void {
    const sessionId = typeof session.id === "string" ? session.id : null;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const packId = typeof metadata.packId === "string" ? metadata.packId : null;
    const userId = parseUserId(metadata.userId ?? session.client_reference_id);

    if (!sessionId || !packId || userId === null) {
        logger.warn({ sessionId, packId, userId }, "youtube billing: checkout.session.completed missing fields");
        return;
    }

    const pack = DIAMOND_PACKS.find((candidate) => candidate.id === packId);

    if (!pack) {
        logger.warn({ sessionId, packId }, "youtube billing: checkout.session.completed unknown pack");
        return;
    }

    const reason = `stripe:${sessionId}` as const;

    if (db.hasLedgerReason(userId, reason)) {
        logger.debug({ sessionId, userId }, "youtube billing: checkout.session.completed already granted");
        return;
    }

    db.grantCredits(userId, pack.diamonds, reason);
    logger.info({ sessionId, userId, diamonds: pack.diamonds }, "youtube billing: granted diamonds from checkout");
}

function applyChargeRefunded(db: YoutubeDatabase, charge: Record<string, unknown>): void {
    const chargeId = typeof charge.id === "string" ? charge.id : null;
    const metadata = (charge.metadata ?? {}) as Record<string, unknown>;
    const packId = typeof metadata.packId === "string" ? metadata.packId : null;
    const userId = parseUserId(metadata.userId);

    if (!chargeId || !packId || userId === null) {
        logger.warn({ chargeId, packId, userId }, "youtube billing: charge.refunded missing metadata, skipping");
        return;
    }

    const pack = DIAMOND_PACKS.find((candidate) => candidate.id === packId);

    if (!pack) {
        logger.warn({ chargeId, packId }, "youtube billing: charge.refunded unknown pack");
        return;
    }

    const reason = `stripe-refund:${chargeId}` as const;

    if (db.hasLedgerReason(userId, reason)) {
        logger.debug({ chargeId, userId }, "youtube billing: charge.refunded already reversed");
        return;
    }

    db.grantCredits(userId, -pack.diamonds, reason);
    logger.info({ chargeId, userId, diamonds: -pack.diamonds }, "youtube billing: reversed diamonds from refund");
}

function parseUserId(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? null : parsed;
    }

    return null;
}

function priceEnvKeyForPack(packId: DiamondPack["id"]): string {
    switch (packId) {
        case "pack-small":
            return "STRIPE_PRICE_PACK_SMALL";
        case "pack-medium":
            return "STRIPE_PRICE_PACK_MEDIUM";
        case "pack-large":
            return "STRIPE_PRICE_PACK_LARGE";
    }
}

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
