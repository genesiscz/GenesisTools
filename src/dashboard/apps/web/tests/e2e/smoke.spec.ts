import { resetTables } from "./support/db";
import { expect, test } from "./support/fixtures";
import { seedNote } from "./support/seed";

/**
 * Foundation smoke — proves the E2E harness end-to-end BEFORE feature work:
 *  1. The auth bypass + a requireUserId()-gated server fn resolve `dev-user`
 *     data (seed a note -> it renders). This is the discriminating check: an
 *     empty shell rendering would NOT prove the server boundary honours the
 *     bypass; a seeded row appearing does.
 *  2. Protected routes render the shell instead of redirecting to signin.
 *  3. Every pre-created route resolves (stubs are wired into the route tree).
 */
test.describe("foundation smoke", () => {
    test("seed -> server fn -> render proves the auth bypass user", async ({ page }) => {
        resetTables("notes");
        const marker = `E2E-NOTE-${Date.now()}`;
        seedNote({ title: marker, body: "smoke" });

        await page.goto("/dashboard/notes");
        await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
    });

    test("protected route renders shell, no signin redirect", async ({ page }) => {
        await page.goto("/dashboard");
        await expect(page).toHaveURL(/\/dashboard/);
        await expect(page.getByText(/NEXUS|Command Center/i).first()).toBeVisible();
    });

    test("pre-created routes resolve", async ({ page }) => {
        const paths = [
            "/dashboard/habits",
            "/dashboard/goals",
            "/dashboard/mood",
            "/dashboard/expenses",
            "/dashboard/reading",
            "/assistant/blockers",
        ];
        for (const p of paths) {
            const res = await page.goto(p);
            expect(res?.status(), `route ${p} should not 404/500`).toBeLessThan(400);
            await expect(page).not.toHaveURL(/\/auth\/signin/);
        }
    });
});
