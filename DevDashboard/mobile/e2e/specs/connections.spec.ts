import { connectionsPage } from "@e2e/pages/ConnectionsPage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";

/**
 * Verifies the already-implemented Connections / Configuration screen (`src/features/connections`),
 * one `it()` per feature. The app boots into /connect whenever no baseUrl is set (root
 * `Stack.Protected guard={baseUrl !== null}`), but boot-restore usually re-opens the gate, so the
 * `before()` only pairs when the connect screen is actually shown, then lands on the More tab and
 * taps `more-link-connections` (via the page object's own `openFromMore`, kept self-contained rather
 * than importing MoreNav.page which a parallel agent owns).
 *
 * AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
 * dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
 * Agent reachable at the paired baseUrl with Basic auth satisfied. `DD_BUNDLE_ID` overrides the
 * deep-link bundle id.
 *
 * SAFETY: these specs run against the LIVE, boot-restored connection. They never delete or
 * deactivate the active connection (doing so resets the connect gate other specs depend on) — they
 * assert affordances EXIST and that the add/edit forms OPEN, then back out via Cancel. The add form
 * is opened and cancelled WITHOUT submitting (a bogus host would break the live gate). Delete is only
 * asserted to exist; its native confirm `Alert` is never accepted.
 *
 * Done criterion: the screen loads via More, the live connection is listed with an active marker +
 * its host:port, the add form opens (then cancels), and the active row exposes edit + (guarded)
 * delete affordances.
 */
describe("ConnectionsPage", () => {
    const bundleId = process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard";

    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.pairWithTestAgent();
        }

        // Reach the More hub by deep link and gate on its Connections row EXISTING, rather than via
        // `appPage.openTab("More")` (which waits on the `screen-more` ScrollView root being displayed —
        // an unreliable flag), then tap through to the Connections screen.
        await browser.execute("mobile: deepLink", { url: "devdashboard:///more", bundleId });
        await connectionsPage.waitForExist("more-link-connections");
        await connectionsPage.openFromMore();
    });

    it("loads the Connections screen via More → Connections", async () => {
        expect(await connectionsPage.isShown()).toBe(true);
    });

    it("lists the active connection with an active marker and its host:port", async () => {
        // Boot-restore makes the app connected, so at least one saved row must render.
        expect(await connectionsPage.connectionCount()).toBeGreaterThan(0);

        const activeId = await connectionsPage.activeConnectionId();
        expect(activeId).not.toBeNull();

        if (activeId === null) {
            return;
        }

        expect(await connectionsPage.rowVisible(activeId)).toBe(true);

        // The readable active marker is structural: the active row renders a "Connected" badge instead
        // of a `btn-activate-<id>` button (the glowing dot + accent pill + "ACTIVE ·" / host:port text
        // are all opaque — the row View carries an `accessibilityLabel`, collapsing its inner Texts, so
        // `getText`/the address line are not readable via a11y). Absence of the Activate button on a
        // present row is the active signal.
        expect(await connectionsPage.rowMarkedActive(activeId)).toBe(true);
    });

    it("opens the inline LAN add form when tapping Add, then cancels without submitting", async () => {
        expect(await connectionsPage.addButtonVisible()).toBe(true);

        await connectionsPage.openAddForm();
        expect(await connectionsPage.addFormVisible()).toBe(true);

        // The LAN add form must surface its label/host/username/password fields.
        expect(await connectionsPage.addFormFieldsVisible()).toBe(true);

        // Back out via Cancel WITHOUT submitting — a bogus connection would break the live gate.
        await connectionsPage.cancelForm();
        expect(await connectionsPage.addFormVisible()).toBe(false);
    });

    it("exposes an edit affordance for the active connection (opens the edit form, then cancels)", async () => {
        const activeId = await connectionsPage.activeConnectionId();
        expect(activeId).not.toBeNull();

        if (activeId === null) {
            return;
        }

        expect(await connectionsPage.editExists(activeId)).toBe(true);

        // Opening the edit form is non-destructive; back out via Cancel without saving.
        await connectionsPage.openEditForm(activeId);
        expect(await connectionsPage.editFormVisible()).toBe(true);

        await connectionsPage.cancelForm();
        expect(await connectionsPage.editFormVisible()).toBe(false);
    });

    it("exposes a delete affordance for the active connection (existence only — never accept the confirm)", async () => {
        const activeId = await connectionsPage.activeConnectionId();
        expect(activeId).not.toBeNull();

        if (activeId === null) {
            return;
        }

        // Assert the delete button EXISTS only. Deleting the active connection would erase its saved
        // password + reset the connect gate, breaking the boot-restore state other specs rely on, so
        // the native confirm Alert is intentionally never tapped here.
        expect(await connectionsPage.deleteExists(activeId)).toBe(true);
    });
});
