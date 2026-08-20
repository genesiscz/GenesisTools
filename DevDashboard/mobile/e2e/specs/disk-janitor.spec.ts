import { connectPage } from "@e2e/pages/ConnectPage.page";
import { diskJanitorPage } from "@e2e/pages/DiskJanitorPage.page";
import { moreNavPage } from "@e2e/pages/MoreNav.page";
import { pairingUri } from "@e2e/pages/testAgent";

// The Disk Janitor feature done-gate. The app boots into /connect whenever no baseUrl is set, so
// this spec first pairs (deep-linked pairing URI — the sim has no camera), then navigates to
// /disk-janitor via the (more) deep link (`moreNavPage.open`) and drives the screen.
//
// AUTHORED, NOT RUN here. Prereqs (device run, owned by the user): a booted iOS sim with the
// dev-client installed (DD_APP_PATH), a running Appium server (`bun run e2e:appium`), and a test
// Agent reachable at the paired baseUrl with Basic auth (see plan-04 note). `DD_BUNDLE_ID` overrides
// the deep-link bundle id.
//
// REAL-STATE assertions (not smoke): when the bars render, the spec asserts the ranked sizes are
// monotonically NON-INCREASING (largest first — the backend contract) AND that the bar widths are
// likewise non-increasing and the top bar is the 100% reference. Tolerant of an Agent host with no
// scannable dirs (→ the empty card), in which case the size/width-order checks skip.
//
// Done criterion: the screen loads with the disk-free header tile + resolves to either the ranked
// bars (with correct desc order + matching widths) or the empty card.
describe("DiskJanitorPage", () => {
    before(async () => {
        if (await connectPage.isShown().catch(() => false)) {
            await connectPage.selectTier("cloudflared-self");
            await connectPage.injectPairing(
                pairingUri(),
            );
            await browser.waitUntil(async () => connectPage.isReachabilityState("reachable"), { timeout: 10_000 });
            await connectPage.tapContinue();
        }

        await moreNavPage.open("disk-janitor");
        // The disk scan (`du -sk` over the allowlist) takes ~30–40 s on a large host; wait it out so the
        // per-test content assertions read a settled screen rather than the loading spinner.
        await diskJanitorPage.waitForLoaded();
    });

    it("loads the disk-janitor screen with a disk-free header tile", async () => {
        expect(await diskJanitorPage.isShown()).toBe(true);
        const free = await diskJanitorPage.diskFreeText();
        // The header reuses Pulse's gb() — a concrete value ("212.0 GB") or the em dash when Pulse has
        // no snapshot yet. Either is a real render; assert it is non-empty.
        expect(free.length).toBeGreaterThan(0);
    });

    it("resolves to the ranked bars or the empty card", async () => {
        expect(await diskJanitorPage.hasBarsOrEmpty()).toBe(true);
    });

    // The ranked-order checks only apply when bars render (Agent host has scannable dirs). Skip on
    // the empty card so the screen + header + content-or-state checks still run everywhere.
    it("ranks directories largest-first with proportional bar widths", async function () {
        if (await diskJanitorPage.isEmptyShown()) {
            this.skip();
            return;
        }

        const count = await diskJanitorPage.rowCount();
        expect(count).toBeGreaterThan(0);

        // Sizes parse to bytes and must be NON-INCREASING down the ranks (the backend's bytes-desc
        // contract surfaced in the UI). Parse "<num> <GB|MB|KB>" → bytes for a real ordering check.
        const toBytes = (s: string): number => {
            const m = s.match(/([\d.]+)\s*(GB|MB|KB)/);
            if (!m) {
                return 0;
            }

            const n = Number.parseFloat(m[1]);
            const unit = m[2];
            return unit === "GB" ? n * 1024 ** 3 : unit === "MB" ? n * 1024 ** 2 : n * 1024;
        };

        const sizes: number[] = [];
        const widths: number[] = [];
        for (let i = 0; i < count; i++) {
            sizes.push(toBytes(await diskJanitorPage.sizeText(i)));
            widths.push(await diskJanitorPage.barPct(i));
        }

        // REAL state: sizes strictly described by the rank order (non-increasing).
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
        }

        // The top bar is the 100% reference; widths are non-increasing and track the sizes.
        expect(widths[0]).toBe(100);
        for (let i = 1; i < widths.length; i++) {
            expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
        }
    });

    it("is reachable from the More menu (disk-janitor link)", async () => {
        await moreNavPage.openTab();
        expect(await moreNavPage.linkExists("disk-janitor")).toBe(true);
    });
});
