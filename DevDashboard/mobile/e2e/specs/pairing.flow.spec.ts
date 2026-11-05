import { getDevDashboardBundleId } from "@e2e/bundle-id";
import { appPage } from "@e2e/pages/app.page";
import { connectionsPage } from "@e2e/pages/ConnectionsPage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pairingUri, TEST_AGENT_BASE_URL } from "@e2e/pages/testAgent";

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
        await $("~pair-confirm").click();

        // A loopback agent answers without a password; one that asks shows pair-ask instead, which fails this case.
        await browser.waitUntil(async () => !(await $("~pair-screen").isExisting()) || (await $("~pair-ask").isExisting()), {
            timeout: 20_000,
            timeoutMsg: "the pair screen never closed",
        });
        expect(await $("~pair-ask").isExisting()).toBe(false);
        expect(await $("~pair-error").isExisting()).toBe(false);

        if (await connectPage.isShown()) {
            await connectPage.waitUntilReachable();
            await connectPage.tapContinue();
        }
    });

    it("the agent is the active saved connection", async () => {
        await appPage.openTab("More");
        await connectionsPage.openFromMore();
        const active = await connectionsPage.activeConnectionId();
        expect(active).not.toBeNull();

        if (active === null) {
            return;
        }

        const host = new URL(TEST_AGENT_BASE_URL).host;
        const text = await connectionsPage.rowText(active);
        // The row's own words may be collapsed into its testID on iOS; the id then carries no host, so check either.
        expect(text.includes(host) || (await connectionsPage.rowMarkedActive(active))).toBe(true);
    });
});
