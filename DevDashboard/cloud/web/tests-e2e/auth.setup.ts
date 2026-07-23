/**
 * Auth bypass = programmatic signup against the REAL Better-Auth API, then persist the cookie jar as
 * Playwright storageState. ZERO app-source changes: this hits the live `/api/auth/sign-up/email`
 * endpoint (the same one the UI uses), so it exercises the real auth stack at the highest fidelity.
 *
 * Authed specs declare `test.use({ storageState: STORAGE_STATE })` to reuse the resulting session
 * cookie. This `setup` project is a dependency of the authed `chromium` project (see
 * playwright.config.ts), so it runs once before the authed specs.
 */

import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

setup("authenticate", async ({ context }) => {
    // Use the BROWSER context's request (not the standalone `request` fixture) so the Better-Auth
    // Set-Cookie lands in the context's cookie jar — that is what context.storageState() persists.
    const email = `e2e+${Date.now()}@devdashboard.app`;
    const res = await context.request.post("/api/auth/sign-up/email", {
        data: { email, password: "supersecret123", name: "E2E Tester" },
    });

    expect(res.ok(), `sign-up should return 2xx, got ${res.status()}: ${await res.text()}`).toBeTruthy();

    await context.storageState({ path: STORAGE_STATE });

    // Warm the on-demand-compiled routes once (authed). The Vite DEV server compiles each route lazily
    // on its first hit; doing it serially here means the parallel specs hit already-compiled routes
    // instead of racing the cold transform (which transiently throws "(intermediate value) is not a
    // function" and bounces to the error boundary).
    const warm = await context.newPage();

    for (const path of ["/", "/signin", "/signup", "/dashboard", "/dashboard/setup", "/dashboard/devices", "/dashboard/settings", "/dashboard/billing"]) {
        await warm.goto(path, { waitUntil: "networkidle" });
    }

    await warm.close();
});
