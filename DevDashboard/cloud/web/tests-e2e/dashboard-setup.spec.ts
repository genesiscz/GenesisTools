/**
 * Setup wizard (`/dashboard/setup`, authed). Exercises the real server-fn round-trips against a fresh
 * isolated user: claiming a subdomain (demo-mode note + reserved hostname because CLOUDFLARE_* is
 * unset), client-side validation of a bad name, and pairing a device (success row).
 */

import { expect, test } from "@playwright/test";
import { fillHydrated, freshUserContext, selectHydrated } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("setup wizard", () => {
    test("renders all 3 steps with the agent command", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/setup");
        await expect(page.getByRole("heading", { name: "Setup wizard" })).toBeVisible();
        await expect(page.getByTestId("setup-step-1")).toContainText("agent start");
        await expect(page.getByTestId("setup-step-2")).toBeVisible();
        await expect(page.getByTestId("setup-step-3")).toBeVisible();

        await user.context.close();
    });

    test("claiming a valid subdomain shows the demo-mode note + reserved hostname", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/setup");
        const name = `e2e-mac-${Date.now() % 100000}`;
        await fillHydrated(page.getByTestId("setup-subdomain-input"), name);
        await page.getByTestId("setup-subdomain-submit").click();

        // CLOUDFLARE_* is unset in the test env → the provisioner returns configured:false with a note.
        await expect(page.getByTestId("setup-subdomain-note")).toContainText("not yet live on the edge");
        // After router.invalidate the step shows the reserved hostname.
        await expect(page.getByTestId("setup-subdomain-hostname")).toHaveText(`${name}.devdashboard.app`);

        await user.context.close();
    });

    test("an invalid subdomain name surfaces an inline validation error", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/setup");
        await page.getByTestId("setup-subdomain-input").fill("A_B C!");
        await page.getByTestId("setup-subdomain-submit").click();

        await expect(page.getByTestId("setup-subdomain-error")).toBeVisible();
        // No note appears (the round-trip was never made).
        await expect(page.getByTestId("setup-subdomain-note")).toHaveCount(0);

        await user.context.close();
    });

    test("pairing a device shows the success row", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/setup");
        await fillHydrated(page.getByTestId("setup-pair-label"), "Studio Mac");
        await selectHydrated(page.getByTestId("setup-pair-kind"), "agent");
        await fillHydrated(page.getByTestId("setup-pair-publickey"), "AAAA1111BBBB2222CCCC3333DDDD4444");
        await fillHydrated(page.getByTestId("setup-pair-devicecode"), "4821-9930");
        await page.getByTestId("setup-pair-submit").click();

        await expect(page.getByTestId("setup-pair-success")).toContainText("Studio Mac");

        await user.context.close();
    });
});
