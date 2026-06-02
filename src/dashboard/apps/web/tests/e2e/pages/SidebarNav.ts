import { BasePage } from "./BasePage";

/** Shared left-sidebar navigation. Reuse this in feature specs to navigate. */
export class SidebarNav extends BasePage {
    link(title: string) {
        return this.page.getByRole("link", { name: title, exact: true });
    }

    async openSection(title: string): Promise<void> {
        await this.link(title).click();
        await this.page.waitForLoadState("networkidle");
    }
}
