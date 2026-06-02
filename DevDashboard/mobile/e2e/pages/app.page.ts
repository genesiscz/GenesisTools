import { BasePage } from "@e2e/pages/base.page";

type TabName = "Pulse" | "Terminals" | "QA" | "Obsidian" | "More";

// The screen-root testID rendered by each tab's <Screen testID>.
const TAB_SCREEN: Record<TabName, string> = {
    Pulse: "screen-pulse",
    Terminals: "screen-terminals",
    QA: "screen-qa",
    Obsidian: "screen-obsidian",
    More: "screen-more",
};

// The expo-router route path each tab maps to (Pulse is the (tabs) index).
const TAB_ROUTE: Record<TabName, string> = {
    Pulse: "",
    Terminals: "terminals",
    QA: "qa",
    Obsidian: "obsidian",
    More: "more",
};

/**
 * App-level Page Object covering the tab screens.
 *
 * The tab bar is `expo-router/unstable-native-tabs` (a SwiftUI `UITabBar`). On this Expo SDK 55 build
 * its tab items are NOT exposed to XCUITest as tappable elements — the a11y tree contains no Button /
 * TabBar nodes for the tabs, so a `~Pulse` label tap always times out (verified by dumping the page
 * source). Tab switching therefore goes through expo-router DEEP LINKS (`devdashboard:///<route>`),
 * which is reliable and is exactly how the (more) sub-screen specs already navigate. Screen bodies
 * still expose `screen-*` testIDs, which we wait on to confirm the tab actually rendered.
 */
class AppPage extends BasePage {
    private readonly bundleId = process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard";

    async tabsVisible(): Promise<boolean> {
        // "Tabs are up" = the Pulse screen (the index tab) renders after a deep link to it.
        await this.openTab("Pulse");
        return this.isVisible(TAB_SCREEN.Pulse);
    }

    async openTab(name: TabName): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: `devdashboard:///${TAB_ROUTE[name]}`,
            bundleId: this.bundleId,
        });
        await this.waitForVisible(TAB_SCREEN[name]);
    }
}

export const appPage = new AppPage();
