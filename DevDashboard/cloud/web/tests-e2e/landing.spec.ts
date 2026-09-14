/**
 * Landing page (`/`, anonymous). Asserts REAL data-driven state: every claim is checked against the
 * shared source of truth (PRICING_PLANS, NAV_LINKS, TIER_POLICY) so the marketing copy can never
 * silently drift from the architecture — not "the page rendered without crashing".
 */

import { expect, test } from "@playwright/test";
import { NAV_LINKS, PRICING_PLANS } from "@/content/copy";
import { TIER_POLICY } from "@shared/tier-policy";

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("landing page", () => {
    test.beforeEach(async ({ page }) => {
        await page.goto("/");
    });

    test("head title carries the privacy promise", async ({ page }) => {
        await expect(page).toHaveTitle(/DevDashboard/);
        await expect(page).toHaveTitle(/can't see your data/);
    });

    test("nav shows every link + the signup CTA", async ({ page }) => {
        const nav = page.locator("header nav");

        for (const link of NAV_LINKS) {
            await expect(nav.getByRole("link", { name: link.label })).toBeVisible();
        }

        const cta = nav.getByRole("link", { name: "Pair your Mac" });
        await expect(cta).toBeVisible();
        await expect(cta).toHaveAttribute("href", "/signup");
    });

    test("hero renders the gradient headline", async ({ page }) => {
        await expect(page.getByRole("heading", { level: 1 })).toContainText("streamed to your phone");
    });

    test("pricing renders all 3 plans, prices, and the Pro 'Popular' badge — from PRICING_PLANS", async ({ page }) => {
        const pricing = page.locator("#pricing");

        for (const plan of PRICING_PLANS) {
            await expect(pricing.getByRole("heading", { name: plan.name, exact: true })).toBeVisible();
            await expect(pricing.getByText(plan.price).first()).toBeVisible();
        }

        // The featured plan (Pro) carries the "Popular" badge and a CTA to /signup?plan=pro.
        const featured = PRICING_PLANS.find((p) => p.featured);
        expect(featured?.tier).toBe("pro");
        await expect(pricing.getByText("Popular", { exact: true })).toBeVisible();
    });

    test("every plan CTA links to /signup?plan=<tier>", async ({ page }) => {
        const pricing = page.locator("#pricing");

        for (const plan of PRICING_PLANS) {
            const link = pricing.getByRole("link", { name: plan.cta, exact: true });
            await expect(link).toHaveAttribute("href", `/signup?plan=${plan.tier}`);
        }
    });

    test("trust section renders the 4 tiers from TIER_POLICY", async ({ page }) => {
        const trust = page.locator("#trust");

        for (const tier of TIER_POLICY) {
            await expect(trust.getByRole("heading", { name: tier.label, exact: true })).toBeVisible();
        }
    });

    test("mobile hamburger toggles the full-screen menu", async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });

        const toggle = page.getByRole("button", { name: "Open menu" });
        await expect(toggle).toBeVisible();

        const menu = page.locator("#mobileMenu");
        await expect(menu).toHaveClass(/hidden/);

        await toggle.click();
        await expect(page.getByRole("button", { name: "Close menu" })).toBeVisible();
        await expect(menu).toHaveClass(/flex/);
        await expect(menu).toHaveClass(/open/);
    });
});
