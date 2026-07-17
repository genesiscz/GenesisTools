import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import {
    DIAMOND_PACKS,
    type DiamondPack,
    LOW_BALANCE_THRESHOLD,
    type MeBillingContext,
    SUBSCRIPTION_PLANS,
    type SubscriptionStatus,
} from "@app/youtube/lib/billing.types";
import {
    computeAllowanceReset,
    computePeriodState,
    monthKeyUtc,
    toSubscriptionStatus,
} from "@app/youtube/lib/billing-cycle";
import { createStripeGateway, type StripeGateway } from "@app/youtube/lib/billing-gateway";
import type { YoutubeConfig } from "@app/youtube/lib/config";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import type { CreditReason, YtUser } from "@app/youtube/lib/users.types";

/**
 * Creates a Stripe Checkout session for a diamond pack. The outbound call goes
 * through `billing-gateway.ts` (the official Stripe SDK); tests inject a fake
 * gateway and never hit the network. `origin` is accepted for interface
 * symmetry with the route layer but unused — per spec, success/cancel both
 * point at https://www.youtube.com (the extension polls balance; no landing page).
 */
export async function createCheckoutSession(opts: {
    user: YtUser;
    packId: string;
    origin: string;
    /** Test seam — production callers omit it and get the SDK gateway. */
    gateway?: StripeGateway;
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

    const gateway = opts.gateway ?? createStripeGateway(secretKey);
    const session = await gateway.createPackCheckout({ priceId, userId: opts.user.id, packId: pack.id });

    return { url: session.url };
}

/** Subscription checkout for a monthly plan. Mirrors the pack flow: env-gated, gateway-backed. */
export async function createSubscriptionCheckoutSession(opts: {
    user: YtUser;
    planId: string;
    origin: string;
    gateway?: StripeGateway;
}): Promise<{ url: string }> {
    const plan = SUBSCRIPTION_PLANS.find((candidate) => candidate.id === opts.planId);

    if (!plan) {
        throw new Error(`unknown subscription plan: ${opts.planId}`);
    }

    const secretKey = env.stripe.getSecretKey();

    if (!secretKey) {
        throw new Error("billing not configured");
    }

    const priceId = env.getTrimmed("STRIPE_PRICE_SUB_MONTHLY");

    if (!priceId) {
        throw new Error("billing not configured: STRIPE_PRICE_SUB_MONTHLY unset");
    }

    const gateway = opts.gateway ?? createStripeGateway(secretKey);
    const session = await gateway.createSubscriptionCheckout({ priceId, userId: opts.user.id, planId: plan.id });

    return { url: session.url };
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
    const existing = db.getWebhookLog(event.id);

    if (existing && existing.outcome !== "error") {
        logger.debug({ eventId: event.id, type: event.type }, "youtube billing: duplicate webhook delivery ignored");
        return;
    }

    const payloadHash = createHash("sha256").update(payload).digest("hex");

    try {
        const outcome = applyStripeEvent(db, event);
        db.recordWebhookLog({ stripeEventId: event.id, type: event.type, payloadHash, outcome });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        db.recordWebhookLog({ stripeEventId: event.id, type: event.type, payloadHash, outcome: "error", detail });
        // Rethrow → route answers 400 → Stripe retries; the retry reprocesses
        // because an "error" outcome does not short-circuit above.
        throw error;
    }
}

function applyStripeEvent(db: YoutubeDatabase, event: StripeEvent): "processed" | "skipped" {
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        return applyCheckoutCompleted(db, event.data.object);
    }

    if (event.type === "invoice.paid") {
        return applyInvoicePaid(db, event.data.object);
    }

    if (event.type === "invoice.payment_failed") {
        return applyInvoicePaymentFailed(db, event.data.object);
    }

    if (event.type === "customer.subscription.updated") {
        return applySubscriptionUpdated(db, event.data.object);
    }

    if (event.type === "customer.subscription.deleted") {
        return applySubscriptionDeleted(db, event.data.object);
    }

    if (event.type === "charge.refunded") {
        return applyChargeRefunded(db, event.data.object);
    }

    logger.debug({ type: event.type, id: event.id }, "youtube billing: unhandled stripe event type");

    return "skipped";
}

