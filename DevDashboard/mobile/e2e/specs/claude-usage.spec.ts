import { claudeUsagePage } from "@e2e/pages/ClaudeUsagePage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The Claude-usage feature done-gate (plan 09 / the "More" rest features). The app boots into
// /connect whenever no baseUrl is set (root `Stack.Protected guard={baseUrl !== null}`), so this
// spec first pairs (deep-linked pairing URI, same as connect/pulse specs — the sim has no camera),
// which opens the authenticated app, then navigates to /claude-usage via the More menu / deep link
// (`moreNavPage.open`) and drives the screen.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
// dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
// Agent reachable at the paired baseUrl with Basic auth satisfied (see plan-04 note — an empty
// password 401s the probe). `DD_BUNDLE_ID` overrides the deep-link bundle id.
//
// Content assertions are tolerant of an empty test agent (no usage history → the "no accounts"
// empty state). The usage cards + victory-native chart + the 1h/24h/7d range toggle only exist when
// at least one account has data, so those steps `this.skip()` when the range selector is absent —
// the screen-loads + empty-state checks still run everywhere.
//
// Done criterion: the screen loads, usage cards + their chart containers render (victory-native
// canvas is opaque, so "chart renders" = the chart CONTAINER testID is displayed), and toggling the
// history range (1h / 24h / 7d) keeps the screen mounted.
//
// The card + chart locators are per-account (`claude-account-<name>` / `claude-chart-<name>-<bucket>`)
// — agent-specific data, like the daemon runId / QA recordedId. Supply a known account via
// DD_CLAUDE_ACCOUNT (and optionally DD_CLAUDE_BUCKET, default "cost") to assert the card + chart
// render; the step `this.skip()`s when DD_CLAUDE_ACCOUNT is unset.
describe("ClaudeUsagePage", () => {
    // A claude account name present on the test Agent. When unset, the card/chart assertion is
    // skipped (the screen + empty-state + range-toggle checks still run).
    const accountName = process.env.DD_CLAUDE_ACCOUNT ?? "";
    const bucket = process.env.DD_CLAUDE_BUCKET ?? "cost";

    before(async () => {
        // Pair so the auth gate opens, then navigate to the claude-usage More screen.
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.open("claude-usage");
    });

    it("loads the claude-usage screen", async () => {
        expect(await claudeUsagePage.isShown()).toBe(true);
    });

    it("shows account/usage cards or the no-accounts empty state", async () => {
        expect(await claudeUsagePage.hasAccountsOrEmpty()).toBe(true);
    });

    // The usage card + its chart container only render once an account has data, and the locators are
    // per-account — so this needs a known account name from the test Agent (DD_CLAUDE_ACCOUNT). Skip
    // when unset, or when the agent returned no usage data at all (the empty state).
    it("renders the account usage card and its chart container", async function () {
        if (!accountName || !(await claudeUsagePage.hasUsageData())) {
            this.skip();
            return;
        }

        expect(await claudeUsagePage.accountCardVisible(accountName)).toBe(true);
        expect(await claudeUsagePage.chartVisible(accountName, bucket)).toBe(true);
    });

    it("toggles the history range (1h / 24h / 7d) and keeps the screen mounted", async function () {
        if (!(await claudeUsagePage.hasUsageData())) {
            this.skip();
            return;
        }

        // The range labels come from the screen's RANGES array; tap each only if its segment rendered,
        // so a config that omits a label (e.g. 24h) doesn't hard-fail this mounted-survives check.
        const { range1h, range24h, range7d } = claudeUsagePage.rangeIds;
        if (await claudeUsagePage.rangeExists(range1h)) {
            await claudeUsagePage.selectRange1h();
            await browser.pause(400);
        }

        if (await claudeUsagePage.rangeExists(range24h)) {
            await claudeUsagePage.selectRange24h();
            await browser.pause(400);
        }

        if (await claudeUsagePage.rangeExists(range7d)) {
            await claudeUsagePage.selectRange7d();
            await browser.pause(400);
        }

        expect(await claudeUsagePage.isShown()).toBe(true);
    });
});
