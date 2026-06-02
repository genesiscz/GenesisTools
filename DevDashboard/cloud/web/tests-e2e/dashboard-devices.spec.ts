/**
 * Devices page (`/dashboard/devices`, authed). Asserts the empty state for a fresh account, then seeds
 * a device through the real pair flow (setup wizard UI) and verifies the row renders with its label +
 * kind and that "Remove" actually deletes it (the row disappears + empty state returns).
 */

import { expect, test, type Page } from "@playwright/test";
import { fillHydrated, freshUserContext, selectHydrated } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

async function pairDeviceViaSetup(page: Page, label: string, kind: "phone" | "agent"): Promise<void> {
    await page.goto("/dashboard/setup");
    await fillHydrated(page.getByTestId("setup-pair-label"), label);
    await selectHydrated(page.getByTestId("setup-pair-kind"), kind);
    await fillHydrated(page.getByTestId("setup-pair-publickey"), "AAAA1111BBBB2222CCCC3333DDDD4444");
    await fillHydrated(page.getByTestId("setup-pair-devicecode"), "4821-9930");
    await page.getByTestId("setup-pair-submit").click();
    await expect(page.getByTestId("setup-pair-success")).toBeVisible();
}

test.describe("devices page", () => {
    test("fresh account shows the empty state", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await page.goto("/dashboard/devices");
        await expect(page.getByTestId("devices-empty")).toBeVisible();
        await expect(page.getByTestId("devices-empty")).toContainText("No devices paired yet");

        await user.context.close();
    });

    test("a paired device shows its label + kind, and Remove deletes it", async ({ browser }) => {
        const user = await freshUserContext(browser);
        const page = await user.context.newPage();

        await pairDeviceViaSetup(page, "Studio Mac", "agent");

        await page.goto("/dashboard/devices");
        const list = page.getByTestId("devices-list");
        await expect(list).toBeVisible();

        const row = page.locator('[data-testid^="device-row-"]').first();
        await expect(row.getByTestId("device-label")).toHaveText("Studio Mac");
        await expect(row.getByTestId("device-kind")).toHaveText("agent");

        // Remove it → the row disappears and the empty state returns.
        await row.getByRole("button", { name: "Remove" }).click();
        await expect(page.getByTestId("devices-empty")).toBeVisible();
        await expect(page.locator('[data-testid^="device-row-"]')).toHaveCount(0);

        await user.context.close();
    });
});
