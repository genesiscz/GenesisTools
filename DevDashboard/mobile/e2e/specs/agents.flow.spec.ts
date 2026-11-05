import { agentGet } from "@e2e/pages/agentApi";
import { agentSessionPage } from "@e2e/pages/AgentSessionPage.page";
import { agentsPage } from "@e2e/pages/AgentsPage.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";

interface Board {
    sessions: Array<{ key: string; label: string; pid: number | null }>;
}

/**
 * The Agents screen and one session's view against the live board: every card on screen is a session the server
 * lists, an empty board says so, a card opens the session with its phase badge and a transcript (or the reason there
 * is none), and Stop asks first. The spec always answers the confirmation with Cancel: it never ends a session.
 */
describe("Agents flow", () => {
    let state: Awaited<ReturnType<typeof agentsPage.loadedState>>;

    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.pairWithTestAgent();
        }

        await agentsPage.open();
        state = await agentsPage.loadedState();
    });

    it("the board loads without an error", () => {
        expect(state).not.toBe("error");
    });

    it("every card is a session the server lists", async () => {
        const board = await agentGet<Board>("/api/gateway/board");
        const served = new Set(board.sessions.map((session) => session.key));

        if (board.sessions.length === 0) {
            await $("~agents-empty").waitForExist({ timeout: 20_000 });
            return;
        }

        let shown: string[] = [];
        await browser.waitUntil(
            async () => {
                shown = await agentsPage.sessionKeys();
                return shown.length > 0;
            },
            { timeout: 20_000, timeoutMsg: "the server lists sessions but no card showed" }
        );
        // A session can end between the two reads; one the server never listed is a real defect.
        const fresh = new Set((await agentGet<Board>("/api/gateway/board")).sessions.map((session) => session.key));
        const unknown = shown.filter((key) => !served.has(key) && !fresh.has(key));
        expect(unknown).toEqual([]);
    });

    it("a card opens the session view with its phase and transcript", async function () {
        const [key] = await agentsPage.sessionKeys();

        if (!key) {
            this.skip();
        }

        await agentsPage.openSession(key);
        const transcript = await agentSessionPage.transcriptState();
        expect(transcript).not.toBe("error");

        if (transcript === "gone") {
            // The session ended between the board read and the tap: a legal outcome, not a defect.
            return;
        }

        expect(await agentSessionPage.phaseShown()).toBe(true);

        if (transcript === "turns") {
            expect((await agentSessionPage.turnIds()).length).toBeGreaterThan(0);
        }
    });

    it("Stop asks for a confirmation, and Cancel stops nothing", async function () {
        if (!(await agentSessionPage.stopShown())) {
            this.skip();
        }

        const enabled = await $("~btn-stop-session").isEnabled();

        if (!enabled) {
            this.skip();
        }

        await agentSessionPage.tapStop();
        const text = await agentSessionPage.confirmationText();
        expect(text).toContain("Stop this session?");
        await agentSessionPage.cancelConfirmation();
        await browser.pause(1000);
        expect(await agentSessionPage.receiptShown()).toBe(false);
    });
});
