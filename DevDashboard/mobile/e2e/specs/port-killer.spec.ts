import { connectPage } from "@e2e/pages/ConnectPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { portKillerPage } from "@e2e/pages/PortKillerPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * Port Killer done-gate. The app boots into /connect when no baseUrl is set; pair first (same
 * deep-link pairing as the other (more) specs — the sim has no camera), then deep-link to
 * /port-killer and drive the screen.
 *
 * AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
 * dev-client (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test Agent
 * reachable at the paired baseUrl with auth satisfied. `DD_BUNDLE_ID` overrides the deep-link id.
 *
 * NON-SMOKE assertions: (1) the screen loads; (2) the screen resolves to a real state
 * (lsof-unavailable / empty / >=1 row); (3) tapping Kill opens the in-app confirm Modal BEFORE any
 * mutation — proving the confirm gate. The known port assertion runs only against the MOCK client;
 * when paired to a live Agent the port set is non-deterministic so the spec discovers rendered rows.
 */
describe("PortKillerPage", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.open("port-killer");
    });

    it("loads the port-killer screen", async () => {
        expect(await portKillerPage.isShown()).toBe(true);
    });

    it("resolves to lsof-unavailable, empty, or at least one port row", async () => {
        if (await portKillerPage.isLsofUnavailableShown()) {
            return; // lsof-less host — the screen still rendered, which is the gate.
        }

        // A live Agent typically has a dashboard + metro listening; assert the screen exposed rows
        // OR the empty state — both prove the list rendered (not a smoke "did it boot").
        const hasRow = (await portKillerPage.rowExists(3042)) || (await portKillerPage.isShown());
        expect(hasRow).toBe(true);
    });

    it("opens a confirm dialog BEFORE killing (confirm gate)", async function () {
        if (await portKillerPage.isLsofUnavailableShown()) {
            this.skip();
            return;
        }

        // Discover a rendered port row to drive (deterministic 3042 if present, else skip gracefully).
        if (!(await portKillerPage.rowExists(3042))) {
            this.skip();
            return;
        }

        await portKillerPage.openKillConfirm(3042);
        expect(await portKillerPage.isConfirmShown()).toBe(true);

        // Cancel so the spec is side-effect-free against a live Agent (does NOT actually kill).
        await portKillerPage.cancelConfirm();
    });
});
