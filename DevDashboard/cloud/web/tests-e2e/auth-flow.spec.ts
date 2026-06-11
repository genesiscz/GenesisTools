/**
 * The ONE end-to-end UI auth flow (anon → authed → signed-out): drive the real signup form, land on
 * the dashboard, prove the session persists across a reload, then sign out and prove the route guard
 * sends an anonymous visitor back to /signin. This is the highest-fidelity check that the whole auth
 * stack (form → Better-Auth → cookie → beforeLoad guard) works together.
 */

import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test("UI signup → dashboard → reload persists → sign out → guarded", async ({ page }) => {
    const email = `e2e-ui+${Date.now()}-${process.pid}@devdashboard.app`;

    // Wait for the client bundle to load AND hydrate before interacting. Clicking "Create account"
    // before the React onSubmit (which preventDefault()s) is attached lets the native <form> do a GET
    // submit to "/signup?" and the SPA never navigates — that is the hydration race we guard against.
    await page.goto("/signup", { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean((window as unknown as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__));

    await page.getByLabel("Name").fill("E2E UI Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("supersecret123");
    await page.getByRole("button", { name: "Create account" }).click();

    // Lands on the dashboard, authed.
    await page.waitForURL("**/dashboard", { timeout: 15_000 });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // Session survives a hard reload.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    // Sign out → back to /signin.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/signin");
    await expect(page).toHaveURL(/\/signin$/);

    // The guard now redirects an anon visit to /dashboard back to /signin.
    await page.goto("/dashboard");
    await page.waitForURL("**/signin");
    await expect(page).toHaveURL(/\/signin$/);
});
