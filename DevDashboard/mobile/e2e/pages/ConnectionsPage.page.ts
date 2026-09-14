import type { ChainablePromiseElement } from "webdriverio";
import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Connections / Configuration screen (`src/features/connections`). Locates by the
 * `testID`/`accessibilityLabel`s baked into `ConnectionsScreen` + `ConnectionRow` + `ConnectionForm`
 * (accessibility-id via the `~` selector in BasePage). Mirrors the harness convention (extends
 * BasePage, singleton export) used by ConnectPage/PulsePage.
 *
 * Self-contained navigation: rather than importing `MoreNav.page` (authored by a parallel agent),
 * this page taps `more-link-connections` directly via `openFromMore`, so the connections spec does
 * not couple to another feature's page object.
 *
 * SAFETY: the connection rows render against the LIVE, boot-restored connection. The delete control
 * is fronted by a native `Alert.alert` confirm and `btn-delete-<id>` only opens that alert — these
 * helpers therefore assert affordances EXIST / forms OPEN and back out via Cancel; they never commit
 * a destructive action on the active connection.
 */
class ConnectionsPage extends BasePage {
    private readonly ids = {
        screen: "screen-connections",
        empty: "connections-empty",
        error: "connections-error",
        addButton: "btn-add-connection",
        pairButton: "btn-pair-connect",
        emptyConnect: "btn-empty-connect",
        addForm: "connection-add-form",
        editForm: "connection-edit-form",
        formHost: "connection-host",
        formLabel: "connection-label",
        formUsername: "connection-username",
        formPassword: "connection-password",
        formSubmit: "btn-submit-connection",
        formCancel: "btn-cancel-connection",
        moreLink: "more-link-connections",
    } as const;

