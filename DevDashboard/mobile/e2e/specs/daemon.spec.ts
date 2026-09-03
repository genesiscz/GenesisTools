import { connectPage } from "@e2e/pages/ConnectPage.page";
import { daemonPage } from "@e2e/pages/DaemonPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The Daemon feature done-gate (plan 09 / the "More" rest features). The app boots into /connect
// whenever no baseUrl is set (root `Stack.Protected guard={baseUrl !== null}`), so this spec first
// pairs (deep-linked pairing URI, same as connect/pulse specs — the sim has no camera), which opens
// the authenticated app, then navigates to /daemon via the `(more)` deep link
// (`daemonPage.openViaDeepLink`) and drives the screen. The daemon screen root is a FlatList wrapper
// that reports `displayed=false`, so navigation waits on the displayed status header instead.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
// dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
// Agent reachable at the paired baseUrl with Basic auth satisfied (see plan-04 note — an empty
// password 401s the probe). `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// The status header + status pill always render (the pill reads one of Running/Stopped/Not
// installed). Run rows + the run-log sheet only exist when the daemon has recorded runs, so the
// log-sheet open/close step opens a known run by id supplied via DD_DAEMON_RUN_ID (recorded
// out-of-band on the Agent host) and `this.skip()`s when that env is unset — the always-present
// status checks still run everywhere.
//
// Done criterion: the screen loads with a status header + a known status pill, recent runs (or the
// no-runs empty card) render, and a run row opens its log sheet which then closes cleanly.
describe("DaemonPage", () => {
    // A daemon run id present on the test Agent (recorded out-of-band). When unset, the run-log
    // open/close assertion is skipped (the status + runs-or-empty checks still run).
    const runId = process.env.DD_DAEMON_RUN_ID ?? "";

    before(async () => {
        // Pair so the auth gate opens, then navigate to the daemon More screen.
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await daemonPage.openViaDeepLink();
    });

    it("loads the daemon screen with a status header", async () => {
        expect(await daemonPage.isShown()).toBe(true);
        expect(await daemonPage.statusHeaderVisible()).toBe(true);
    });

    it("shows a status pill with a known label", async () => {
        const label = await daemonPage.statusPillLabel();
        expect(["Running", "Stopped", "Not installed"]).toContain(label);
    });

    it("shows recent run rows or the no-runs empty card", async () => {
        expect(await daemonPage.hasRunsOrEmpty()).toBe(true);
    });

    // The run-log sheet only exists when the daemon has runs; tapping a row needs a known runId from
    // the test Agent. Skip when DD_DAEMON_RUN_ID is unset so the screen/status checks still run.
    it("opens a run's log sheet and closes it", async function () {
        if (!runId) {
            this.skip();
            return;
        }

        await daemonPage.openRunLog(runId);
        expect(await daemonPage.logSheetVisible()).toBe(true);

        await daemonPage.closeRunLog();
        await daemonPage.waitForLogSheetGone();
        expect(await daemonPage.logSheetVisible()).toBe(false);
    });
});
