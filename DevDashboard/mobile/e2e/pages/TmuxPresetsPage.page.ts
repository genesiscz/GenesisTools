import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Tmux Presets screen (plan 2026-06-02). Locates by the `testID`s baked into the
 * screen + its components (accessibility-id via the `~` selector in BasePage). The screen root is a
 * `<Screen>` ScrollView (`displayed=true`), so `openViaDeepLink` waits on the root directly. Per-preset
 * controls are addressed by `…-<name>` suffix helpers so specs read cleanly.
 */
class TmuxPresetsPage extends BasePage {
    private readonly ids = {
        screen: "screen-tmux-presets",
        loading: "tmux-presets-loading",
        error: "tmux-presets-error",
        empty: "tmux-presets-empty",
        list: "tmux-presets-list",
        captureName: "tmux-presets-capture-name",
        captureNote: "tmux-presets-capture-note",
        captureSubmit: "tmux-presets-capture-submit",
        confirm: "tmux-presets-confirm",
        confirmTitle: "tmux-presets-confirm-title",
        confirmAccept: "tmux-presets-confirm-accept",
        confirmCancel: "tmux-presets-confirm-cancel",
    } as const;

    /** Navigate to the screen via the `(more)` deep link, then wait for its `<Screen>` root. */
    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://tmux-presets",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.ids.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    rowId(name: string): string {
        return `tmux-presets-row-${name}`;
    }

    summaryId(name: string): string {
        return `tmux-presets-summary-${name}`;
    }

    restoreId(name: string): string {
        return `tmux-presets-restore-${name}`;
    }

    deleteId(name: string): string {
        return `tmux-presets-delete-${name}`;
    }

    /** True when a preset card for `name` exists in the a11y tree (rendered, even if below the fold). */
    async rowExists(name: string): Promise<boolean> {
        return this.byId(this.rowId(name)).isExisting();
    }

    /** Either at least one preset row exists OR the empty state is displayed (structural check). */
    async hasRowsOrEmpty(): Promise<boolean> {
        const rows = await this.rowCount();
        return rows > 0 || (await this.byId(this.ids.empty).isExisting());
    }

    /** Count rendered preset cards by the `tmux-presets-row-` testID prefix (a11y name/content-desc). */
    async rowCount(): Promise<number> {
        const prefix = "tmux-presets-row-";
        const rows = await $$(
            `//*[starts-with(@name, "${prefix}") or starts-with(@content-desc, "${prefix}")]`,
        );
        return rows.length;
    }

    /** Read the visible "N sessions · N windows · N panes" summary for a preset row. */
    async summaryText(name: string): Promise<string> {
        return this.getText(this.summaryId(name));
    }

    async tapRestore(name: string): Promise<void> {
        await this.tap(this.restoreId(name));
    }

    async tapDelete(name: string): Promise<void> {
        await this.tap(this.deleteId(name));
    }

    /** Wait for the confirm dialog to appear, then report it visible (the load-bearing assertion). */
    async confirmVisible(): Promise<boolean> {
        await this.waitForVisible(this.ids.confirm);
        return this.isVisible(this.ids.confirm);
    }

    async confirmTitleText(): Promise<string> {
        return this.getText(this.ids.confirmTitle);
    }

    async confirmGone(): Promise<boolean> {
        return !(await this.byId(this.ids.confirm).isExisting());
    }

    async acceptConfirm(): Promise<void> {
        await this.tap(this.ids.confirmAccept);
    }

    async cancelConfirm(): Promise<void> {
        await this.tap(this.ids.confirmCancel);
    }

    /** Type a name (+ optional note) into the capture form and submit. */
    async capture(name: string, note?: string): Promise<void> {
        await this.type(this.ids.captureName, name);
        if (note) {
            await this.type(this.ids.captureNote, note);
        }

        await this.tap(this.ids.captureSubmit);
    }

    /** Wait until a preset card is gone from the a11y tree (after a successful delete + refetch). */
    async waitForRowGone(name: string): Promise<void> {
        await this.byId(this.rowId(name)).waitForExist({ timeout: this.defaultTimeout, reverse: true });
    }
}

export const tmuxPresetsPage = new TmuxPresetsPage();
