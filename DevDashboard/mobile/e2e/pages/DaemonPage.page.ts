import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Daemon screen (plan 09). Locates by the `testID`s baked into the screen + its
 * components (accessibility-id via the `~` selector in BasePage).
 */
class DaemonPage extends BasePage {
    private readonly ids = {
        screen: "screen-daemon",
        loading: "daemon-loading",
        statusHeader: "daemon-status-header",
        statusPill: "daemon-status-pill",
        runsList: "daemon-runs-list",
        runsEmpty: "daemon-runs-empty",
        logSheet: "daemon-log-sheet",
        logClose: "daemon-log-close",
        logEmpty: "daemon-log-empty",
    } as const;

    /**
     * Screen is up. The `screen-daemon` root wraps a `FlatList`, so the root View itself reports
     * `displayed=false` while its content (the status header) is on-screen (verified: root
     * `exists=true`/`displayed=false`, header `displayed=true`). Gate on the root EXISTING, then
     * confirm the always-rendered status header is actually displayed.
     */
    /**
     * Navigate to the daemon screen via the `(more)` deep link, then wait for its content. Kept
     * self-contained (like `ConnectionsPage.openFromMore`) rather than importing `MoreNav.page`
     * (authored by a parallel agent), and — crucially — waits on the displayed status header rather
     * than the `screen-daemon` root, which is a FlatList wrapper that reports `displayed=false`
     * (verified: root `exists=true`/`displayed=false`, header `displayed=true`). `MoreNav.open` waits
     * on `screen-daemon` being displayed, which never happens, so this spec deep-links directly.
     */
    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://daemon",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.statusHeader);
    }

    /**
     * Screen is up. The `screen-daemon` root wraps a `FlatList`, so the root View itself reports
     * `displayed=false` while its content (the status header) is on-screen (verified: root
     * `exists=true`/`displayed=false`, header `displayed=true`). Gate on the root EXISTING, then
     * confirm the always-rendered status header is actually displayed.
     */
    async isShown(): Promise<boolean> {
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.statusHeader);
        return this.isVisible(this.ids.statusHeader);
    }

    async statusHeaderVisible(): Promise<boolean> {
        return this.isVisible(this.ids.statusHeader);
    }

    async statusPillLabel(): Promise<string> {
        return this.byId(this.ids.statusPill).getText();
    }

    /** Either at least one run row or the "no runs" empty card is present. */
    async hasRunsOrEmpty(): Promise<boolean> {
        return (await this.byId(this.ids.runsList).isExisting()) || (await this.byId(this.ids.runsEmpty).isExisting());
    }

    runRowId(runId: string): string {
        return `daemon-run-${runId}`;
    }

    /** Open the first run's log sheet (caller supplies a known runId from the test agent's data). */
    async openRunLog(runId: string): Promise<void> {
        await this.byId(this.runRowId(runId)).click();
        await this.waitForVisible(this.ids.logSheet);
    }

    async logSheetVisible(): Promise<boolean> {
        return this.isVisible(this.ids.logSheet);
    }

    async closeRunLog(): Promise<void> {
        await this.byId(this.ids.logClose).click();
    }

    /** Wait for the run-log sheet to dismiss after `closeRunLog()` (the bottom sheet animates out). */
    async waitForLogSheetGone(): Promise<void> {
        await this.waitForGone(this.ids.logSheet);
    }
}

export const daemonPage = new DaemonPage();
