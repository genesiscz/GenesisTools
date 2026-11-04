import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { getDevDashboardBundleId } from "@e2e/bundle-id";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * A screenshot of every screen, one per route, numbered in the order a user meets them: the connect gate (when the app
 * is not paired yet), the five tabs, then every (more) screen. Each screen is opened by its expo-router deep link (the
 * native tab bar is not reachable through XCUITest, see app.page.ts), waited on by its `screen-*` root, given a moment
 * to load its data, and saved under `e2e/screenshots/tour/<NN>-<route>.png` (DD_TOUR_DIR overrides the folder).
 *
 * Run it alone: `bun run e2e -- --spec e2e/specs/screens.tour.spec.ts`. A screen whose root never shows is saved as
 * `<NN>-<route>.MISSING.png`, so the tour always covers every route and says which ones failed.
 */
const TOUR_DIR = process.env.DD_TOUR_DIR ?? path.join(import.meta.dirname, "..", "screenshots", "tour");
const SETTLE_MS = Number(process.env.DD_TOUR_SETTLE_MS ?? "2500");

// The link forms the page objects use: `devdashboard:///<tab>` for a tab, `devdashboard://<route>` for a (more) screen.
// The (more) screens come from the expo-router folder, so a new screen file is in the tour without an edit here.
const MORE_DIR = path.join(import.meta.dirname, "..", "..", "src", "app", "(more)");
const MORE_ROUTES = readdirSync(MORE_DIR)
    .filter((file) => file.endsWith(".tsx") && !file.startsWith("_") && !file.startsWith("+"))
    .map((file) => file.replace(/\.tsx$/, ""))
    .sort();

const SCREENS: Array<{ route: string; screen: string; url: string }> = [
    { route: "", screen: "screen-pulse", url: "devdashboard:///" },
    { route: "terminals", screen: "screen-terminals", url: "devdashboard:///terminals" },
    { route: "qa", screen: "screen-qa", url: "devdashboard:///qa" },
    { route: "obsidian", screen: "screen-obsidian", url: "devdashboard:///obsidian" },
    { route: "more", screen: "screen-more", url: "devdashboard:///more" },
    ...MORE_ROUTES.map((route) => ({ route, screen: `screen-${route}`, url: `devdashboard://${route}` })),
];

async function shoot(index: number, name: string, missing = false): Promise<void> {
    const file = `${String(index).padStart(2, "0")}-${name}${missing ? ".MISSING" : ""}.png`;
    await browser.saveScreenshot(path.join(TOUR_DIR, file));
}

describe("Screen tour: one screenshot per screen", () => {
    before(async () => {
        mkdirSync(TOUR_DIR, { recursive: true });

        // The connect gate shows only while the app is not paired; capture it, then pair to reach the rest.
        if (await connectPage.isShown()) {
            await browser.pause(SETTLE_MS);
            await shoot(0, "connect");
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(pairingUri());
            // A fast Agent can pair and leave the gate before the badge is ever read as reachable.
            await browser.waitUntil(
                async () => (await connectPage.isReachabilityState("reachable")) || !(await connectPage.isShown()),
                { timeout: 15_000, timeoutMsg: "the pairing never became reachable" }
            );

            if (await connectPage.isShown()) {
                await connectPage.tapContinue();
            }
        }
    });

    for (const [offset, { route, screen, url }] of SCREENS.entries()) {
        const name = route || "pulse";

        it(`shoots ${name}`, async () => {
            await browser.execute("mobile: deepLink", { url, bundleId: getDevDashboardBundleId() });
            const root = await $(`~${screen}`);

            try {
                // As the page objects do: a root whose child is a WebView (terminals) never reads as displayed.
                await root.waitForExist({ timeout: 15_000 });
            } catch (error) {
                await shoot(offset + 1, name, true);
                throw error;
            }

            await browser.pause(SETTLE_MS);
            await shoot(offset + 1, name);
        });
    }
});
