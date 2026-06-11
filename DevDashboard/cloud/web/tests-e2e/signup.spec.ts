/**
 * Sign-up page (`/signup`, anonymous). Real-state assertions: all three fields render, the
 * `?plan=pro` search param drives the plan-specific subtitle (verifying the search-param wiring), and
 * the cross-link routes to signin.
 */

import { expect, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("sign-up page", () => {
    test("renders the sign-up form (Name + Email + Password)", async ({ page }) => {
        await page.goto("/signup");

        await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
        await expect(page.getByLabel("Name")).toBeVisible();
        await expect(page.getByLabel("Email")).toBeVisible();
        await expect(page.getByLabel("Password")).toBeVisible();
    });

    test("?plan=pro shows the pro-plan subtitle", async ({ page }) => {
        await page.goto("/signup?plan=pro");
        await expect(page.getByText("Start your pro plan", { exact: false })).toBeVisible();
    });

    test("default (no plan) shows the self-host subtitle", async ({ page }) => {
        await page.goto("/signup");
        await expect(page.getByText("Self-host stays free", { exact: false })).toBeVisible();
    });

    test("'Sign in' links to /signin", async ({ page }) => {
        await page.goto("/signup");
        const link = page.getByRole("link", { name: "Sign in", exact: true });
        await expect(link).toHaveAttribute("href", "/signin");
    });
});
