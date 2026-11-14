import { getDevDashboardBundleId } from "@e2e/bundle-id";
import { appPage } from "@e2e/pages/app.page";
import { connectionsPage } from "@e2e/pages/ConnectionsPage.page";
import { confirmPairing, pairingUri, TEST_AGENT_BASE_URL } from "@e2e/pages/testAgent";

/**
 * Pairing, end to end against the test agent (DD_TEST_AGENT, a side agent on loopback): a pairing link opens the pair
 * screen, which names the address and connects nothing until Pair is tapped; after the tap the app leaves the pair
 * screen, the agent's address is a saved connection, and that connection is the active one.
 */
describe("Pairing flow", () => {
    it("a pairing link waits on the pair screen until Pair is tapped", async () => {
        await browser.execute("mobile: deepLink", { url: pairingUri(), bundleId: getDevDashboardBundleId() });

        const screen = await $("~pair-screen");
        await screen.waitForExist({ timeout: 15_000 });
        expect(await $("~pair-target").isExisting()).toBe(true);
        expect(await $("~pair-confirm").isDisplayed()).toBe(true);

        // Nothing happened yet: the screen is still there a moment later.
        await browser.pause(1500);
        expect(await screen.isExisting()).toBe(true);
    });

    it("Pair connects and leaves the pair screen", async () => {
        // A loopback agent answers without a password; one that asks for one or shows an error fails this case.
        await confirmPairing();
    });

    it("the agent is the active saved connection", async () => {
        await appPage.openTab("More");
        await connectionsPage.openFromMore();
        const active = await connectionsPage.activeConnectionId();
        expect(active).not.toBeNull();

        if (active === null) {
            return;
        }

        await connectionsPage.openEditForm(active);
        try {
            expect(await $("~connection-host").getValue()).toBe(new URL(TEST_AGENT_BASE_URL).host);
        } finally {
            await connectionsPage.cancelForm();
        }
    });
});