    /** Tap the More-tab Connections link and wait for the connections screen to render. */
    async openFromMore(): Promise<void> {
        await this.tap(this.ids.moreLink);
        await this.waitForVisible(this.ids.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    rowId(id: string): string {
        return `connection-row-${id}`;
    }

    editId(id: string): string {
        return `btn-edit-${id}`;
    }

    deleteId(id: string): string {
        return `btn-delete-${id}`;
    }

    activateId(id: string): string {
        return `btn-activate-${id}`;
    }

    /** The explicit "this connection is active" marker — renders iff the row is the live connection. */
    activeId(id: string): string {
        return `connection-active-${id}`;
    }

    /**
     * The accessibility ids of all rendered `connection-row-<id>` row containers. Connection ids are
     * assigned at runtime (the store mints them), so specs cannot hard-code a `connection-row-<id>`;
     * this discovers them from the a11y tree by id prefix. The predicate matches both the iOS
     * XCUITest `name` attribute and the Android UiAutomator2 `content-desc` so the same query works
     * on either driver.
     */
    private async rowIds(): Promise<string[]> {
        const rows = await $$(
            '//*[starts-with(@name, "connection-row-") or starts-with(@content-desc, "connection-row-")]',
        );
        const ids: string[] = [];

        for (const row of rows) {
            const name = (await row.getAttribute("name")) ?? (await row.getAttribute("content-desc"));

            if (!name) {
                continue;
            }

            ids.push(name.replace(/^connection-row-/, ""));
        }

        return ids;
    }

    /** How many `connection-row-<id>` rows are currently rendered. */
    async connectionCount(): Promise<number> {
        return (await this.rowIds()).length;
    }

    /**
     * The id of the first saved connection row. Returns null when no row is present (empty state).
     * Used to derive per-row affordance testIDs (`btn-edit-<id>`, `btn-delete-<id>`) without guessing.
     */
    async firstConnectionId(): Promise<string | null> {
        const ids = await this.rowIds();
        return ids[0] ?? null;
    }

    /**
     * The active connection's row id. Primary signal: the explicit `connection-active-<id>` marker,
     * which `ConnectionRow` renders iff the row is the live connection — discovered from the a11y tree
     * by id prefix. Fallback (older builds without the marker): the active row is the only one WITHOUT
     * a `btn-activate-<id>` button (it renders a "Connected" badge instead). Finally falls back to the
     * first row.
     */
    async activeConnectionId(): Promise<string | null> {
        const markers = await $$(
            '//*[starts-with(@name, "connection-active-") or starts-with(@content-desc, "connection-active-")]',
        );

        for (const marker of markers) {
            const name = (await marker.getAttribute("name")) ?? (await marker.getAttribute("content-desc"));

            if (name) {
                return name.replace(/^connection-active-/, "");
            }
        }

        const ids = await this.rowIds();

        for (const id of ids) {
            if (!(await this.byId(this.activateId(id)).isExisting())) {
                return id;
            }
        }

        return ids[0] ?? null;
    }

    rowEl(id: string): ChainablePromiseElement {
        return this.byId(this.rowId(id));
    }

    async rowVisible(id: string): Promise<boolean> {
        return this.isVisible(this.rowId(id));
    }

    async editExists(id: string): Promise<boolean> {
        return this.isExisting(this.editId(id));
    }

    async deleteExists(id: string): Promise<boolean> {
        return this.isExisting(this.deleteId(id));
    }

    /**
     * Read the full visible text of a connection row. NOTE: the row `View` carries an
     * `accessibilityLabel` (= its testID), which collapses the subtree into a single iOS a11y element
     * — so `getText` returns the row's TESTID, not the inner label / `host:port` lines (verified: the
     * row reports zero a11y descendants). The host:port Text is therefore not readable by a11y; use
     * `rowMarkedActive` (button-presence based) for the active signal instead.
     */
    async rowText(id: string): Promise<string> {
        return this.getText(this.rowId(id));
    }

    /**
     * True when the row is marked active. Primary signal: the explicit `connection-active-<id>` marker,
     * which `ConnectionRow` renders (with its own accessibilityLabel) iff the row is the live
     * connection. Fallback (older builds): the active row renders a `"Connected"` badge INSTEAD of a
     * `btn-activate-<id>` button, so "active" == the row exists AND it has no Activate button (the
     * decorative `ActiveDot` / accent `StatusPill` / `"ACTIVE · …"` line stay opaque to the a11y tree).
     */
    async rowMarkedActive(id: string): Promise<boolean> {
        if (await this.byId(this.activeId(id)).isExisting()) {
            return true;
        }

        const rowExists = await this.byId(this.rowId(id)).isExisting();
        const hasActivateButton = await this.byId(this.activateId(id)).isExisting();
        return rowExists && !hasActivateButton;
    }

    async addButtonVisible(): Promise<boolean> {
        return this.isVisible(this.ids.addButton);
    }

    /**
     * Tap "Add LAN connection" and wait for the inline add form to appear. The `connection-add-form`
     * wrapper View reports `displayed=false` on iOS (it carries an `accessibilityLabel`, collapsing it
     * into a non-painting a11y node), so gate on the form EXISTING plus its first field being
     * displayed — the fields render as their own displayed elements (verified: form `displayed=false`,
     * every input `displayed=true`).
     */
    async openAddForm(): Promise<void> {
        await this.tap(this.ids.addButton);
        await this.waitForExist(this.ids.addForm);
        await this.waitForVisible(this.ids.formHost);
    }

    /**
     * "Add form is open" = the form root exists AND its host field is displayed. The form wrapper's
     * `displayed` flag is unreliable (see `openAddForm`), so the displayed field is the readable
     * signal; when closed the root no longer exists.
     */
    async addFormVisible(): Promise<boolean> {
        return (await this.isExisting(this.ids.addForm)) && (await this.isVisible(this.ids.formHost));
    }

    /** True when the add form's host/username/password fields are all rendered. */
    async addFormFieldsVisible(): Promise<boolean> {
        for (const id of [this.ids.formLabel, this.ids.formHost, this.ids.formUsername, this.ids.formPassword]) {
            if (!(await this.isVisible(id))) {
                return false;
            }
        }

        return true;
    }

    /** Cancel out of the add/edit form (Cancel button), returning to the list without submitting. */
    async cancelForm(): Promise<void> {
        await this.tap(this.ids.formCancel);
        await this.waitForGone(this.ids.formCancel);
    }

    /**
     * Open the edit form for a connection and wait for it to appear (non-destructive — back out via
     * cancelForm). Like the add form, the `connection-edit-form` wrapper reports `displayed=false`, so
     * gate on the form existing plus its host field being displayed.
     */
    async openEditForm(id: string): Promise<void> {
        await this.tap(this.editId(id));
        await this.waitForExist(this.ids.editForm);
        await this.waitForVisible(this.ids.formHost);
    }

    /** "Edit form is open" = the form root exists AND its host field is displayed (see `openEditForm`). */
    async editFormVisible(): Promise<boolean> {
        return (await this.isExisting(this.ids.editForm)) && (await this.isVisible(this.ids.formHost));
    }
}

export const connectionsPage = new ConnectionsPage();
