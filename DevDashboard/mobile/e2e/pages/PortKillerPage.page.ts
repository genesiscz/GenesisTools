import { BasePage } from "@e2e/pages/base.page";

/** Page Object for the Port Killer screen. Locates by the baked-in testIDs (accessibility-id). */
class PortKillerPage extends BasePage {
    private readonly ids = {
        screen: "screen-port-killer",
        loading: "port-killer-loading",
        lsofUnavailable: "port-killer-lsof-unavailable",
        empty: "port-killer-empty",
        confirm: "port-killer-kill-confirm",
        confirmYes: "port-killer-kill-confirm-yes",
        confirmCancel: "port-killer-kill-confirm-cancel",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    rowId(port: number): string {
        return `port-killer-row-${port}`;
    }

    killButtonId(port: number): string {
        return `port-killer-kill-${port}`;
    }

    async rowExists(port: number): Promise<boolean> {
        return this.byId(this.rowId(port)).isExisting();
    }

    /** Tap the Kill button for a port, then wait for the in-app confirm Modal. */
    async openKillConfirm(port: number): Promise<void> {
        await this.scrollAndTap(this.killButtonId(port));
        await this.waitForVisible(this.ids.confirm);
    }

    async isConfirmShown(): Promise<boolean> {
        return this.byId(this.ids.confirm).isDisplayed();
    }

    async cancelConfirm(): Promise<void> {
        await this.tap(this.ids.confirmCancel);
        await this.waitForGone(this.ids.confirm);
    }

    async isLsofUnavailableShown(): Promise<boolean> {
        return this.byId(this.ids.lsofUnavailable).isExisting();
    }
}

export const portKillerPage = new PortKillerPage();
