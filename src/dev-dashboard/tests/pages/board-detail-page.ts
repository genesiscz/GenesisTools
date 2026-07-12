import type { Locator, Page } from "@playwright/test";
import { errors } from "@playwright/test";

export type ToolName = "move" | "ink" | "annotate" | "note" | "connect" | "section" | "table";

/** Page object for /boards/$slug — the canvas, toolbar, cards, and side panel. */
export class BoardDetailPage {
    readonly page: Page;
    readonly canvas: Locator;
    readonly toolbar: Locator;
    readonly wirePanel: Locator;
    readonly stagedPill: Locator;

    constructor(page: Page) {
        this.page = page;
        this.canvas = page.getByTestId("board-canvas");
        this.toolbar = page.getByTestId("board-toolbar");
        this.wirePanel = page.getByTestId("wire-panel");
        this.stagedPill = page.getByTestId("staged-pill");
    }

    async goto(slug: string): Promise<void> {
        await this.page.goto(`/boards/${slug}`);
        await this.dismissOperatorPrompt();
        await this.canvas.waitFor();
    }

    /** First visit shows the "YOU ARE" operator dialog; commit a stable identity. */
    async dismissOperatorPrompt(name = "playwright"): Promise<void> {
        const input = this.page.getByLabel("your name");

        try {
            await input.waitFor({ timeout: 1_500 });
        } catch (err) {
            if (err instanceof errors.TimeoutError) {
                return; // already identified (localStorage persisted)
            }

            throw err;
        }

        await input.fill(name);
        await this.page.getByRole("button", { name: "Continue" }).click();
    }

    card(id: number): Locator {
        return this.page.locator(`[data-card-id="${id}"]`);
    }

    section(id: number): Locator {
        return this.page.locator(`[data-section-id="${id}"]`);
    }

    toolButton(tool: ToolName): Locator {
        return this.toolbar.locator(`[data-tool="${tool}"]`);
    }

    async selectTool(tool: ToolName): Promise<void> {
        await this.toolButton(tool).click();
    }

    /** Drag a card by (dx, dy) screen px with pointer events. */
    async dragCardBy(id: number, dx: number, dy: number): Promise<void> {
        const box = await this.card(id).boundingBox();

        if (!box) {
            throw new Error(`card ${id} has no bounding box`);
        }

        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        await this.page.mouse.move(startX, startY);
        await this.page.mouse.down();
        await this.page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 4 });
        await this.page.mouse.move(startX + dx, startY + dy, { steps: 4 });
        await this.page.mouse.up();
    }

    /** Drag on the canvas overlay from one screen point to another (section/ink/connect tools). */
    async dragOnCanvas(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
        const box = await this.canvas.boundingBox();

        if (!box) {
            throw new Error("canvas has no bounding box");
        }

        await this.page.mouse.move(box.x + from.x, box.y + from.y);
        await this.page.mouse.down();
        await this.page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2, { steps: 4 });
        await this.page.mouse.move(box.x + to.x, box.y + to.y, { steps: 4 });
        await this.page.mouse.up();
    }

    async clickCard(id: number): Promise<void> {
        await this.card(id).click();
    }

    async pressUndo(): Promise<void> {
        await this.page.keyboard.press("ControlOrMeta+z");
    }

    async pressRedo(): Promise<void> {
        await this.page.keyboard.press("ControlOrMeta+Shift+z");
    }
}
