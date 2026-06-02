import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Reminders & Todos screen (plan 2026-06-02). Locates by the `testID`s baked into
 * the screen + its components (accessibility-id via the `~` selector in BasePage). The screen root is
 * a `<Screen>` ScrollView (`displayed=true`), so `openViaDeepLink` waits on the root directly.
 */
class RemindersTodosPage extends BasePage {
    private readonly ids = {
        screen: "screen-reminders-todos",
        loading: "reminders-todos-loading",
        error: "reminders-todos-error",
        permissionBanner: "reminders-todos-permission-banner",
        grantAccess: "reminders-todos-grant-access",
        list: "reminders-todos-list",
        empty: "reminders-todos-empty",
        addInput: "reminders-todos-add-input",
        addSubmit: "reminders-todos-add-submit",
    } as const;

    /** Navigate to the screen via the `(more)` deep link, then wait for its `<Screen>` root. */
    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://reminders-todos",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.ids.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    async addInputShown(): Promise<boolean> {
        return this.isVisible(this.ids.addInput);
    }

    rowId(id: string): string {
        return `reminders-todos-row-${id}`;
    }

    completeId(id: string): string {
        return `reminders-todos-complete-${id}`;
    }

    /** True when a reminder row for `id` exists in the a11y tree (rendered, even if below the fold). */
    async rowExists(id: string): Promise<boolean> {
        return this.byId(this.rowId(id)).isExisting();
    }

    /** Either at least one reminder row exists OR the empty state is displayed (always-true structural check). */
    async hasRowsOrEmpty(): Promise<boolean> {
        const rows = await this.rowCount();
        return rows > 0 || (await this.byId(this.ids.empty).isExisting());
    }

    /** Count rendered reminder rows by the `reminders-todos-row-` testID prefix (a11y name/content-desc). */
    async rowCount(): Promise<number> {
        const prefix = "reminders-todos-row-";
        const rows = await $$(
            `//*[starts-with(@name, "${prefix}") or starts-with(@content-desc, "${prefix}")]`,
        );
        return rows.length;
    }

    /** Tap the complete toggle on a known reminder row. */
    async tapComplete(id: string): Promise<void> {
        await this.tap(this.completeId(id));
    }

    /** Wait until a reminder row is gone from the a11y tree (after a successful complete + refetch). */
    async waitForRowGone(id: string): Promise<void> {
        await this.byId(this.rowId(id)).waitForExist({ timeout: this.defaultTimeout, reverse: true });
    }

    async typeNewTitle(text: string): Promise<void> {
        await this.type(this.ids.addInput, text);
    }

    async submitAdd(): Promise<void> {
        await this.tap(this.ids.addSubmit);
    }

    async permissionBannerShown(): Promise<boolean> {
        return this.byId(this.ids.permissionBanner).isExisting();
    }

    async grantAccessExists(): Promise<boolean> {
        return this.byId(this.ids.grantAccess).isExisting();
    }

    async tapGrantAccess(): Promise<void> {
        await this.tap(this.ids.grantAccess);
    }
}

export const remindersTodosPage = new RemindersTodosPage();
