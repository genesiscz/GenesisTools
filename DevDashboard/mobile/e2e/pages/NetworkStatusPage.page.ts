import { BasePage } from "@e2e/pages/base.page";

/**
 * Page Object for the Network & Transport Status screen. Locates by the `network-status-*` testIDs.
 * The screen root is a scrolling `Screen` (not a FlatList), so — unlike Daemon — the root itself is
 * displayed and can be gated on directly.
 */
class NetworkStatusPage extends BasePage {
    private readonly ids = {
        screen: "screen-network-status",
        card: "network-status-card",
        pill: "network-status-pill",
        transport: "network-status-transport",
        latency: "network-status-latency",
        ssid: "network-status-ssid",
        publicIp: "network-status-public-ip",
        repair: "network-status-repair-button",
    } as const;

    async openViaDeepLink(): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: "devdashboard://network-status",
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
        await this.waitForVisible(this.ids.screen);
        await this.waitForVisible(this.ids.card);
    }

    async isShown(): Promise<boolean> {
        await this.waitForVisible(this.ids.card);
        return this.isVisible(this.ids.card);
    }

    /** The quality pill's text — one of "Healthy" / "Degraded" / "Down". */
    async qualityLabel(): Promise<string> {
        return this.getText(this.ids.pill);
    }

    /** The latency KeyValueRow exposes its a11y label "Latency: <value>"; read it for the value. */
    async latencyLabel(): Promise<string | null> {
        return this.getAttribute(this.ids.latency, "label");
    }

    async transportLabel(): Promise<string | null> {
        return this.getAttribute(this.ids.transport, "label");
    }

    async ssidLabel(): Promise<string | null> {
        return this.getAttribute(this.ids.ssid, "label");
    }

    async tapRepair(): Promise<void> {
        await this.scrollAndTap(this.ids.repair);
    }
}

export const networkStatusPage = new NetworkStatusPage();
