import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Disk Janitor screen. Locates by the rank-indexed testIDs baked into the screen
 * + UsageBars (`~`-by-accessibility-id via BasePage). The rank index is 0-based, largest-first.
 */
class DiskJanitorPage extends BasePage {
    private readonly ids = {
        screen: "screen-disk-janitor",
        loading: "disk-janitor-loading",
        free: "disk-janitor-free",
        bars: "disk-janitor-bars",
        empty: "disk-janitor-empty",
        error: "disk-janitor-error",
    } as const;

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.screen);
        return this.isVisible(this.ids.screen);
    }

    /**
     * Wait out the `disk-janitor-loading` spinner before asserting content. A real Agent's
     * `GET /api/disk/usage` shells `du -sk` over the dev-dir + ~/Library/Caches allowlist, which on a
     * large host legitimately takes ~30–40 s (measured) — far past the 10 s default. The screen gates
     * ALL content (header tile + bars) behind `query.isPending`, so the header/bars only mount once the
     * scan returns. This waits for the scan to finish (not for any specific value), so the per-test
     * content assertions then read a settled screen instead of timing out mid-scan. No assertion is
     * relaxed; the slow op is just given the time it actually needs.
     */
    async waitForLoaded(timeout = 90_000): Promise<void> {
        await this.waitForVisible(this.ids.screen);
        if (await this.isExisting(this.ids.loading)) {
            await this.byId(this.ids.loading).waitForExist({ timeout, reverse: true });
        }
    }

    /** The Pulse disk-free header StatTile value (e.g. "212.0 GB"). */
    async diskFreeText(): Promise<string> {
        return this.getText(`${this.ids.free}-value`);
    }

    /** One of: the bars list, or the empty card. */
    async hasBarsOrEmpty(): Promise<boolean> {
        for (const id of [this.ids.bars, this.ids.empty]) {
            if (await this.isExisting(id)) {
                return true;
            }
        }

        return false;
    }

    async isEmptyShown(): Promise<boolean> {
        return this.isExisting(this.ids.empty);
    }

    rowId(rank: number): string {
        return `disk-janitor-row-${rank}`;
    }

    sizeId(rank: number): string {
        return `disk-janitor-size-${rank}`;
    }

    barId(rank: number): string {
        return `disk-janitor-bar-${rank}`;
    }

    /** Count consecutive rank rows present (0,1,2,…) until the first gap. */
    async rowCount(max = 10): Promise<number> {
        let n = 0;
        for (let i = 0; i < max; i++) {
            if (await this.isExisting(this.rowId(i))) {
                n++;
            } else {
                break;
            }
        }

        return n;
    }

    /** Read the size text for a rank (e.g. "2.2 GB"). */
    async sizeText(rank: number): Promise<string> {
        return this.getText(this.sizeId(rank));
    }

    /** Read the bar fill's pct from its accessibilityValue text ("100", "50", …). */
    async barPct(rank: number): Promise<number> {
        const value = await this.getAttribute(this.barId(rank), "value");
        return Number.parseInt(value ?? "0", 10);
    }
}

export const diskJanitorPage = new DiskJanitorPage();