function applyCheckoutCompleted(db: YoutubeDatabase, session: Record<string, unknown>): "processed" | "skipped" {
    if (session.mode === "subscription") {
        return applySubscriptionCheckout(db, session);
    }

    const sessionId = typeof session.id === "string" ? session.id : null;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const packId = typeof metadata.packId === "string" ? metadata.packId : null;
    const userId = parseUserId(metadata.userId ?? session.client_reference_id);

    if (!sessionId || !packId || userId === null) {
        logger.warn({ sessionId, packId, userId }, "youtube billing: checkout.session.completed missing fields");
        return "skipped";
    }

    const pack = DIAMOND_PACKS.find((candidate) => candidate.id === packId);

    if (!pack) {
        logger.warn({ sessionId, packId }, "youtube billing: checkout.session.completed unknown pack");
        return "skipped";
    }

    // Delayed payment methods fire checkout.session.completed before the money
    // settles; only fulfill once payment_status is "paid". The later
    // checkout.session.async_payment_succeeded re-enters here with "paid" and
    // grants then (idempotent on the stripe:<sessionId> ledger reason).
    const paymentStatus = typeof session.payment_status === "string" ? session.payment_status : null;

    if (paymentStatus !== "paid") {
        logger.info(
            { sessionId, userId, paymentStatus },
            "youtube billing: checkout.session not paid yet, deferring grant"
        );
        return "skipped";
    }

    const reason = `stripe:${sessionId}` as const;

    if (db.hasLedgerReason(userId, reason)) {
        logger.debug({ sessionId, userId }, "youtube billing: checkout.session.completed already granted");
        return "processed";
    }

    db.grantCredits(userId, pack.diamonds, reason);
    db.recordPayment({
        userId,
        kind: "pack",
        stripeRef: sessionId,
        packId: pack.id,
        amountCents: typeof session.amount_total === "number" ? session.amount_total : null,
        currency: typeof session.currency === "string" ? session.currency : null,
        credits: pack.diamonds,
        status: "succeeded",
    });
    logger.info({ sessionId, userId, diamonds: pack.diamonds }, "youtube billing: granted diamonds from checkout");

    return "processed";
}

function applyChargeRefunded(db: YoutubeDatabase, charge: Record<string, unknown>): "processed" | "skipped" {
    const chargeId = typeof charge.id === "string" ? charge.id : null;
    const metadata = (charge.metadata ?? {}) as Record<string, unknown>;
    const packId = typeof metadata.packId === "string" ? metadata.packId : null;
    const userId = parseUserId(metadata.userId);

    if (!chargeId || !packId || userId === null) {
        logger.warn({ chargeId, packId, userId }, "youtube billing: charge.refunded missing metadata, skipping");
        return "skipped";
    }

    const pack = DIAMOND_PACKS.find((candidate) => candidate.id === packId);

    if (!pack) {
        logger.warn({ chargeId, packId }, "youtube billing: charge.refunded unknown pack");
        return "skipped";
    }

    const reason = `stripe-refund:${chargeId}` as const;

    if (db.hasLedgerReason(userId, reason)) {
        logger.debug({ chargeId, userId }, "youtube billing: charge.refunded already reversed");
        return "processed";
    }

    // charge.refunded fires for partial refunds too. The idempotency key is per
    // charge (stripe-refund:<chargeId>, DB-unique via credit_ledger), so credits
    // are reversed exactly once per charge — reverse only the refunded share so a
    // small partial refund cannot wipe the whole pack. Missing amount fields
    // (minimal/legacy events) fall back to a full reversal.
    const amount = typeof charge.amount === "number" ? charge.amount : null;
    const amountRefunded = typeof charge.amount_refunded === "number" ? charge.amount_refunded : null;
    let reversal = pack.diamonds;
    let partial = false;

    if (amount !== null && amount > 0 && amountRefunded !== null && amountRefunded < amount) {
        reversal = Math.floor((pack.diamonds * amountRefunded) / amount);
        partial = true;
    }

    db.grantCredits(userId, -reversal, reason);
    db.recordPayment({
        userId,
        kind: "refund",
        stripeRef: `refund:${chargeId}`,
        packId: pack.id,
        amountCents: amountRefunded,
        currency: typeof charge.currency === "string" ? charge.currency : null,
        credits: -reversal,
        status: "refunded",
    });
    logger.info({ chargeId, userId, diamonds: -reversal, partial }, "youtube billing: reversed diamonds from refund");

    return "processed";
}

