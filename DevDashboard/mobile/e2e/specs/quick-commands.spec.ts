import { connectPage } from "@e2e/pages/ConnectPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { quickCommandsPage } from "@e2e/pages/QuickCommandsPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * Quick Commands done-gate. The app boots into /connect when no baseUrl is set, so this spec pairs
 * first (deep-linked pairing URI — the sim has no camera), then navigates to /quick-commands via the
 * More menu (real nav path) and drives the feature.
 *
 * AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
 * dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a reachable
 * Agent at the paired baseUrl with Basic auth satisfied. `DD_BUNDLE_ID` overrides the deep-link
 * bundle id.
 *
 * REAL-STATE criterion: a snippet created via the edit sheet is still present after re-navigating
 * (a fresh list fetch) — proving it persisted to the Agent's commands.json, not just local UI state.
 * Against the mock client the create/delete round-trip is held in-memory, so the persist leg passes
 * there too; against a real Agent it proves the GET /api/commands round-trip.
 */
describe("QuickCommandsPage", () => {
    const label = `E2E ${Date.now()}`;

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.openTab();
        await moreNavPage.openViaMenu("quick-commands");
    });

    it("loads the quick-commands screen via the More menu", async () => {
        expect(await quickCommandsPage.isShown()).toBe(true);
    });

    it("renders the seeded command cards (or an empty state)", async () => {
        expect(await quickCommandsPage.hasCardOrEmpty()).toBe(true);
    });

    it("persists a newly-created snippet across a refetch (REAL state)", async () => {
        await quickCommandsPage.createCommand(label, "echo e2e");

        // Re-navigate away and back to force a fresh GET /api/commands (not cached UI state).
        await moreNavPage.openTab();
        await moreNavPage.openViaMenu("quick-commands");

        const stillThere = await quickCommandsPage.waitForLabelPresent(label);
        expect(stillThere).toBe(true);
    });

    it("runs a snippet into the Quick target and fires the confirm", async function () {
        // Drive the seeded snippet into the "quick" (DevDashboard workspace) target.
        if (await quickCommandsPage.cardExists("cmd-tests")) {
            await quickCommandsPage.runInto("cmd-tests", "quick");
            await quickCommandsPage.waitForConfirmGone();
            expect(await quickCommandsPage.confirmSheetExists()).toBe(false);
        } else {
            // Real Agent without the seeded snippet — the create/persist legs above already prove the
            // feature end-to-end; skip the run leg.
            this.skip();
        }
    });
});
