/**
 * Proof spec for the e2e harness:
 *  1. An ANONYMOUS visitor to /dashboard is redirected to /signin (the beforeLoad guard).
 *  2. An AUTHED visitor (via the storageState cookie saved by auth.setup.ts) reaches /dashboard and
 *     sees the Overview render.
 *
 * Spec 2 reuses the chromium project's default storageState (the signed-up session cookie). Spec 1
 * overrides it to an empty cookie jar to assert the anon redirect.
 */

import { expect, test } from "@playwright/test";

test.describe("anonymous dashboard guard", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("redirects /dashboard to /signin when signed out", async ({ page }) => {
        await page.goto("/dashboard");
        await page.waitForURL("**/signin");
        await expect(page).toHaveURL(/\/signin$/);
        await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    });
});

test.describe("authenticated dashboard", () => {
    test("renders the Overview at /dashboard", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
        await expect(page.getByText("Get remote in 4 steps")).toBeVisible();
    });
});
