import { BasePage } from "@e2e/pages/base.page";

/** The `(more)` route hrefs (expo-router), each rendered under the dark-themed `(more)` Stack. */
type MoreRoute =
    | "connections"
    | "network-status"
    | "claude-usage"
    | "daemon"
    | "containers"
    | "disk-janitor"
    | "port-killer"
    | "process-monitor"
    | "weather"
    | "reminders-todos"
    | "tmux-presets"
    | "quick-commands";

const ROUTE_SCREEN: Record<MoreRoute, string> = {
    connections: "screen-connections",
    "network-status": "screen-network-status",
    "claude-usage": "screen-claude-usage",
    daemon: "screen-daemon",
    containers: "screen-containers",
    "disk-janitor": "screen-disk-janitor",
    "port-killer": "screen-port-killer",
    "process-monitor": "screen-process-monitor",
    weather: "screen-weather",
    "reminders-todos": "screen-reminders-todos",
    "tmux-presets": "screen-tmux-presets",
    "quick-commands": "screen-quick-commands",
};

/** The `more-link-*` row testIDs as wired in `app/(tabs)/more.tsx` (one per grouped section row). */
const MORE_LINKS: Record<MoreRoute, string> = {
    connections: "more-link-connections",
    "network-status": "more-link-network-status",
    "claude-usage": "more-link-claude-usage",
    daemon: "more-link-daemon",
    containers: "more-link-containers",
    "disk-janitor": "more-link-disk-janitor",
    "port-killer": "more-link-port-killer",
    "process-monitor": "more-link-process-monitor",
    weather: "more-link-weather",
    "reminders-todos": "more-link-reminders-todos",
    "tmux-presets": "more-link-tmux-presets",
    "quick-commands": "more-link-quick-commands",
};

/**
 * Navigation Page Object for the "More" hub + its deferred (more) feature screens (plan 09).
 *
 * The More tab is now grouped into Configuration / Insights / System / Environment sections, each a
 * `<Card>` of tappable `more-link-*` rows. `openViaMenu` taps the row and waits for the sub-screen
 * root, which is the real user path the consolidation pass wired up. `open` keeps the deep-link path
 * for cases where the menu wiring is not the thing under test.
 */
class MoreNavPage extends BasePage {
    private readonly screen = "screen-more";

    /**
     * Open the More tab via an expo-router deep link, then wait on the screen. The
     * `unstable-native-tabs` bar is not introspectable by XCUITest, so a `~More` label tap can't be
     * located — a deep link is the reliable navigation path (see app.page.ts).
     */
    async openTab(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard:///more",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.screen);
        return this.isVisible(this.screen);
    }

    /** True when a given `more-link-*` row is present in the More hub. */
    async linkExists(route: MoreRoute): Promise<boolean> {
        return this.byId(MORE_LINKS[route]).isExisting();
    }

    /** True when a given `more-link-*` row is displayed in the viewport (scroll first if needed). */
    async linkDisplayed(route: MoreRoute): Promise<boolean> {
        return this.byId(MORE_LINKS[route]).isDisplayed();
    }

    /** Tap a grouped row in the More hub, then wait for its sub-screen root to appear. */
    async openViaMenu(route: MoreRoute): Promise<void> {
        await this.tap(MORE_LINKS[route]);
        await this.waitForVisible(ROUTE_SCREEN[route]);
    }

    /** Open a `(more)` route via a deep link, then wait for its screen root. */
    async open(route: MoreRoute): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: `devdashboard://${route}`,
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(ROUTE_SCREEN[route]);
    }

    screenId(route: MoreRoute): string {
        return ROUTE_SCREEN[route];
    }

    linkId(route: MoreRoute): string {
        return MORE_LINKS[route];
    }
}

export const moreNavPage = new MoreNavPage();
