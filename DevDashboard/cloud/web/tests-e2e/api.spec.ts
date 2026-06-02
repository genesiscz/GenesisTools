/**
 * Server-route smoke (no UI). Hits the real API endpoints directly: anonymous get-session returns
 * null, the Stripe webhook acks inert without a signature, and a duplicate signup is rejected by
 * Better-Auth. Uses the standalone `request` fixture (no cookies).
 */

import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("api routes", () => {
    test("GET /api/auth/get-session returns null when anonymous", async ({ request }) => {
        const res = await request.get("/api/auth/get-session");
        expect(res.status()).toBe(200);
        const body = await res.text();
        // Better-Auth returns null (or an empty body) for an anonymous session.
        expect(body === "null" || body === "" || body === "{}").toBeTruthy();
    });

    test("POST /api/stripe/webhook acks inert without a signature", async ({ request }) => {
        const res = await request.post("/api/stripe/webhook", { data: { type: "noop" } });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ received: true, configured: false });
    });

    test("POST /api/auth/sign-up/email rejects a duplicate email", async ({ request }) => {
        const email = `e2e-dup+${Date.now()}-${process.pid}@devdashboard.app`;
        const data = { email, password: "supersecret123", name: "Dup Tester" };

        const first = await request.post("/api/auth/sign-up/email", { data });
        expect(first.ok(), `first signup should succeed, got ${first.status()}`).toBeTruthy();

        const second = await request.post("/api/auth/sign-up/email", { data });
        expect(second.ok(), "duplicate signup must NOT return 2xx").toBeFalsy();
    });
});
