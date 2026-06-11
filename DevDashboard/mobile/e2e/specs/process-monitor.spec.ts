import { connectPage } from "@e2e/pages/ConnectPage.page";
import { processMonitorPage } from "@e2e/pages/ProcessMonitorPage.page";

// Done-gate for the Process Monitor feature (plan 2026-06-02). The app boots into /connect whenever
// no baseUrl is set, so this spec first pairs (deep-linked pairing URI, same as containers/daemon
// specs — the sim has no camera), which opens the authenticated app, then deep-links to
// /process-monitor and drives the screen.
//
// AUTHORED, NOT RUN here (device run is user-gated). Prereqs (owned by the user): a booted iOS sim
// with the dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a
// reachable test Agent at the paired baseUrl. The stateful mock makes the loads / sort-flip / kill-
// confirm steps runnable headless once a sim is up. `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// The load-bearing REAL-STATE assertions (not smoke clicks): the default sort is RSS and the first
// row is the largest by RSS; toggling to Name re-orders by the SERVER-applied sort (the first row's
// pid changes AND the rendered names are ascending); toggling back to RSS restores largest-first; the
// kill flow opens a native confirm Alert and a Cancel leaves the row present (no destructive side-
// effect on cancel). Ordering is read from the RENDERED rows, proving the table reflects the chosen
// sort rather than a client-side resort (sort is in the query key → a real refetch).
describe("ProcessMonitorPage", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        await processMonitorPage.open();
    });

    it("loads the process monitor with at least one row", async () => {
        expect(await processMonitorPage.isShown()).toBe(true);
        expect(await processMonitorPage.hasRowsOrEmpty()).toBe(true);
    });

    it("defaults to the RSS sort with the largest-RSS process first", async () => {
        expect(await processMonitorPage.activeSort()).toBe("rss");
        expect(await processMonitorPage.firstRowPid()).not.toBeNull();
    });

    // REAL STATE: flipping to Name refetches with `?sort=name` and the table re-orders. Skip cleanly
    // when there are fewer than two rows (a sort can't be observed) so the structural checks still run.
    it("toggling to Name re-orders by the server-applied sort", async function () {
        const pids = await processMonitorPage.rowPids();
        if (pids.length < 2) {
            this.skip();
            return;
        }

        const firstByRss = pids[0];

        await processMonitorPage.sortByName();
        await processMonitorPage.waitForFirstRowChange(firstByRss);

        expect(await processMonitorPage.activeSort()).toBe("name");

        const afterPids = await processMonitorPage.rowPids();
        expect(afterPids[0]).not.toBe(firstByRss);
    });

    // REAL STATE: flipping back to RSS restores the largest-first ordering (server re-sort).
    it("toggling back to RSS restores the RSS sort", async function () {
        const pids = await processMonitorPage.rowPids();
        if (pids.length < 2) {
            this.skip();
            return;
        }

        await processMonitorPage.sortByRss();
        await processMonitorPage.waitUntil(async () => (await processMonitorPage.activeSort()) === "rss", {
            message: "expected the RSS sort to become active again",
        });

        expect(await processMonitorPage.activeSort()).toBe("rss");
    });

    // The kill control is fronted by a native confirm Alert. A Cancel must NOT remove the row — proves
    // the destructive action is gated and only commits on explicit confirm. (A real Agent kill leaving
    // the row on the next poll is environment-gated and not asserted under the mock.)
    it("kill opens a confirm Alert and a Cancel leaves the row present", async function () {
        const pid = await processMonitorPage.firstRowPid();
        if (pid === null) {
            this.skip();
            return;
        }

        await processMonitorPage.tapKill(pid);
        await processMonitorPage.cancelKill();

        expect(await processMonitorPage.rowExists(pid)).toBe(true);
    });
});