function applySubscriptionCheckout(db: YoutubeDatabase, session: Record<string, unknown>): "processed" | "skipped" {
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const userId = parseUserId(metadata.userId ?? session.client_reference_id);
    const planId = typeof metadata.planId === "string" ? metadata.planId : null;
    const plan = SUBSCRIPTION_PLANS.find((candidate) => candidate.id === planId);

    if (userId === null || !plan) {
        logger.warn({ userId, planId }, "youtube billing: subscription checkout missing user/plan metadata");

        return "skipped";
    }

    // Period fields stay null until the first invoice.paid — that is also the
    // signal for "grant the initial allowance additively" (see applyInvoicePaid).
    db.upsertSubscription({
        userId,
        stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
        stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
        planId: plan.id,
        status: "active",
        allowance: plan.allowance,
    });
    logger.info({ userId, planId: plan.id }, "youtube billing: subscription created from checkout");

    return "processed";
}

function applyInvoicePaid(db: YoutubeDatabase, invoice: Record<string, unknown>): "processed" | "skipped" {
    const invoiceId = typeof invoice.id === "string" ? invoice.id : null;
    const stripeSubscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : null;

    if (!invoiceId || !stripeSubscriptionId) {
        logger.warn({ invoiceId, stripeSubscriptionId }, "youtube billing: invoice.paid missing fields");

        return "skipped";
    }

    const sub = db.getSubscriptionByStripeId(stripeSubscriptionId);

    if (!sub) {
        logger.warn({ invoiceId, stripeSubscriptionId }, "youtube billing: invoice.paid for unknown subscription");

        return "skipped";
    }

    const reason: CreditReason = `sub-allowance:${invoiceId}`;

    if (db.hasLedgerReason(sub.userId, reason)) {
        logger.debug({ invoiceId, userId: sub.userId }, "youtube billing: allowance already granted for invoice");

        return "processed";
    }

    const balance = db.getUserCredits(sub.userId);

    if (balance === null) {
        logger.warn({ invoiceId, userId: sub.userId }, "youtube billing: invoice.paid for missing user");

        return "skipped";
    }

    const period = invoicePeriod(invoice);
    let delta: number;
    let newBalance: number;

    if (sub.periodStart === null) {
        // First invoice: the user never had an allowance — plain additive grant.
        delta = sub.allowance;
        newBalance = balance + delta;
    } else {
        const reset = computeAllowanceReset({
            balance,
            periodStartBalance: sub.periodStartBalance,
            grantsSince: db.getGrantsSince(sub.userId, sub.periodStart),
            allowanceGranted: sub.allowance,
            newAllowance: sub.allowance,
        });
        delta = reset.delta;
        newBalance = reset.newBalance;
    }

    // A delta of 0 (unspent renewal) still writes the ledger row — the reset
    // itself is an auditable event, and it doubles as the idempotency marker.
    db.grantCredits(sub.userId, delta, reason);
    db.updateSubscription(sub.id, {
        status: "active",
        periodStart: period.start,
        periodEnd: period.end,
        periodStartBalance: newBalance,
    });
    db.recordPayment({
        userId: sub.userId,
        kind: "subscription",
        stripeRef: invoiceId,
        planId: sub.planId,
        amountCents: typeof invoice.amount_paid === "number" ? invoice.amount_paid : null,
        currency: typeof invoice.currency === "string" ? invoice.currency : null,
        credits: delta,
        status: "succeeded",
    });
    logger.info({ invoiceId, userId: sub.userId, delta, newBalance }, "youtube billing: allowance period applied");

    return "processed";
}

function applyInvoicePaymentFailed(db: YoutubeDatabase, invoice: Record<string, unknown>): "processed" | "skipped" {
    const invoiceId = typeof invoice.id === "string" ? invoice.id : null;
    const stripeSubscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : null;
    const sub = stripeSubscriptionId ? db.getSubscriptionByStripeId(stripeSubscriptionId) : null;

    if (!invoiceId || !sub) {
        logger.warn({ invoiceId, stripeSubscriptionId }, "youtube billing: payment_failed for unknown subscription");

        return "skipped";
    }

    db.updateSubscription(sub.id, { status: "past_due" });
    // `failed:` prefix keeps the ref distinct from the eventual invoice.paid
    // row for the same invoice (stripe_ref is UNIQUE).
    db.recordPayment({
        userId: sub.userId,
        kind: "subscription",
        stripeRef: `failed:${invoiceId}`,
        planId: sub.planId,
        amountCents: typeof invoice.amount_due === "number" ? invoice.amount_due : null,
        currency: typeof invoice.currency === "string" ? invoice.currency : null,
        status: "failed",
    });
    logger.warn({ invoiceId, userId: sub.userId }, "youtube billing: subscription payment failed");

    return "processed";
}

