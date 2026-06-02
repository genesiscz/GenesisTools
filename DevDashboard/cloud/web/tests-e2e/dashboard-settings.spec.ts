/**
 * Settings page (`/dashboard/settings`, authed). The push-alerts toggle defaults to ON for a fresh
 * account; toggling it persists through `updateSettings` and survives a reload (proving the real
 * server round-trip, not just optimistic local state). Uses a fresh isolated user.
 */

import { expect, test } from "@playwright/test";
import { freshUserContext } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("settings page", () => {
    test("push-alerts defaults to on and persists when toggled off", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/settings");
        const toggle = page.getByTestId("settings-push-alerts");

        // Fresh account default: on.
        await expect(toggle).toHaveAttribute("aria-checked", "true");
        await expect(toggle).toHaveAttribute("data-state", "on");

        // Toggle off → the server save lands ("Saved").
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "false");
        await expect(page.getByTestId("settings-status")).toHaveText("Saved");

        // Reload → the new value persisted (loaded from updateSettings, not optimistic state).
        await page.reload();
        await expect(page.getByTestId("settings-push-alerts")).toHaveAttribute("aria-checked", "false");

        await user.context.close();
    });
});
