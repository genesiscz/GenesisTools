import { claudeUsagePage } from "@e2e/pages/ClaudeUsagePage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { containersPage } from "@e2e/pages/ContainersPage.page";
import { daemonPage } from "@e2e/pages/DaemonPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { weatherPage } from "@e2e/pages/WeatherPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * Combined smoke for the deferred "More" features (plan 09: claude-usage / daemon / containers /
 * weather). Like pulse.spec, the app boots into /connect whenever no baseUrl is set
 * (root `Stack.Protected guard={baseUrl !== null}`), so this spec first pairs (deep-linked pairing
 * URI — the sim has no camera), which opens the authenticated app, then navigates to each `(more)`
 * route via deep link (`moreNavPage.open`) and asserts the screen + its primary content/state.
 *
 * Prereqs (device run, owned by the user): a booted iOS sim with the dev-client installed
 * (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test Agent reachable at the
 * paired baseUrl with Basic auth satisfied (see plan-04 note — an empty password 401s the probe).
 * `DD_BUNDLE_ID` overrides the deep-link bundle id.
 *
 * NB: navigation here is by deep link so the spec does not depend on the orchestrator's More-tab /
 * menu wiring (a consolidation TODO — see DevDashboard/research/20-impl-09-rest-notes.md). Content
 * assertions are tolerant of an empty test agent (e.g. no Docker, no daemon runs, no usage history):
 * each screen has an explicit empty/unavailable state these assertions accept.
 */
describe("Remaining features smoke (claude-usage / daemon / containers / weather)", () => {
    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }
    });

    describe("Claude usage", () => {
        before(async () => moreNavPage.open("claude-usage"));

        it("loads the claude-usage screen", async () => {
            expect(await claudeUsagePage.isShown()).toBe(true);
        });

        it("shows account cards or the no-accounts empty state", async () => {
            expect(await claudeUsagePage.hasAccountsOrEmpty()).toBe(true);
        });

        it("keeps the screen mounted when switching the history range", async () => {
            // Only meaningful when accounts exist (the range selector is then present).
            if (await browser.$("~claude-range-selector").isExisting()) {
                await claudeUsagePage.selectRange1h();
                await browser.pause(400);
                await claudeUsagePage.selectRange7d();
            }

            expect(await claudeUsagePage.isShown()).toBe(true);
        });
    });

    describe("Daemon", () => {
        // `moreNavPage.open("daemon")` waits on `screen-daemon` being displayed, but that root is a
        // FlatList wrapper that reports `displayed=false` (its content paints, the wrapper does not).
        // `daemonPage.openViaDeepLink()` deep-links the route and gates on the displayed status header
        // instead — the correct "screen is up" signal for this FlatList-rooted screen.
        before(async () => daemonPage.openViaDeepLink());

        it("loads the daemon screen with a status header", async () => {
            expect(await daemonPage.isShown()).toBe(true);
            expect(await daemonPage.statusHeaderVisible()).toBe(true);
        });

        it("shows a status pill with a known label", async () => {
            const label = await daemonPage.statusPillLabel();
            expect(["Running", "Stopped", "Not installed"]).toContain(label);
        });

        it("shows recent runs or the no-runs empty card", async () => {
            expect(await daemonPage.hasRunsOrEmpty()).toBe(true);
        });
    });

    describe("Containers", () => {
        before(async () => moreNavPage.open("containers"));

        it("loads the containers screen", async () => {
            expect(await containersPage.isShown()).toBe(true);
        });

        it("shows running/stopped sections, an empty state, or the docker-unavailable card", async () => {
            expect(await containersPage.hasContentOrState()).toBe(true);
        });
    });

    describe("Weather", () => {
        before(async () => moreNavPage.open("weather"));

        it("loads the weather screen with the card", async () => {
            expect(await weatherPage.isShown()).toBe(true);
            expect(await weatherPage.cardVisible()).toBe(true);
        });

        it("shows a temperature reading or the unavailable state", async () => {
            expect(await weatherPage.hasTempOrError()).toBe(true);
        });
    });
});
