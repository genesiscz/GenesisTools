import type { Page } from "@playwright/test";

/** Base for every Page Object: holds the Playwright `page` + a goto that waits. */
export class BasePage {
    constructor(readonly page: Page) {}

    async goto(path: string): Promise<void> {
        await this.page.goto(path);
        await this.page.waitForLoadState("networkidle");
    }
}
