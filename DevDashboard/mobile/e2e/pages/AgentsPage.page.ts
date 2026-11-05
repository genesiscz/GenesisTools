import { getDevDashboardBundleId } from "@e2e/bundle-id";
import { idsWithPrefix } from "@e2e/pages/agentApi";
import { BasePage } from "@e2e/pages/base.page";

export type AgentsState = "list" | "empty" | "error";

/** The live agents board (`app/(more)/agents.tsx`): one `agent-row-<key>` card per live Claude, Codex or Grok session. */
class AgentsPage extends BasePage {
    async open(): Promise<void> {
        await browser.execute("mobile: deepLink", { url: "devdashboard://agents", bundleId: getDevDashboardBundleId() });
        await this.waitForExist("screen-agents", 15_000);
    }

    /** Waits until the board left its loading state and says which one it shows. */
    async loadedState(timeout = 30_000): Promise<AgentsState> {
        let state: AgentsState | null = null;
        await this.waitUntil(
            async () => {
                if (await this.isExisting("agents-error")) {
                    state = "error";
                } else if (await this.isExisting("agents-empty")) {
                    state = "empty";
                } else if (await this.isExisting("agents-live")) {
                    state = "list";
                }

                return state !== null;
            },
            { timeout, message: "the agents board never left its loading state" }
        );
        return state ?? "error";
    }

    sessionKeys(): Promise<string[]> {
        return idsWithPrefix("agent-row-");
    }

    async phaseOf(key: string): Promise<string> {
        return this.getText(`agent-phase-${key}`);
    }

    async openSession(key: string): Promise<void> {
        await this.tap(`agent-row-${key}`);
        await this.waitForExist("screen-agent-session", 15_000);
    }
}

export const agentsPage = new AgentsPage();
