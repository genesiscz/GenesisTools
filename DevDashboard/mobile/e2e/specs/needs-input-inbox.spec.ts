import { connectPage } from "@e2e/pages/ConnectPage.page";
import { needsInputInboxPage } from "@e2e/pages/NeedsInputInboxPage.page";

// Done-gate for the Needs-Input Inbox feature (plan 2026-06-02). The app boots into /connect whenever
// no baseUrl is set, so this spec first pairs (deep-linked pairing URI, same as qa/daemon/reminders
// specs — the sim has no camera), which opens the authenticated app, then reaches the inbox via the
// More hub row (`more-link-needs-input-inbox`) — the REAL user path that proves the wiring. The screen
// root wraps a FlatList (reports `displayed=false`), so navigation waits on the displayed count child.
//
// AUTHORED, NOT RUN here (device run is user-gated). Prereqs (owned by the user): a booted iOS sim with
// the dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a
// reachable test Agent at the paired baseUrl. The mock fixtures make every step runnable headless once
// a sim is up: one agent-question item + one agent-session item that hands off to the real `ttyd-1`
// mock terminal. `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Load-bearing real-state assertions (not smoke clicks): tapping an agent-session item NAVIGATES to
// the Terminals screen and the session actually opens (the store deep-link handoff), and tapping an
// agent-question item RESOLVES it (mark-read mutation → list invalidates → the count drops).
describe("NeedsInputInboxPage", () => {
    const bundleId = process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard";

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        // Reach the inbox via the More hub row (the real user path → proves `more-link-needs-input-inbox`).
        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await needsInputInboxPage.waitForExist("more-link-needs-input-inbox");
        await needsInputInboxPage.openViaMenu();
    });

    it("shows the inbox with a count", async () => {
        expect(await needsInputInboxPage.isShown()).toBe(true);
        const count = await needsInputInboxPage.count();
        expect(Number.isNaN(count)).toBe(false);
        expect(count).toBeGreaterThanOrEqual(0);
    });

    it("renders items or the empty state", async () => {
        expect(await needsInputInboxPage.hasItemsOrEmpty()).toBe(true);
    });

    // REAL NAVIGATION: an agent-session item opens its live terminal via the store deep-link handoff.
    // Skip cleanly when no agent-session item is present (e.g. a real device with no live agent).
    it("tapping an agent-session item opens the terminal", async function () {
        const id = await needsInputInboxPage.firstItemOfKind("agent-session");
        if (!id) {
            this.skip();
            return;
        }

        await needsInputInboxPage.tapItem(id);
        await needsInputInboxPage.waitForTerminalOpen();

        expect(await needsInputInboxPage.terminalsScreenVisible()).toBe(true);
    });

    // REAL STATE: an agent-question item resolves (mark read) and the queue count drops. Skip when no
    // agent-question item is present so the structural checks above still run everywhere. Re-enters via
    // the More hub because the previous test may have navigated to Terminals.
    it("tapping an agent-question item resolves it", async function () {
        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await needsInputInboxPage.openViaMenu();

        const id = await needsInputInboxPage.firstItemOfKind("agent-question");
        if (!id) {
            this.skip();
            return;
        }

        const before = await needsInputInboxPage.count();

        await needsInputInboxPage.tapItem(id);

        await needsInputInboxPage.waitUntil(async () => (await needsInputInboxPage.count()) < before, {
            message: "expected the inbox count to drop after resolving an agent-question item",
        });

        expect(await needsInputInboxPage.count()).toBeLessThan(before);
    });
});
