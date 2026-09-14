import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Pulse home tab (D32 reference feature). Locates by the `testID`s baked into
 * the Pulse screen + its components (accessibility-id via the `~` selector in BasePage). The Skia
 * chart canvas is opaque to the a11y tree, so "chart renders" = the chart CONTAINER testID is
 * displayed; "values update" = read a KPI's text twice with a wait between. Mirrors the
 * `ConnectPage` harness convention (extends BasePage, singleton export).
 *
 * STABILITY: a reference page object feature agents copy the style from — extend, never
 * rename/re-signature the existing public methods.
 */
class PulsePage extends BasePage {
    private readonly ids = {
        screen: "screen-pulse",
        loading: "pulse-loading",
        liveDot: "pulse-live-dot",
        kpiGrid: "pulse-kpi-grid",
        kpiCpuValue: "kpi-cpu-value",
        kpiDisk: "kpi-disk",
        kpiWifi: "kpi-wifi",
        chartCpu: "chart-cpu",
        chartMem: "chart-mem",
        sparklineRow: "pulse-sparkline-row",
        processTable: "pulse-process-table",
        networkCard: "pulse-network-card",
        weatherCard: "pulse-weather-card",
        rangeSelector: "pulse-range-selector",
        range2h: "pulse-range-120",
        mockBadge: "mock-data-badge",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    /**
     * Both chart CONTAINERS render. The Skia canvas is below the scroll fold (verified
     * `exists=true`/`displayed=false`), so presence is asserted scroll-independently with
     * `isExisting` rather than `isVisible`.
     */
    async chartsVisible(): Promise<boolean> {
        return (await this.isExisting(this.ids.chartCpu)) && (await this.isExisting(this.ids.chartMem));
    }

    /**
     * Every card renders. The KPI grid sits at the top of the scroll view, but the sparkline /
     * process / network / weather cards are below the fold (verified `exists=true`/`displayed=false`),
     * so card presence is asserted with `isExisting` (scroll-independent) — they DO render.
     */
    async allCardsVisible(): Promise<boolean> {
        for (const id of [
            this.ids.kpiGrid,
            this.ids.kpiDisk,
            this.ids.kpiWifi,
            this.ids.sparklineRow,
            this.ids.processTable,
            this.ids.networkCard,
            this.ids.weatherCard,
        ]) {
            if (!(await this.isExisting(id))) {
                return false;
            }
        }

        return true;
    }

    async cpuValue(): Promise<string> {
        return this.getText(this.ids.kpiCpuValue);
    }

    async isMockBadgeShown(): Promise<boolean> {
        return this.isExisting(this.ids.mockBadge);
    }

    async selectRange2h(): Promise<void> {
        await this.tap(this.ids.range2h);
    }

    /** Wait out the initial loading spinner (if shown) until the screen body is up. */
    async waitForLoaded(timeout = this.defaultTimeout): Promise<void> {
        await this.waitForVisible(this.ids.screen, timeout);
        if (await this.isExisting(this.ids.loading)) {
            await this.waitForGone(this.ids.loading, timeout);
        }
    }

    /**
     * Read the CPU KPI twice across one poll cycle; true if it changed OR both reads are real
     * (not the `—` placeholder) — i.e. the live poll is feeding the screen. The done-criterion
     * for "values update".
     */
    async cpuReadingIsLive(pollMs = 6000): Promise<boolean> {
        const first = await this.cpuValue();
        await browser.pause(pollMs);
        const second = await this.cpuValue();
        return first !== second || (first !== "—" && second !== "—");
    }
}

export const pulsePage = new PulsePage();
