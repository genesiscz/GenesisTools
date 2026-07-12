import { expect, test } from "@playwright/test";
import { BoardsListPage } from "../pages/boards-list-page";

test.describe("boards list", () => {
    test("renders heading, create form, and existing boards", async ({ page, request }) => {
        const res = await request.get("/api/boards");
        expect(res.ok()).toBeTruthy();

        const list = new BoardsListPage(page);
        await list.goto();

        await expect(list.heading).toBeVisible();
        await expect(list.slugInput).toBeVisible();
        await expect(list.createButton).toBeDisabled(); // empty slug → invalid
    });

    test("creates a board and navigates to its canvas", async ({ page }) => {
        const list = new BoardsListPage(page);
        await list.goto();

        const slug = `pw-list-create-${Date.now().toString(36)}`;
        await list.createBoard(slug, "Playwright created");

        await page.waitForURL(`**/boards/${slug}`);
    });

    test("created board appears as a card in the grid", async ({ page, request }) => {
        const slug = `pw-list-grid-${Date.now().toString(36)}`;
        const created = await request.post("/api/boards", { data: { slug, title: "Grid check" } });
        expect(created.status()).toBe(201);

        const list = new BoardsListPage(page);
        await list.goto();

        const card = list.boardCard(slug);
        await expect(card).toBeVisible();
        await expect(card).toContainText("Grid check");
    });

    test("rejects an invalid slug", async ({ page }) => {
        const list = new BoardsListPage(page);
        await list.goto();

        await list.slugInput.fill("Invalid Slug!");
        await expect(list.createButton).toBeDisabled();
    });
});
