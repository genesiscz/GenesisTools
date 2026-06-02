import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Activity Timeline screen. Locates by the `timeline-*` testIDs baked into the
 * feature components (accessibility-id via the `~` selector in BasePage). The `screen-activity-timeline`
 * root wraps a FlatList (reports displayed=false), so navigation waits on the `timeline-list` (or the
 * `timeline-empty` card) instead.
 */
class ActivityTimelinePage extends BasePage {
    private readonly ids = {
        screen: "screen-activity-timeline",
        loading: "timeline-loading",
        list: "timeline-list",
        empty: "timeline-empty",
    } as const;

    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://activity-timeline",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForExist(this.ids.screen);
        // Either the list or the empty card resolves once the query settles.
        await this.waitUntil(
            async () => (await this.isExisting(this.ids.list)) || (await this.isExisting(this.ids.empty)),
            { message: "timeline never rendered list or empty" },
        );
    }

    async isShown(): Promise<boolean> {
        return (await this.isExisting(this.ids.list)) || (await this.isExisting(this.ids.empty));
    }

    /** Either at least one hour group + event, or the empty card. */
    async hasContentOrEmpty(): Promise<boolean> {
        return (await this.isExisting(this.ids.list)) || (await this.isExisting(this.ids.empty));
    }

    hourHeaderId(hourKey: string): string {
        return `timeline-hour-${hourKey}`;
    }

    eventRowId(eventId: string): string {
        return `timeline-event-${eventId}`;
    }

    async hourHeaderVisible(hourKey: string): Promise<boolean> {
        return this.isExisting(this.hourHeaderId(hourKey));
    }

    async eventVisible(eventId: string): Promise<boolean> {
        return this.isExisting(this.eventRowId(eventId));
    }

    /**
     * The event ids currently rendered in the list, in on-screen (top→bottom) order. Event ids are
     * minted at runtime by the agent (daemon run ids, qa ids), so a live-Agent spec cannot hard-code
     * them; this discovers them from the a11y tree by the `timeline-event-<id>` prefix — the same
     * pattern ConnectionsPage uses for its store-minted rows. The predicate matches both the iOS
     * XCUITest `name` attribute and the Android UiAutomator2 `content-desc`. Document order from the
     * FlatList is descending-by-time, so `ids[0]` is the newest rendered row.
     */
    async discoverEventIds(): Promise<string[]> {
        const rows = await $$(
            '//*[starts-with(@name, "timeline-event-") or starts-with(@content-desc, "timeline-event-")]',
        );
        const ids: string[] = [];

        for (const row of rows) {
            const name = (await row.getAttribute("name")) ?? (await row.getAttribute("content-desc"));

            if (!name) {
                continue;
            }

            ids.push(name.replace(/^timeline-event-/, ""));
        }

        return ids;
    }

    /**
     * Prove descending order on-screen: `newerId` must sit ABOVE `olderId` (smaller native `y`). Both
     * rows must already be rendered in the a11y tree — we never `scrollIntoView` (per the e2e harness
     * rule). The caller guards with `eventVisible` first; the mock build keeps all four rows above the
     * fold so their relative `y` is a real ordering proof.
     */
    async isAboveOnScreen(newerId: string, olderId: string): Promise<boolean> {
        const newer = await this.byId(this.eventRowId(newerId)).getLocation();
        const older = await this.byId(this.eventRowId(olderId)).getLocation();
        return newer.y < older.y;
    }
}

export const activityTimelinePage = new ActivityTimelinePage();
