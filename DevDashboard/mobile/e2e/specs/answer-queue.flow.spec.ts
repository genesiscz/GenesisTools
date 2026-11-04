import { agentGet } from "@e2e/pages/agentApi";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { needsInputInboxPage } from "@e2e/pages/NeedsInputInboxPage.page";

interface WaitingQueue {
    total: number;
    sessions: unknown[];
}

/**
 * The answer queue at the head of the needs-input inbox: its count pill equals the server's waiting total (the notch
 * widget's number), and an empty queue says so instead of showing a zero over nothing. Nothing is staged or sent.
 */
describe("Answer queue flow", () => {
    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.pairWithTestAgent();
        }

        await needsInputInboxPage.openViaDeepLink();
        await $("~answer-queue").waitForExist({ timeout: 20_000 });
    });

    it("the count pill equals the server's waiting total", async () => {
        let shown = Number.NaN;
        let served = Number.NaN;
        // Sessions start and finish while the test runs, so the two reads must agree at one moment.
        await browser.waitUntil(
            async () => {
                served = (await agentGet<WaitingQueue>("/api/qa/waiting")).total;
                shown = await needsInputInboxPage.queueCount();
                return shown === served;
            },
            { timeout: 30_000, interval: 2_000, timeoutMsg: `the pill showed ${shown}, the server ${served}` }
        );
        expect(shown).toBe(served);
    });

    it("an empty queue shows its empty line, a full one does not", async () => {
        const total = (await agentGet<WaitingQueue>("/api/qa/waiting")).total;

        if (total === 0) {
            await $("~answer-queue-empty").waitForExist({ timeout: 10_000 });
        } else {
            expect(await $("~answer-queue-empty").isExisting()).toBe(false);
        }

        expect(await $("~answer-queue-error").isExisting()).toBe(false);
    });
});
