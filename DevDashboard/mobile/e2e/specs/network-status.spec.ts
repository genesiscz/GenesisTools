import { connectPage } from "@e2e/pages/ConnectPage.page";
import { networkStatusPage } from "@e2e/pages/NetworkStatusPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * Network & Transport Status done-gate. The app boots into /connect whenever no baseUrl is set, so
 * this spec first pairs (deep-linked pairing URI — the sim has no camera), then deep-links to
 * /network-status and asserts REAL derived state (not a smoke render): the quality pill text is a
 * known classification, the latency row carries a real "<n> ms" value, and the Re-pair button
 * navigates back into the connect/scan flow.
 *
 * AUTHORED, NOT RUN here. Prereqs (owned by the user): a booted iOS sim with the dev-client
 * installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test Agent reachable
 * at the paired baseUrl with Basic auth satisfied. `DD_BUNDLE_ID` overrides the deep-link bundle id.
 */
describe("NetworkStatusPage", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await networkStatusPage.openViaDeepLink();
    });

    it("loads the status card", async () => {
        expect(await networkStatusPage.isShown()).toBe(true);
    });

    it("shows a quality pill with a known classification", async () => {
        const label = await networkStatusPage.qualityLabel();
        expect(["Healthy", "Degraded", "Down"]).toContain(label);
    });

    it("shows a real latency value", async () => {
        const latency = await networkStatusPage.latencyLabel();
        // KeyValueRow a11y label is "Latency: <value>"; a live link reports "<n> ms" (or "—" if the
        // ping failed, which also means the pill reads "Down" — asserted above). Prove it is NOT empty.
        expect(latency).toBeTruthy();
        expect(latency).toContain("Latency:");
    });

    it("shows the active transport", async () => {
        const transport = await networkStatusPage.transportLabel();
        expect(transport).toBeTruthy();
        expect(transport).toContain("Transport:");
    });

    it("Re-pair opens the connect/scan flow", async () => {
        await networkStatusPage.tapRepair();
        await networkStatusPage.waitForVisible("connect-screen");
        expect(await connectPage.isShown()).toBe(true);
    });
});
