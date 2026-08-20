import { connectPage } from "@e2e/pages/ConnectPage.page";
import { tmuxPresetsPage } from "@e2e/pages/TmuxPresetsPage.page";

// Done-gate for the Tmux Presets feature (plan 2026-06-02). The app boots into /connect whenever no
// baseUrl is set, so this spec first pairs (deep-linked pairing URI, same as qa/daemon/reminders
// specs — the sim has no camera), which opens the authenticated app, then deep-links to /tmux-presets
// and drives the screen. The screen root is a `<Screen>` ScrollView (`displayed=true`), so navigation
// waits on the root directly.
//
// AUTHORED, NOT RUN here (device run is user-gated). Prereqs (owned by the user): a booted iOS sim
// with the dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and —
// for real-state restore on a device — a reachable test Agent. The stateful mock makes the
// load / list / confirm-dialog / capture / delete steps runnable headless once a sim is up.
// `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// The load-bearing real-state assertions: a known preset row renders its summary counts (proves the
// summarize() counts round-tripped through the route to the screen), tapping Restore opens an explicit
// confirm DIALOG (asserted, not just the tap), and capturing a new preset ADDS a row. The restore test
// CANCELS — never accepts — because `restoreTmuxSession` spawns real tmux sessions on the host.
describe("TmuxPresetsPage", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        await tmuxPresetsPage.openViaDeepLink();
    });

    it("loads the screen", async () => {
        expect(await tmuxPresetsPage.isShown()).toBe(true);
    });

    it("shows preset rows or the empty state", async () => {
        expect(await tmuxPresetsPage.hasRowsOrEmpty()).toBe(true);
    });

    // REAL STATE: a known preset row renders with its summary counts. Under the stateful mock
    // "morning-dev" is seeded; on a real device a different preset may be present, so skip cleanly when
    // the seeded row is absent (the structural checks above still run everywhere).
    it("renders a preset row with its summary counts (real state, not just a screen)", async function () {
        const name = "morning-dev";
        if (!(await tmuxPresetsPage.rowExists(name))) {
            this.skip();
            return;
        }

        await tmuxPresetsPage.waitForVisible(tmuxPresetsPage.summaryId(name));
        const summary = await tmuxPresetsPage.summaryText(name);
        expect(summary).toMatch(/session.*window.*pane/);
    });

    // REAL STATE: tapping Restore opens an explicit confirm DIALOG (the load-bearing assertion — a tap
    // alone never mutates the host). We CANCEL so no tmux sessions are spawned on the host machine.
    it("opens an explicit confirm DIALOG before restoring", async function () {
        const name = "morning-dev";
        if (!(await tmuxPresetsPage.rowExists(name))) {
            this.skip();
            return;
        }

        await tmuxPresetsPage.tapRestore(name);
        expect(await tmuxPresetsPage.confirmVisible()).toBe(true);
        expect(await tmuxPresetsPage.confirmTitleText()).toContain(name);

        await tmuxPresetsPage.cancelConfirm();
        await tmuxPresetsPage.waitForGone("tmux-presets-confirm");
        expect(await tmuxPresetsPage.confirmGone()).toBe(true);
    });

    // REAL STATE: capturing a new preset appends a row (the capture mutation invalidates the list →
    // refetch). Then it cleans up after itself via the delete confirm so reruns stay clean.
    it("captures a new preset and the new row appears", async () => {
        const name = `e2e-${Date.now()}`;

        await tmuxPresetsPage.capture(name, "from appium");
        await tmuxPresetsPage.waitForVisible(tmuxPresetsPage.rowId(name));
        expect(await tmuxPresetsPage.rowExists(name)).toBe(true);

        // Cleanup: delete the preset we just created (confirm DIALOG → accept → row gone).
        await tmuxPresetsPage.tapDelete(name);
        expect(await tmuxPresetsPage.confirmVisible()).toBe(true);
        await tmuxPresetsPage.acceptConfirm();
        await tmuxPresetsPage.waitForRowGone(name);
        expect(await tmuxPresetsPage.rowExists(name)).toBe(false);
    });
});
