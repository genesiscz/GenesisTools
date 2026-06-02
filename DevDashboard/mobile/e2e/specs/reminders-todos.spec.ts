import { connectPage } from "@e2e/pages/ConnectPage.page";
import { remindersTodosPage } from "@e2e/pages/RemindersTodosPage.page";

// Done-gate for the Reminders & Todos feature (plan 2026-06-02). The app boots into /connect whenever
// no baseUrl is set, so this spec first pairs (deep-linked pairing URI, same as qa/daemon specs — the
// sim has no camera), which opens the authenticated app, then deep-links to /reminders-todos and
// drives the screen. The screen root is a `<Screen>` ScrollView (`displayed=true`), so navigation
// waits on the root directly.
//
// AUTHORED, NOT RUN here (device run is user-gated). Prereqs (owned by the user): a booted iOS sim
// with the dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and —
// for the real-state add/complete on a device — a reachable test Agent with Reminders access granted.
// The stateful mock makes the loads / list / complete / add steps runnable headless once a sim is up.
// `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// The load-bearing real-state assertions: completing a row REMOVES it from the active list (the list
// query invalidates → refetch → the completed item drops out because includeCompleted=false), and an
// add APPEARS (row count grows). These are not smoke clicks — they assert observable state change.
describe("RemindersTodosPage", () => {
    // Set DD_TODOS_EXPECT_DENIED=1 on a host where the Agent reports a 503 Reminders denial to assert
    // the permission banner; otherwise that case skips (the rest run everywhere).
    const expectDenied = process.env.DD_TODOS_EXPECT_DENIED === "1";

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        await remindersTodosPage.openViaDeepLink();
    });

    it("loads the reminders screen with the add form", async () => {
        expect(await remindersTodosPage.isShown()).toBe(true);
        expect(await remindersTodosPage.addInputShown()).toBe(true);
    });

    it("shows reminder rows or the empty state", async () => {
        expect(await remindersTodosPage.hasRowsOrEmpty()).toBe(true);
    });

    // REAL STATE: completing a row removes it from the active list. Under the stateful mock rem-1 is
    // seeded; on a real device the first visible row's id would be captured instead. Skip cleanly when
    // the seeded row is absent (e.g. a real device with a different list) so the structural checks
    // above still run everywhere.
    it("completing a row removes it from the active list", async function () {
        const id = "rem-1";
        if (!(await remindersTodosPage.rowExists(id))) {
            this.skip();
            return;
        }

        expect(await remindersTodosPage.rowExists(id)).toBe(true);

        await remindersTodosPage.tapComplete(id);
        await remindersTodosPage.waitForRowGone(id);

        expect(await remindersTodosPage.rowExists(id)).toBe(false);
    });

    // REAL STATE: adding a reminder appears in the list (the add mutation invalidates the list →
    // refetch). Under the stateful mock the new row is appended; the row count grows by one.
    it("adding a reminder appears in the list", async () => {
        const before = await remindersTodosPage.rowCount();

        await remindersTodosPage.typeNewTitle(`Appium added ${Date.now()}`);
        await remindersTodosPage.submitAdd();

        await remindersTodosPage.waitUntil(async () => (await remindersTodosPage.rowCount()) > before, {
            message: "expected a new reminder row to appear after submitting the add form",
        });

        expect(await remindersTodosPage.rowCount()).toBeGreaterThan(before);
    });

    // Permission-denied is environment-gated: only assert the banner when the Agent reports a 503.
    it("renders the permission banner when access is denied", async function () {
        if (!expectDenied) {
            this.skip();
            return;
        }

        expect(await remindersTodosPage.permissionBannerShown()).toBe(true);
        expect(await remindersTodosPage.grantAccessExists()).toBe(true);
    });
});