function applySubscriptionUpdated(db: YoutubeDatabase, subscription: Record<string, unknown>): "processed" | "skipped" {
    const stripeId = typeof subscription.id === "string" ? subscription.id : null;
    const sub = stripeId ? db.getSubscriptionByStripeId(stripeId) : null;

    if (!sub) {
        logger.warn({ stripeId }, "youtube billing: subscription.updated for unknown subscription");

        return "skipped";
    }

    const periodEnd =
        typeof subscription.current_period_end === "number"
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : undefined;
    db.updateSubscription(sub.id, {
        status: mapStripeSubscriptionStatus(subscription.status),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        ...(periodEnd !== undefined ? { periodEnd } : {}),
    });

    return "processed";
}

function applySubscriptionDeleted(db: YoutubeDatabase, subscription: Record<string, unknown>): "processed" | "skipped" {
    const stripeId = typeof subscription.id === "string" ? subscription.id : null;
    const sub = stripeId ? db.getSubscriptionByStripeId(stripeId) : null;

    if (!sub) {
        logger.warn({ stripeId }, "youtube billing: subscription.deleted for unknown subscription");

        return "skipped";
    }

    // Credits already granted stay — no clawback on cancellation.
    db.updateSubscription(sub.id, { status: "canceled" });
    logger.info({ userId: sub.userId }, "youtube billing: subscription canceled");

    return "processed";
}

function mapStripeSubscriptionStatus(raw: unknown): SubscriptionStatus {
    if (raw === "canceled" || raw === "incomplete_expired") {
        return "canceled";
    }

    if (raw === "past_due" || raw === "unpaid" || raw === "incomplete") {
        return "past_due";
    }

    return "active";
}

function invoicePeriod(invoice: Record<string, unknown>): { start: string; end: string | null } {
    const lines = invoice.lines as { data?: Array<{ period?: { start?: number; end?: number } }> } | undefined;
    const period = lines?.data?.[0]?.period;

    return {
        start:
            typeof period?.start === "number" ? new Date(period.start * 1000).toISOString() : new Date().toISOString(),
        end: typeof period?.end === "number" ? new Date(period.end * 1000).toISOString() : null,
    };
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

/** Balance context for GET /users/me — one authoritative read for client nudges. */
export async function buildBillingContext(opts: {
    db: YoutubeDatabase;
    config: YoutubeConfig;
    user: YtUser;
}): Promise<MeBillingContext> {
    const sub = opts.db.getSubscriptionByUserId(opts.user.id);
    let subscription: MeBillingContext["subscription"] = null;

    if (sub && sub.status !== "canceled") {
        const allowanceRemaining =
            sub.periodStart === null
                ? 0
                : computePeriodState({
                      balance: opts.user.credits,
                      periodStartBalance: sub.periodStartBalance,
                      grantsSince: opts.db.getGrantsSince(opts.user.id, sub.periodStart),
                      allowanceGranted: sub.allowance,
                  }).allowanceRemaining;
        subscription = {
            planId: sub.planId,
            status: toSubscriptionStatus(sub.status),
            periodEnd: sub.periodEnd,
            allowance: sub.allowance,
            allowanceRemaining,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        };
    }

    const freeTier = await opts.config.get("freeTier");
    let freeQuota: MeBillingContext["freeQuota"] = null;

    if (freeTier.actionsPerMonth !== null && subscription === null && !opts.db.hasAnyStripeGrant(opts.user.id)) {
        const month = monthKeyUtc();
        freeQuota = { used: opts.db.getQuotaUsed(opts.user.id, month), limit: freeTier.actionsPerMonth, month };
    }

    return { subscription, freeQuota, lowBalance: opts.user.credits < LOW_BALANCE_THRESHOLD };
}
