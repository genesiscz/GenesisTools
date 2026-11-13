import { mkdirSync } from "node:fs";
import path from "node:path";
import { devDashboardRoutes } from "@e2e/adapter";
import { getDevDashboardBundleId } from "@e2e/bundle-id";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { e2eRun } from "@e2e/run";

/**
 * A screenshot of every screen, one per route, numbered in the order a user meets them: the connect gate (when the app
 * is not paired yet), the tabs, every (more) screen, then the connect and pair screens. Each screen is opened by its expo-router deep link (the
 * native tab bar is not reachable through XCUITest, see app.page.ts), waited on by its `screen-*` root, given a moment
 * to load its data, and saved as `<NN>-<route>.png` in `tour/` of the spec's run folder under `tools e2e`, else in
 * `e2e/screenshots/tour/` (DD_TOUR_DIR overrides both).
 *
 * Run it alone: `tools e2e run screens.tour`, or `bun run e2e -- --spec e2e/specs/screens.tour.spec.ts`. A screen
 * whose root never shows is saved as `<NN>-<route>.MISSING.png`, so the tour always covers every route and says which
 * ones failed.
 */
// Under `tools e2e` the tour goes into the spec's run folder.
const TOUR_DIR =
    process.env.DD_TOUR_DIR ??
    (e2eRun.runDir ? path.join(e2eRun.runDir, "tour") : path.join(import.meta.dirname, "..", "screenshots", "tour"));
const SETTLE_MS = Number(process.env.DD_TOUR_SETTLE_MS ?? "2500");

// The routes `tools mobile` and `tools e2e` use (`e2e/adapter.ts`): the tabs in tab bar order, every (more) screen,
// then the connect gate and the pairing landing, each with its link and its `screen-*` root. A new screen file, a new
// tab or a new tab order is in the tour without an edit here.
const SCREENS = devDashboardRoutes(path.join(import.meta.dirname, "..", "..")).map((route) => ({
    name: route.name,
    screen: route.rootId ?? `screen-${route.name}`,
    url: route.url,
}));

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
            await connectPage.pairWithTestAgent();
        }
    });

    for (const [offset, { name, screen, url }] of SCREENS.entries()) {
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
