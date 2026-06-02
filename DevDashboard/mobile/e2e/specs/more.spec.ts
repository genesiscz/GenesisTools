import { connectPage } from "@e2e/pages/ConnectPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { networkStatusPage } from "@e2e/pages/NetworkStatusPage.page";

/**
 * Verifies the already-implemented "More" hub fixes (one `it()` per fix):
 *  4. Dark (more) header — navigating into a (more) sub-screen renders the sub-screen and back works.
 *     Header COLOR (no white bar) is verified by the orchestrator's screenshot; a11y cannot read a
 *     pixel color reliably, so this spec asserts what it CAN — the sub-screen renders + nav is sound.
 *  5. Grouped/spacious More with a Connections entry — the More hub shows the grouped section rows
 *     (`more-link-connections` + claude-usage / daemon / containers / weather).
 *  6. The Connections entry navigates to the connections sub-screen (`screen-connections`).
 *
 * The app may already be connected via boot-restore, so the `before()` only pairs when the connect
 * gate is actually shown, then lands on the More tab.
 */
describe("More tab", () => {
    const bundleId = process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard";

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        // Deep-link to the More tab directly and gate on a `more-link-*` row EXISTING rather than on
        // the `screen-more` root being displayed. `screen-more` is a `ScrollView` root whose XCUITest
        // `displayed` flips false intermittently (the children paint, the wrapper does not), so
        // `appPage.openTab("More")` — which waits on the root being displayed — flakes. Waiting on a
        // grouped row existing is the stable "hub rendered" signal.
        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await moreNavPage.waitForExist(moreNavPage.linkId("connections"));
    });

    it("shows the grouped section rows including a Connections entry", async () => {
        // FIX: the More hub is now grouped/spacious with one row per section (Configuration / Insights
        // / System / Environment). Assert multiple grouped `more-link-*` rows are present, incl. the
        // new Connections entry. Presence (`linkExists`) is the stable signal — the `screen-more`
        // ScrollView wrapper's `displayed` flag is unreliable, but the rows themselves render.
        expect(await moreNavPage.linkExists("connections")).toBe(true);
        expect(await moreNavPage.linkExists("network-status")).toBe(true);
        expect(await moreNavPage.linkExists("claude-usage")).toBe(true);
        expect(await moreNavPage.linkExists("daemon")).toBe(true);
        expect(await moreNavPage.linkExists("containers")).toBe(true);
        expect(await moreNavPage.linkExists("weather")).toBe(true);
        expect(await moreNavPage.linkExists("reminders-todos")).toBe(true);
    });

    it("navigates from the Reminders entry to the reminders-todos screen", async () => {
        await moreNavPage.openViaMenu("reminders-todos");
        expect(await moreNavPage.isVisible(moreNavPage.screenId("reminders-todos"))).toBe(true);

        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await moreNavPage.waitForExist(moreNavPage.linkId("connections"));
        expect(await moreNavPage.linkExists("reminders-todos")).toBe(true);
    });

    it("navigates from the Connections entry to the connections screen", async () => {
        await moreNavPage.openViaMenu("connections");
        expect(await moreNavPage.isVisible(moreNavPage.screenId("connections"))).toBe(true);

        // Return to the More hub. `browser.back()` is unreliable in this native (more)-Stack push
        // (iOS has no hardware-back, and WDIO's `back()` no-ops here), so re-deep-link to the hub and
        // gate on a grouped row existing — the stable "back on the hub" signal (the `screen-more`
        // ScrollView's `displayed` flag is unreliable, but the rows render).
        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await moreNavPage.waitForExist(moreNavPage.linkId("connections"));
        expect(await moreNavPage.linkExists("connections")).toBe(true);
    });

    it("opens Network status from the More menu", async () => {
        await moreNavPage.openViaMenu("network-status");
        expect(await networkStatusPage.isShown()).toBe(true);

        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await moreNavPage.waitForExist(moreNavPage.linkId("connections"));
        expect(await moreNavPage.linkExists("network-status")).toBe(true);
    });

    it("renders a (more) sub-screen under the dark themed header (color verified by screenshot)", async () => {
        // Header COLOR (the "no white bar" fix) is asserted by the orchestrator's screenshot. Here we
        // assert the navigable behavior the dark `(more)` Stack provides: the sub-screen root renders,
        // then the hub is reachable again.
        await moreNavPage.openViaMenu("connections");
        expect(await moreNavPage.isVisible(moreNavPage.screenId("connections"))).toBe(true);

        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await moreNavPage.waitForExist(moreNavPage.linkId("connections"));
        expect(await moreNavPage.linkExists("connections")).toBe(true);
    });
});
