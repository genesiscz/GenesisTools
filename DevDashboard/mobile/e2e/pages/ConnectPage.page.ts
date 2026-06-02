import { BasePage } from "@e2e/pages/base.page";
import { TEST_AGENT_BASE_URL } from "@e2e/pages/testAgent";

type Tier = "lan" | "tailscale" | "cloudflared-self" | "managed";

/** A reachability badge state, as exposed by `ReachabilityBadge` (`reachability-<kind>`). */
type ReachKind = "idle" | "probing" | "reachable" | "unreachable" | "needs-vpn" | "needs-pair";

/** A test agent reachable at this baseUrl with auth satisfied is the connect-gate prerequisite. */
const DEFAULT_TEST_AGENT = TEST_AGENT_BASE_URL;

/**
 * Page Object for the Connect / Pair screen (plan 02 transport done-gate). Locates by the
 * `accessibilityLabel`s set in `src/app/connect.tsx` + its connect components, following the
 * harness convention (accessibility-id via the `~` selector in BasePage).
 *
 * STABILITY: feature specs (terminals/qa/obsidian/rest) drive this to get past the connect
 * gate before reaching their tab (see `pulse.spec.ts` `before`). The methods below are the
 * frozen surface those agents depend on — extend, never rename/re-signature.
 */
class ConnectPage extends BasePage {
    async isShown(): Promise<boolean> {
        // Once paired, boot-restore reopens the gate and the connect screen is never mounted — so a
        // missing element is the EXPECTED "already connected" signal, not a failure. Poll briefly and
        // report presence as a boolean; `waitForVisible` would throw here and kill the spec's
        // before() hook (it is the gate-clear guard `if (await connectPage.isShown())`).
        try {
            return await this.byId("connect-screen").waitForDisplayed({ timeout: 3000 });
        } catch {
            return false;
        }
    }

    async selectTier(tier: Tier): Promise<void> {
        await this.tap(`tier-option-${tier}`);
    }

    async reachabilityLabel(): Promise<string> {
        return this.getText("reachability-badge");
    }

    async isReachabilityState(kind: ReachKind | string): Promise<boolean> {
        return this.isExisting(`reachability-${kind}`);
    }

    /** Poll until the badge shows `reachable` (the gate the Continue button waits on). */
    async waitUntilReachable(timeout = 10_000): Promise<void> {
        await this.waitUntil(() => this.isReachabilityState("reachable"), {
            timeout,
            message: "reachability never reached `reachable`",
        });
    }

    async tapOpenTailscale(): Promise<void> {
        await this.tap("open-tailscale");
    }

    async tapTailscaleProbe(): Promise<void> {
        await this.tap("tailscale-probe");
    }

    async isPairPanelShown(): Promise<boolean> {
        return this.isExisting("pair-panel");
    }

    async isLanListShown(): Promise<boolean> {
        return this.isExisting("lan-agent-list");
    }

    /** Fill the LAN form (host + optional creds) and submit. The LAN tier must be selected first. */
    async connectLan({ host, username, password }: { host: string; username?: string; password?: string }): Promise<void> {
        await this.type("lan-host", host);
        if (username != null) {
            await this.type("lan-username", username);
        }

        if (password != null) {
            await this.type("lan-password", password);
        }

        await this.tap("lan-connect");
    }

    /** Simulate a scanned pairing QR by deep-linking the pairing URI into the app (sim has no camera). */
    async injectPairing(uri: string): Promise<void> {
        await browser.execute("mobile: deepLink", {
            url: uri,
            bundleId: process.env.DD_BUNDLE_ID ?? "dev.foltyn.dev-dashboard",
        });
    }

    async tapContinue(): Promise<void> {
        await this.tap("connect-continue");
    }

    /**
     * One-shot: get from a fresh `/connect` screen to a paired+reachable state and tap Continue,
     * using a deep-linked pairing URI against the local test agent. This is the canonical way for
     * a feature spec's `before()` to clear the connect gate before driving its own tab — copy this
     * call rather than re-deriving the deep-link string.
     */
    async pairWithTestAgent({ baseUrl = DEFAULT_TEST_AGENT, username = "martin", tier = "cloudflared-self" }: { baseUrl?: string; username?: string; tier?: Tier } = {}): Promise<void> {
        await this.selectTier(tier);
        const uri = `devdashboard://pair?tier=${tier}&baseUrl=${encodeURIComponent(baseUrl)}&username=${encodeURIComponent(username)}`;
        await this.injectPairing(uri);
        await this.waitUntilReachable();
        await this.tapContinue();
    }
}

export const connectPage = new ConnectPage();
