import { appPage } from "@e2e/pages/app.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pulsePage } from "@e2e/pages/PulsePage.page";

// The Pulse feature done-gate (plan 05 / D32 reference screen). The app boots into /connect
// whenever no baseUrl is set (root `Stack.Protected guard={baseUrl !== null}`), so this spec first
// pairs (deep-linked pairing URI, same as connect.spec — the sim has no camera), which opens the
// tab bar, then drives the Pulse tab.
//
// Prereqs (device run, owned by the user): a booted iOS sim with the dev-client installed
// (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test Agent reachable at the
// paired baseUrl with Basic auth satisfied (see plan-04 note — an empty password 401s the probe).
// `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Done criterion: all KPI/chart/sparkline/process/network/weather cards visible, both chart
// CONTAINERS present (Skia canvas is opaque), and the CPU KPI is a real reading that updates (or is
// at least non-"—") across poll cycles.
describe("PulsePage", () => {
    before(async () => {
        // Pair so the tab gate opens, then land on the Pulse tab. `pairWithTestAgent` is the
        // canonical connect-gate clear — every feature spec's `before()` should reuse it.
        if (await connectPage.isShown()) {
            await connectPage.pairWithTestAgent();
        }

        await appPage.openTab("Pulse");
    });

    it("loads the Pulse screen", async () => {
        await pulsePage.waitForLoaded();
        expect(await pulsePage.isShown()).toBe(true);
    });

    it("shows all cards (KPI grid, disk, wifi, sparklines, process/network/weather)", async () => {
        expect(await pulsePage.allCardsVisible()).toBe(true);
    });

    it("renders the CPU and memory chart containers", async () => {
        expect(await pulsePage.chartsVisible()).toBe(true);
    });

    it("shows a real CPU reading that updates over time (live polling)", async () => {
        // Either the value moved, or at minimum both reads are real (not the em-dash placeholder).
        expect(await pulsePage.cpuReadingIsLive()).toBe(true);
    });

    it("keeps the charts mounted when switching the range to 2h", async () => {
        await pulsePage.selectRange2h();
        await browser.pause(500);
        expect(await pulsePage.chartsVisible()).toBe(true);
    });
});
