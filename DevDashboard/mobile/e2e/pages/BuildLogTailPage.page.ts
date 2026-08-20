import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Build Log Tail screen. Locates by the `build-log-tail-*` testIDs. Mirrors
 * DaemonPage: deep-link in, gate on a displayed child (the screen root wraps a flex view; the stream
 * container is the reliable "shown" signal).
 */
class BuildLogTailPage extends BasePage {
    private readonly ids = {
        screen: "screen-build-log-tail",
        loading: "build-log-tail-loading",
        runPicker: "build-log-tail-run-picker",
        runEmpty: "build-log-tail-run-empty",
        stream: "build-log-tail-stream",
        list: "build-log-tail-list",
        livePill: "build-log-tail-live-pill",
        empty: "build-log-tail-empty",
        jumpError: "build-log-tail-jump-error",
        autoscrollToggle: "build-log-tail-autoscroll-toggle",
    } as const;

    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://build-log-tail",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.stream);
    }

    async isShown(): Promise<boolean> {
        await this.waitForExist(this.ids.screen);
        await this.waitForVisible(this.ids.stream);
        return this.isVisible(this.ids.stream);
    }

    runRowId(runId: string): string {
        return `build-log-tail-run-${runId}`;
    }

    async selectRun(runId: string): Promise<void> {
        await this.tap(this.runRowId(runId));
    }

    async hasRunsOrEmpty(): Promise<boolean> {
        return (
            (await this.byId(this.ids.runPicker).isExisting()) || (await this.byId(this.ids.runEmpty).isExisting())
        );
    }

    lineId(n: number): string {
        return `build-log-tail-line-${n}`;
    }

    errorMarkerId(n: number): string {
        return `build-log-tail-error-${n}`;
    }

    /** Wait until at least the line at index `n` has streamed in (proves live arrival, not smoke). */
    async waitForLine(n: number): Promise<void> {
        await this.waitForExist(this.lineId(n));
    }

    /** Wait until SOME error-marked row exists, returning its index (scans the first `max`). */
    async firstErrorIndex(max = 50): Promise<number> {
        for (let i = 0; i < max; i++) {
            if (await this.byId(this.errorMarkerId(i)).isExisting()) {
                return i;
            }
        }

        return -1;
    }

    async livePillLabel(): Promise<string> {
        return this.getText(this.ids.livePill);
    }

    async tapJumpToError(): Promise<void> {
        await this.tap(this.ids.jumpError);
    }

    async toggleAutoScroll(): Promise<void> {
        await this.tap(this.ids.autoscrollToggle);
    }

    /** True when the row at `index` is currently DISPLAYED in the viewport (real state). */
    async isErrorRowVisible(index: number): Promise<boolean> {
        return this.isVisible(this.lineId(index));
    }
}

export const buildLogTailPage = new BuildLogTailPage();
