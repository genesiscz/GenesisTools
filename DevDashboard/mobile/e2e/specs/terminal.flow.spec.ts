import { agentGet } from "@e2e/pages/agentApi";
import { appPage } from "@e2e/pages/app.page";
import { connectPage } from "@e2e/pages/ConnectPage.page";
import { terminalsPage } from "@e2e/pages/TerminalsPage.page";

/**
 * The Terminals tab against the Mac's tmux: every session row is a session the server lists. Opening a terminal
 * attaches the phone to a real tmux session on the Mac (and resizes its window), so that case runs only with
 * DD_E2E_OPEN_TERMINAL=1; it then checks the surface, the key bar and the status, and closes it again.
 */
describe("Terminal flow", () => {
    before(async () => {
        if (await connectPage.isShown()) {
            await connectPage.pairWithTestAgent();
        }

        await appPage.openTab("Terminals");
        expect(await terminalsPage.isShown()).toBe(true);
    });

    it("every tmux row is a session the server lists", async () => {
        const served = JSON.stringify(await agentGet<unknown>("/api/tmux/sessions"));
        const shown = await terminalsPage.tmuxSessionNames();
        const unknown = shown.filter((name) => !served.includes(`"${name}"`));
        expect(unknown).toEqual([]);
    });

    it("the terminal driver switch is offered", async () => {
        expect(await terminalsPage.isDriverSwitcherShown()).toBe(true);
    });

    it("a terminal opens with its surface, key bar and a connected status, then closes", async function () {
        if (process.env.DD_E2E_OPEN_TERMINAL !== "1" || (await terminalsPage.tmuxSessionNames()).length === 0) {
            this.skip();
        }

        await terminalsPage.openFirstTerminal();
        expect(await terminalsPage.terminalSurfaceVisible()).toBe(true);
        expect(await terminalsPage.keyBarVisible()).toBe(true);
        await terminalsPage.waitForConnected();
        await terminalsPage.closeTerminal();
        expect(await terminalsPage.isShown()).toBe(true);
    });
});
