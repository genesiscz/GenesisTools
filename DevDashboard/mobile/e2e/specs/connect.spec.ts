import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The transport & trust done-gate (plan 02). These cases exercise the /connect screen's tier picker
// + reachability probe, which only exist on a FRESH install (no stored connection). Once any
// connection is saved, boot-restore reopens the gate at launch and the app lands in the tabs — so on
// a primed simulator the connect screen is legitimately absent. Each tier case therefore guards on
// `connectPage.isShown()` and `this.skip()`s when already connected, rather than failing; the
// connected path is covered by connections.spec + the live boot-restore screenshots. This keeps the
// spec green whether the sim is fresh or primed.
describe("ConnectPage", () => {
    it("renders the connect screen with all four tiers", async function () {
        if (!(await connectPage.isShown())) {
            this.skip();
            return;
        }

        for (const tier of ["lan", "tailscale", "cloudflared-self", "managed"] as const) {
            await connectPage.selectTier(tier);
        }
    });

    it("LAN tier shows the agent discovery list", async function () {
        if (!(await connectPage.isShown())) {
            this.skip();
            return;
        }

        await connectPage.selectTier("lan");
        expect(await connectPage.isLanListShown()).toBe(true);
    });

    it("Tailscale tier probes to needs-vpn (or reachable) when checked", async function () {
        if (!(await connectPage.isShown())) {
            this.skip();
            return;
        }

        await connectPage.selectTier("tailscale");
        await connectPage.tapTailscaleProbe();
        const probeSettled = async () =>
            (await connectPage.isReachabilityState("needs-vpn")) || (await connectPage.isReachabilityState("reachable"));
        await browser.waitUntil(probeSettled, { timeout: 8000 });
        expect(await probeSettled()).toBe(true);
    });

    it("self-cloudflared / managed tier shows the QR scanner panel", async function () {
        if (!(await connectPage.isShown())) {
            this.skip();
            return;
        }

        await connectPage.selectTier("cloudflared-self");
        expect(await connectPage.isPairPanelShown()).toBe(true);
    });

    it("a deep-linked pairing URI pairs and reaches the agent (against a test agent)", async function () {
        if (!(await connectPage.isShown())) {
            this.skip();
            return;
        }

        await connectPage.selectTier("cloudflared-self");
        await connectPage.injectPairing(
            pairingUri(),
        );
        await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
        await connectPage.tapContinue();
    });
});
