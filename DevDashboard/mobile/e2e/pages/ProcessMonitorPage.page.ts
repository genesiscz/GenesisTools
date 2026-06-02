import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Process Monitor screen (plan 2026-06-02). Locates by the `testID`s baked into
 * the screen + its components (accessibility-id via the `~` selector in BasePage). The screen root is
 * a `<ScrollView>` (`displayed=true`), so `open` waits on the root directly.
 *
 * The sort toggle drives a REAL server refetch (sort is in the query key), so the ordering helpers
 * read the RENDERED rows in a11y-tree order — proving the table reflects the server-applied sort, not
 * a client-side resort. Row pids are runtime data, so they're discovered by the `process-monitor-row-`
 * id prefix (same discovery ConnectionsPage/TerminalsPage use for runtime rows).
 */
class ProcessMonitorPage extends BasePage {
    private readonly ids = {
        screen: "screen-process-monitor",
        loading: "process-monitor-loading",
        error: "process-monitor-error",
        empty: "process-monitor-empty",
        table: "process-monitor-table",
        sortToggle: "process-monitor-sort-toggle",
        sortRss: "process-monitor-sort-rss",
        sortName: "process-monitor-sort-name",
    } as const;

    private readonly rowPrefix = "process-monitor-row-";

    /** Open the screen via the `(more)` deep link, then wait for its `<ScrollView>` root. */
    async open(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard:///process-monitor",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.ids.screen);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    rowId(pid: number | string): string {
        return `${this.rowPrefix}${pid}`;
    }

    killId(pid: number | string): string {
        return `process-monitor-kill-${pid}`;
    }

    /** True when a process row for `pid` exists in the a11y tree (rendered, even if below the fold). */
    async rowExists(pid: number | string): Promise<boolean> {
        return this.byId(this.rowId(pid)).isExisting();
    }

    /** Either at least one process row exists OR the empty state is displayed (structural check). */
    async hasRowsOrEmpty(): Promise<boolean> {
        const pids = await this.rowPids();
        return pids.length > 0 || (await this.byId(this.ids.empty).isExisting());
    }

    /**
     * The pids of all rendered `process-monitor-row-<pid>` rows, in a11y-tree (render) order. The
     * predicate matches both iOS XCUITest `name` and Android UiAutomator2 `content-desc`.
     */
    async rowPids(): Promise<number[]> {
        const rows = await $$(
            `//*[starts-with(@name, "${this.rowPrefix}") or starts-with(@content-desc, "${this.rowPrefix}")]`,
        );
        const pids: number[] = [];

        for (const row of rows) {
            const name = (await row.getAttribute("name")) ?? (await row.getAttribute("content-desc"));
            if (!name) {
                continue;
            }

            const pid = Number.parseInt(name.slice(this.rowPrefix.length), 10);
            if (!Number.isNaN(pid)) {
                pids.push(pid);
            }
        }

        return pids;
    }

    /** The pid of the first rendered row (largest-RSS under the default sort), or null when empty. */
    async firstRowPid(): Promise<number | null> {
        const pids = await this.rowPids();
        return pids[0] ?? null;
    }

    /**
     * The visible text of a row (the a11y subtree text). On the screen each row reads as the process
     * name + `pid <n> · <rss> · <cpu> · <uptime>`, so the spec can prove ordering from the rendered
     * trailing metadata (real state), not from the fixture.
     */
    async rowText(pid: number | string): Promise<string> {
        return this.getText(this.rowId(pid));
    }

    async sortByRss(): Promise<void> {
        await this.tap(this.ids.sortRss);
    }

    async sortByName(): Promise<void> {
        await this.tap(this.ids.sortName);
    }

    /** Which sort segment is active, read off `accessibilityState.selected` on the two segments. */
    async activeSort(): Promise<"rss" | "name" | null> {
        if ((await this.getAttribute(this.ids.sortRss, "selected")) === "true") {
            return "rss";
        }

        if ((await this.getAttribute(this.ids.sortName, "selected")) === "true") {
            return "name";
        }

        return null;
    }

    /** Wait until the first rendered row's pid changes from `previousPid` (a real refetch + reorder). */
    async waitForFirstRowChange(previousPid: number): Promise<void> {
        await this.waitUntil(async () => (await this.firstRowPid()) !== previousPid, {
            message: "expected the first process row to change after toggling the sort",
        });
    }

    /** Tap the per-row Kill button (opens the native confirm Alert). */
    async tapKill(pid: number | string): Promise<void> {
        await this.tap(this.killId(pid));
    }

    /** Accept the native "Kill process?" confirm Alert (the destructive "Kill" button). */
    async confirmKill(): Promise<void> {
        await driver.acceptAlert();
    }

    /** Dismiss the native confirm Alert without killing (the "Cancel" button). */
    async cancelKill(): Promise<void> {
        await driver.dismissAlert();
    }
}

export const processMonitorPage = new ProcessMonitorPage();
