import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Claude usage screen (plan 09). Locates by the `testID`s baked into the screen
 * + its components (accessibility-id via the `~` selector in BasePage). The victory-native chart
 * canvas is opaque to the a11y tree, so "chart renders" = the chart CONTAINER testID is displayed.
 */
class ClaudeUsagePage extends BasePage {
    private readonly ids = {
        screen: "screen-claude-usage",
        loading: "claude-loading",
        empty: "claude-empty",
        rangeSelector: "claude-range-selector",
        range1h: "claude-range-1h",
        range24h: "claude-range-24h",
        range7d: "claude-range-7d",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    /** Either an account card or the "no accounts" empty state is present (depends on the test agent). */
    async hasAccountsOrEmpty(): Promise<boolean> {
        if (await this.byId(this.ids.empty).isExisting()) {
            return true;
        }

        return this.byId(this.ids.rangeSelector).isExisting();
    }

    /**
     * True when the agent returned usage data (so the cards/chart/range toggle exist). The range
     * selector only renders alongside accounts, so its presence is the gate for the device-only
     * card/chart assertions — use it to `this.skip()` the chart + range steps on a quiet test agent.
     */
    async hasUsageData(): Promise<boolean> {
        return this.byId(this.ids.rangeSelector).isExisting();
    }

    /** True if a given range segment is present (`claude-range-<label>`); not all labels always render. */
    async rangeExists(rangeId: string): Promise<boolean> {
        return this.byId(rangeId).isExisting();
    }

    get rangeIds(): { range1h: string; range24h: string; range7d: string } {
        return { range1h: this.ids.range1h, range24h: this.ids.range24h, range7d: this.ids.range7d };
    }

    accountCardId(accountName: string): string {
        return `claude-account-${accountName}`;
    }

    chartId(accountName: string, bucket: string): string {
        return `claude-chart-${accountName}-${bucket}`;
    }

    /** True if the named account's usage card is displayed (`claude-account-<accountName>`). */
    async accountCardVisible(accountName: string): Promise<boolean> {
        return this.isVisible(this.accountCardId(accountName));
    }

    /**
     * True if the named account's chart CONTAINER for `bucket` is displayed. The victory-native canvas
     * is opaque to the a11y tree, so "chart renders" = the chart container testID
     * (`claude-chart-<account>-<bucket>`) is visible.
     */
    async chartVisible(accountName: string, bucket: string): Promise<boolean> {
        return this.isVisible(this.chartId(accountName, bucket));
    }

    async selectRange1h(): Promise<void> {
        await this.byId(this.ids.range1h).click();
    }

    async selectRange24h(): Promise<void> {
        await this.byId(this.ids.range24h).click();
    }

    async selectRange7d(): Promise<void> {
        await this.byId(this.ids.range7d).click();
    }
}

export const claudeUsagePage = new ClaudeUsagePage();
