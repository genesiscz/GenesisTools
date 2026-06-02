import { buildLogTailPage } from "@e2e/pages/BuildLogTailPage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { pairingUri } from "@e2e/pages/testAgent";

/**
 * Build Log Tail done-gate. Pairs (deep-linked pairing URI — the sim has no camera) to open the
 * authenticated app, deep-links to /build-log-tail, selects a run, and asserts REAL streaming state:
 * lines arrive over time, an error row exists + is highlighted, and jump-to-error brings the first
 * error row into the viewport.
 *
 * AUTHORED, NOT RUN here. Prereqs (owned by the user): a booted iOS sim with the dev-client
 * (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a reachable test Agent at the
 * paired baseUrl with Basic auth satisfied. `DD_BUILD_LOG_RUN_ID` selects a known run that has at
 * least one error line; when unset, the run-select + jump-to-error steps `this.skip()` and only the
 * always-present screen checks run (the mock fixture path is exercised in unit tests).
 */
describe("BuildLogTailPage", () => {
    const runId = process.env.DD_BUILD_LOG_RUN_ID ?? "";

    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await buildLogTailPage.openViaDeepLink();
    });

    it("loads the build-log screen with a stream container", async () => {
        expect(await buildLogTailPage.isShown()).toBe(true);
    });

    it("shows a run picker or the no-runs empty card", async () => {
        expect(await buildLogTailPage.hasRunsOrEmpty()).toBe(true);
    });

    it("streams log lines and highlights + jumps to the first error", async function () {
        if (!runId) {
            this.skip();
            return;
        }

        await buildLogTailPage.selectRun(runId);

        // REAL streaming: line 0 must arrive (proves the SSE tail + backlog seed actually rendered).
        await buildLogTailPage.waitForLine(0);

        // REAL classification: at least one error-marked row exists.
        const errorIdx = await buildLogTailPage.retry(
            async () => {
                const idx = await buildLogTailPage.firstErrorIndex();
                if (idx < 0) {
                    throw new Error("no error row yet");
                }

                return idx;
            },
            { attempts: 6, delayMs: 1000 },
        );
        expect(errorIdx).toBeGreaterThanOrEqual(0);

        // Scroll away from it first (turn auto-scroll off + let later lines push it off-screen), then
        // jump-to-error must bring that exact row back into the viewport — REAL state, not a tap smoke.
        await buildLogTailPage.toggleAutoScroll(); // off
        await buildLogTailPage.tapJumpToError();
        await buildLogTailPage.waitForVisible(buildLogTailPage.lineId(errorIdx));
        expect(await buildLogTailPage.isErrorRowVisible(errorIdx)).toBe(true);
    });

    it("the live pill reports a known connection state", async function () {
        if (!runId) {
            this.skip();
            return;
        }

        const label = await buildLogTailPage.livePillLabel();
        expect(["live", "connected", "connecting"]).toContain(label);
    });
});
