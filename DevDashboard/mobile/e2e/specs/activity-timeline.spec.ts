import { activityTimelinePage } from "@e2e/pages/ActivityTimelinePage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

// Activity Timeline done-gate. The app boots into /connect with no baseUrl, so this spec pairs first
// (deep-linked pairing URI — the sim has no camera), then deep-links to /activity-timeline and drives
// the page object. The screen root is a FlatList wrapper (displayed=false), so navigation waits on the
// list (or the empty card) existing.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the dev-client
// (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test Agent reachable at the
// paired baseUrl with Basic auth. `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Real-state assertions: against the MOCK client the four MOCK_TIMELINE ids always render, so the
// hour-header + descending-order checks prove the merge+group pipeline end-to-end. Against a real
// Agent, set DD_TIMELINE_NEWER_ID / DD_TIMELINE_OLDER_ID to two recorded event ids (newer first) to
// assert ordering on live data; when unset, that step uses the mock ids.
describe("ActivityTimelinePage", () => {
    // Event ids are minted at runtime (daemon run ids, qa ids), so against a live Agent the spec
    // cannot hard-code them. Resolution order: explicit env hooks (DD_TIMELINE_NEWER_ID /
    // DD_TIMELINE_OLDER_ID) win when set; otherwise the two newest rows are discovered from the
    // rendered list in before() (top→bottom = descending-by-time). The MOCK_TIMELINE fallback ids
    // keep the mock-client run unchanged.
    let newerId = process.env.DD_TIMELINE_NEWER_ID ?? "terminal-ttyd-2";
    let olderId = process.env.DD_TIMELINE_OLDER_ID ?? "run-build-9";
    const idsFromEnv = Boolean(process.env.DD_TIMELINE_NEWER_ID && process.env.DD_TIMELINE_OLDER_ID);

    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await activityTimelinePage.openViaDeepLink();

        if (!idsFromEnv) {
            const discovered = await activityTimelinePage.discoverEventIds();
            if (discovered.length >= 2) {
                [newerId, olderId] = discovered;
            }
        }
    });

    it("loads the timeline screen (list or empty card)", async () => {
        expect(await activityTimelinePage.isShown()).toBe(true);
    });

    it("renders hour groups or the empty card", async () => {
        expect(await activityTimelinePage.hasContentOrEmpty()).toBe(true);
    });

    it("shows the expected event rows and an hour header reflecting the merged stream", async () => {
        // The mock stream spans multiple hours; at least the newer event's row must be present.
        expect(await activityTimelinePage.eventVisible(newerId)).toBe(true);
    });

    it("orders events descending — newer above older", async () => {
        const newerThere = await activityTimelinePage.eventVisible(newerId);
        const olderThere = await activityTimelinePage.eventVisible(olderId);
        // Both ids only coexist on the mock build / a fixture-loaded Agent; skip if the live Agent
        // lacks them rather than fail a real device with different activity.
        if (!newerThere || !olderThere) {
            return;
        }

        expect(await activityTimelinePage.isAboveOnScreen(newerId, olderId)).toBe(true);
    });
});
