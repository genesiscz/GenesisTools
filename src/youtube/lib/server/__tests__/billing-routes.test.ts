import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { startServer } from "@app/youtube/lib/server";

// No Stripe CLI in this environment — webhook deliveries are hand-signed
// here with the same HMAC scheme `verifyStripeSignature` checks, per the
// plan's Task 3 ON-FAIL fallback.
function signStripePayload(secret: string, payloadObj: unknown): { payload: string; signature: string } {
    const payload = SafeJSON.stringify(payloadObj, { strict: true });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

    return { payload, signature: `t=${t},v1=${sig}` };
}

describe("youtube server billing routes", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "youtube-server-billing-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("returns 503 for checkout when STRIPE_SECRET_KEY is unset", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const register = await fetch(`http://localhost:${handle.port}/api/v1/users/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ email: "buyer@example.com", password: "hunter22" }),
            });
            const { token } = (await register.json()) as { token: string };

            await env.testing.withOverrides({ STRIPE_SECRET_KEY: undefined }, async () => {
                const checkout = await fetch(`http://localhost:${handle.port}/api/v1/users/checkout`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: SafeJSON.stringify({ packId: "pack-medium" }),
                });
                const body = (await checkout.json()) as { error: string };

                expect(checkout.status).toBe(503);
                expect(body.error).toBe("billing not configured");
            });
        } finally {
            await handle.stop();
        }
    });

    it("checkout rejects an unknown pack with 400", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const register = await fetch(`http://localhost:${handle.port}/api/v1/users/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ email: "buyer2@example.com", password: "hunter22" }),
            });
            const { token } = (await register.json()) as { token: string };

            await env.testing.withOverrides({ STRIPE_SECRET_KEY: "sk_test_123" }, async () => {
                const checkout = await fetch(`http://localhost:${handle.port}/api/v1/users/checkout`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: SafeJSON.stringify({ packId: "pack-huge" }),
                });

                expect(checkout.status).toBe(400);
            });
        } finally {
            await handle.stop();
        }
    });

    it("webhook grants diamonds once on checkout.session.completed; replay is a no-op; bad signature is 400", async () => {
        const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

        try {
            const register = await fetch(`http://localhost:${handle.port}/api/v1/users/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: SafeJSON.stringify({ email: "webhook-buyer@example.com", password: "hunter22" }),
            });
            const { user, token } = (await register.json()) as { user: { id: number }; token: string };
            const webhookSecret = "whsec_route_test";
            const { payload, signature } = signStripePayload(webhookSecret, {
                id: "evt_route_1",
                type: "checkout.session.completed",
                data: {
                    object: { id: "cs_route_test_1", metadata: { packId: "pack-medium", userId: String(user.id) } },
                },
            });

            await env.testing.withOverrides({ STRIPE_WEBHOOK_SECRET: webhookSecret }, async () => {
                const badSig = await fetch(`http://localhost:${handle.port}/api/v1/webhooks/stripe`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=deadbeef" },
                    body: payload,
                });
                expect(badSig.status).toBe(400);

                const first = await fetch(`http://localhost:${handle.port}/api/v1/webhooks/stripe`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
                    body: payload,
                });
                expect(first.status).toBe(200);

                const replay = await fetch(`http://localhost:${handle.port}/api/v1/webhooks/stripe`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
                    body: payload,
                });
                expect(replay.status).toBe(200);
            });

            const me = await fetch(`http://localhost:${handle.port}/api/v1/users/me`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const meBody = (await me.json()) as { user: { credits: number } };

            // 100 from the register-grant + 2000 from the webhook.
            expect(meBody.user.credits).toBe(2100);
            expect(handle.youtube.db.hasLedgerReason(user.id, "stripe:cs_route_test_1")).toBe(true);
        } finally {
            await handle.stop();
        }
    });

    it("webhook route is exempt from service-key auth", async () => {
        // resolveServiceKeys runs once at startServer() time, so the override
        // must be in place before the server starts, not just before the request.
        await env.testing.withOverrides(
            { YOUTUBE_SERVICE_KEY: "svc_only_key", STRIPE_WEBHOOK_SECRET: "whsec_open_route" },
            async () => {
                const handle = await startServer({ port: 0, baseDir: dir, startPipeline: false });

                try {
                    const { payload, signature } = signStripePayload("whsec_open_route", {
                        id: "evt_open",
                        type: "customer.created",
                        data: { object: {} },
                    });
                    const res = await fetch(`http://localhost:${handle.port}/api/v1/webhooks/stripe`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
                        body: payload,
                    });

                    expect(res.status).toBe(200);
                } finally {
                    await handle.stop();
                }
            }
        );
    });
});
