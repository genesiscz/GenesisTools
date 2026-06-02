import { connectPage } from "@e2e/pages/ConnectPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { weatherPage } from "@e2e/pages/WeatherPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The Weather feature done-gate (plan 09 / the "More" rest features). The app boots into /connect
// whenever no baseUrl is set (root `Stack.Protected guard={baseUrl !== null}`), so this spec first
// pairs (deep-linked pairing URI, same as connect/pulse specs — the sim has no camera), which opens
// the authenticated app, then navigates to /weather via the More menu / deep link
// (`moreNavPage.open`) and drives the screen.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
// dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
// Agent reachable at the paired baseUrl with Basic auth satisfied (see plan-04 note — an empty
// password 401s the probe). `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Content assertions are tolerant of an Agent that can't reach the weather provider (→ the
// "Unavailable" error state instead of a temperature reading), so the temp-vs-error check accepts
// either. The location label only renders alongside a successful reading, so that step `this.skip()`s
// on the error state — the screen + card + temp/error checks still run everywhere.
//
// Done criterion: the screen loads, the weather card renders, and it shows either a temperature
// reading (with a location label) or the unavailable error state.
describe("WeatherPage", () => {
    before(async () => {
        // Pair so the auth gate opens, then navigate to the weather More screen.
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.open("weather");
    });

    it("loads the weather screen with the card", async () => {
        expect(await weatherPage.isShown()).toBe(true);
        expect(await weatherPage.cardVisible()).toBe(true);
    });

    it("shows a temperature reading or the unavailable state", async () => {
        expect(await weatherPage.hasTempOrError()).toBe(true);
    });

    // The location label only renders alongside a successful temperature reading. When the card is in
    // its unavailable/error state, skip so the screen + card + temp/error checks above still run.
    it("shows a location label when a reading is available", async function () {
        if (!(await weatherPage.hasTemp())) {
            this.skip();
            return;
        }

        expect(await weatherPage.hasLabel()).toBe(true);
    });
});
