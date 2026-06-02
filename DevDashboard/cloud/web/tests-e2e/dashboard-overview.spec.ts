/**
 * Dashboard Overview (`/dashboard`, authed). Asserts the REAL initial state of a brand-new account:
 * plan = free, 0 devices, subdomain not claimed, and the 4-step checklist with only step 1 done. Uses
 * a fresh isolated user so no other spec's mutations bleed into these assertions.
 */

import { expect, test } from "@playwright/test";
import { freshUserContext } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("dashboard overview", () => {
    test("new account shows free plan, 0 devices, unclaimed subdomain", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard");
        await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

        await expect(page.getByTestId("overview-plan")).toHaveText("free");
        await expect(page.getByTestId("overview-device-count")).toHaveText("0");
        await expect(page.getByTestId("overview-subdomain")).toHaveText("not claimed");

        await user.context.close();
    });

    test("checklist: only 'Account created' is done", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard");
        await expect(page.getByTestId("overview-checklist")).toBeVisible();

        await expect(page.getByTestId("overview-step-account")).toHaveAttribute("data-done", "true");
        await expect(page.getByTestId("overview-step-plan")).toHaveAttribute("data-done", "false");
        await expect(page.getByTestId("overview-step-subdomain")).toHaveAttribute("data-done", "false");
        await expect(page.getByTestId("overview-step-pair")).toHaveAttribute("data-done", "false");

        await user.context.close();
    });

    test("CTA + card links route to the sub-pages", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard");

        await expect(page.getByRole("link", { name: "Open the setup wizard" })).toHaveAttribute(
            "href",
            "/dashboard/setup"
        );
        await expect(page.getByRole("link", { name: "Manage plan" })).toHaveAttribute("href", "/dashboard/billing");
        await expect(page.getByRole("link", { name: "View devices" })).toHaveAttribute("href", "/dashboard/devices");
        await expect(page.getByRole("link", { name: "Claim one" })).toHaveAttribute("href", "/dashboard/setup");

        await user.context.close();
    });
});
