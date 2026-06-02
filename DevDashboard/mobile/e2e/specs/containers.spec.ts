import { connectPage } from "@e2e/pages/ConnectPage.page";
import { containersPage } from "@e2e/pages/ContainersPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The Containers feature done-gate (plan 09 / the "More" rest features). The app boots into
// /connect whenever no baseUrl is set (root `Stack.Protected guard={baseUrl !== null}`), so this
// spec first pairs (deep-linked pairing URI, same as connect/pulse specs — the sim has no camera),
// which opens the authenticated app, then navigates to /containers via the More menu / deep link
// (`moreNavPage.open`) and drives the screen.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
// dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
// Agent reachable at the paired baseUrl with Basic auth satisfied (see plan-04 note — an empty
// password 401s the probe). `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Content assertions are tolerant of an Agent host with no Docker (→ the docker-unavailable card)
// and of an Agent host with Docker but no containers (→ the empty state). The running/stopped
// section checks only run when Docker is available, so they `this.skip()` on the docker-unavailable
// card — the screen-loads + content/state check still runs everywhere.
//
// Done criterion: the screen loads and resolves to exactly one of — the docker-unavailable card,
// the empty state, a running section, or a stopped section.
describe("ContainersPage", () => {
    before(async () => {
        // Pair so the auth gate opens, then navigate to the containers More screen.
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.open("containers");
    });

    it("loads the containers screen", async () => {
        expect(await containersPage.isShown()).toBe(true);
    });

    it("resolves to docker-unavailable, an empty state, or a running/stopped section", async () => {
        expect(await containersPage.hasContentOrState()).toBe(true);
    });

    // The running/stopped sections only exist when Docker is reachable on the Agent host. When the
    // docker-unavailable card is shown instead, skip so the screen + content-or-state checks above
    // still run everywhere.
    it("shows the running and/or stopped sections when Docker is available", async function () {
        if (await containersPage.isDockerUnavailableShown()) {
            this.skip();
            return;
        }

        expect(await containersPage.hasRunningOrStopped()).toBe(true);
    });
});
