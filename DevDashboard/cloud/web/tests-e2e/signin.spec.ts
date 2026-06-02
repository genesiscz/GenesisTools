/**
 * Sign-in page (`/signin`, anonymous). Real-state assertions: the correct fields render (no Name
 * field), bad credentials surface the inline error from the live auth call, and the cross-link routes
 * to signup.
 */

import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("sign-in page", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/signin");
    });

    test("renders the sign-in form (Email + Password, no Name)", async ({ page }) => {
        await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
        await expect(page.getByLabel("Email")).toBeVisible();
        await expect(page.getByLabel("Password")).toBeVisible();
        await expect(page.getByLabel("Name")).toHaveCount(0);
    });

    test("bad credentials surface the inline error", async ({ page }) => {
        await page.getByLabel("Email").fill(`nobody+${Date.now()}@devdashboard.app`);
        await page.getByLabel("Password").fill("wrong-password-xyz");
        await page.getByRole("button", { name: "Sign in" }).click();

        await expect(page.getByTestId("auth-error")).toBeVisible();
        // Still on /signin (the failed sign-in must not navigate to the dashboard).
        await expect(page).toHaveURL(/\/signin$/);
    });

    test("'Create an account' links to /signup", async ({ page }) => {
        const link = page.getByRole("link", { name: "Create an account" });
        await expect(link).toHaveAttribute("href", "/signup");
    });
});
