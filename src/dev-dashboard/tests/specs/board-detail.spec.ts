import { expect, test } from "@playwright/test";
import { boardDoc, freshBoard, seedNote, seedTextCard } from "../helpers/boards-test-api";
import { BoardDetailPage } from "../pages/board-detail-page";

test.describe("board detail foundation", () => {
    test("canvas, toolbar, and seeded cards render", async ({ page, request }) => {
        const slug = await freshBoard(request, "detail");
        const note = await seedNote(request, slug, "hello from playwright");
        const text = await seedTextCard(request, slug, "# Title\n\nBody **bold** and `code`.");

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await expect(board.canvas).toBeVisible();
        await expect(board.toolbar).toBeVisible();
        await expect(board.card(note.id)).toBeVisible();
        await expect(board.card(text.id)).toBeVisible();

        for (const tool of ["move", "ink", "annotate", "note", "connect", "section"] as const) {
            await expect(board.toolButton(tool)).toBeVisible();
        }
    });

    test("tool selection via toolbar and keyboard", async ({ page, request }) => {
        const slug = await freshBoard(request, "tools");
        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.selectTool("section");
        await expect(board.toolButton("section")).toHaveAttribute("aria-pressed", "true");

        await page.keyboard.press("v");
        await expect(board.toolButton("move")).toHaveAttribute("aria-pressed", "true");
    });

    test("card drag persists position to the server", async ({ page, request }) => {
        const slug = await freshBoard(request, "drag");
        const note = await seedNote(request, slug, "drag me", { x: 120, y: 120 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.dragCardBy(note.id, 150, 90);

        await expect
            .poll(async () => {
                const doc = await boardDoc(request, slug);
                const moved = doc.cards.find((c) => c.id === note.id);
                return moved ? { x: moved.x, y: moved.y } : null;
            })
            .toEqual({ x: 270, y: 210 });
    });

    test("dragged card never jumps back to its origin while the server confirms", async ({ page, request }) => {
        const slug = await freshBoard(request, "optimistic");
        const note = await seedNote(request, slug, "no jump", { x: 100, y: 100 });

        const board = new BoardDetailPage(page);
        await board.goto(slug);

        await board.dragCardBy(note.id, 200, 0);

        // Once the drop position renders, it must NEVER regress to x=100 while the server
        // confirms — the old behavior flashed back until the refetch landed.
        const locator = board.card(note.id);
        const left = () => locator.evaluate((el) => Number.parseFloat((el as HTMLElement).style.left));
        await expect.poll(left).toBeGreaterThan(250);

        for (let i = 0; i < 8; i++) {
            expect(await left(), "card regressed to pre-drag x mid-confirm").toBeGreaterThan(250);
            await page.waitForTimeout(100);
        }
    });
});
