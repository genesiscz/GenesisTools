import type { Locator, Page } from "@playwright/test";

/** Page object for /boards — the boards list + create form. */
export class BoardsListPage {
    readonly page: Page;
    readonly heading: Locator;
    readonly slugInput: Locator;
    readonly titleInput: Locator;
    readonly createButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.heading = page.getByRole("heading", { name: "Boards" });
        this.slugInput = page.getByLabel("Board slug");
        this.titleInput = page.getByLabel("Board title");
        this.createButton = page.getByRole("button", { name: /new board/i });
    }

    async goto(): Promise<void> {
        await this.page.goto("/boards");
    }

    boardCard(slug: string): Locator {
        return this.page.getByRole("link", { name: new RegExp(slug) });
    }

    async createBoard(slug: string, title?: string): Promise<void> {
        await this.slugInput.fill(slug);

        if (title) {
            await this.titleInput.fill(title);
        }

        await this.createButton.click();
    }
}
