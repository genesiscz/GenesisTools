import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Needs-Input Inbox screen (route `app/(more)/needs-input-inbox.tsx`, screen
 * root `screen-needs-input-inbox`). Like the Daemon screen, the root wraps a `FlatList` and reports
 * `displayed=false`, so navigation waits on the always-rendered `needs-input-inbox-count` child, not
 * the root. Item ids are scraped from the a11y tree (`needs-input-inbox-item-<id>`), and an item's
 * kind is read off its kind pill's text so the spec can tell agent-question from agent-session.
 */
class NeedsInputInboxPage extends BasePage {
    private readonly ids = {
        screen: "screen-needs-input-inbox",
        loading: "needs-input-inbox-loading",
        error: "needs-input-inbox-error",
        count: "needs-input-inbox-count",
        empty: "needs-input-inbox-empty",
        list: "needs-input-inbox-list",
        moreLink: "more-link-needs-input-inbox",
        terminalsScreen: "screen-terminals",
        terminalSurface: "terminal-surface",
    } as const;

    /** Open via the `(more)` deep link, then wait on the displayed count child (FlatList-root trap). */
    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://needs-input-inbox",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.count);
    }

    /** The real user path: tap the More hub row, then wait on the displayed count child. */
    async openViaMenu(): Promise<void> {
        await this.tap(this.ids.moreLink);
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.count);
    }

    async isShown(): Promise<boolean> {
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.count);
        return this.isVisible(this.ids.count);
    }

    /** The count pill's label parsed to a number (its text is the queue size). */
    async count(): Promise<number> {
        const text = await this.getText(this.ids.count);
        return Number.parseInt(text.trim(), 10);
    }

    /** At least one item card OR the empty state is present. */
    async hasItemsOrEmpty(): Promise<boolean> {
        const ids = await this.discoverItemIds(1);
        return ids.length > 0 || (await this.isExisting(this.ids.empty));
    }

    private async pageSource(): Promise<string> {
        return driver.getPageSource();
    }

    /** Distinct item ids (sanitized form, e.g. `qa-mock-1`) scraped from `needs-input-inbox-item-<id>`. */
    async discoverItemIds(limit = 8): Promise<string[]> {
        const source = await this.pageSource();
        // Exclude the `-kind-<id>` pill testID so we only capture the item-card testIDs.
        const pattern = /needs-input-inbox-item-(?!kind-)([\w-]+)/g;
        const ids: string[] = [];
        let match = pattern.exec(source);
        while (match !== null && ids.length < limit) {
            const id = match[1];
            if (!ids.includes(id)) {
                ids.push(id);
            }

            match = pattern.exec(source);
        }

        return ids;
    }

    itemId(id: string): string {
        return `needs-input-inbox-item-${id}`;
    }

    kindId(id: string): string {
        return `needs-input-inbox-item-kind-${id}`;
    }

    /** An item's kind, read from its kind pill text ("agent-question" | "agent-session" | ""). */
    async kindOf(id: string): Promise<string> {
        if (!(await this.isExisting(this.kindId(id)))) {
            return "";
        }

        return (await this.getText(this.kindId(id))).trim();
    }

    /** The first item whose kind matches, else "". */
    async firstItemOfKind(kind: string): Promise<string> {
        const ids = await this.discoverItemIds();
        for (const id of ids) {
            if ((await this.kindOf(id)) === kind) {
                return id;
            }
        }

        return "";
    }

    async tapItem(id: string): Promise<void> {
        await this.tap(this.itemId(id));
    }

    /** After tapping a terminal item, the Terminals screen + its surface should be up. */
    async waitForTerminalOpen(): Promise<void> {
        await this.waitForVisible(this.ids.terminalsScreen);
        await this.waitForVisible(this.ids.terminalSurface);
    }

    async terminalsScreenVisible(): Promise<boolean> {
        return this.isVisible(this.ids.terminalsScreen);
    }
}

export const needsInputInboxPage = new NeedsInputInboxPage();
