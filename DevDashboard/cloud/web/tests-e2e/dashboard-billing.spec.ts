/**
 * Billing page (`/dashboard/billing`, authed). With Stripe unconfigured in the test env, asserts the
 * real demo state: current tier = free, the "Demo mode" banner is shown, and clicking "Upgrade to
 * Pro" surfaces the inert-checkout note (no crash, no navigation) from createCheckoutSession.
 */

import { expect, test } from "@playwright/test";
import { clickUntil, freshUserContext } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("billing page", () => {
    test("shows the free tier + Stripe demo-mode banner", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/billing");
        await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();

        await expect(page.getByTestId("billing-current-tier")).toHaveText("free");
        await expect(page.getByTestId("billing-demo-banner")).toBeVisible();
        await expect(page.getByTestId("billing-demo-banner")).toContainText("Stripe is not configured");

        // Both paid plan cards render.
        await expect(page.getByTestId("billing-plan-pro")).toBeVisible();
        await expect(page.getByTestId("billing-plan-team")).toBeVisible();

        await user.context.close();
    });

    test("'Upgrade to Pro' surfaces the inert-checkout note", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/billing");
        // Retry the click until the note appears — absorbs the dev server's per-route hydration lag (a
        // click before onClick hydrates is a no-op). startCheckout is idempotent in demo mode.
        await clickUntil(page.getByTestId("billing-upgrade-pro"), async () => {
            await expect(page.getByTestId("billing-note")).toContainText("Checkout is disabled in this environment");
        });
        // Stayed on the billing page (no Stripe redirect).
        await expect(page).toHaveURL(/\/dashboard\/billing$/);

        await user.context.close();
    });
});
