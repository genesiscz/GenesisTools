import { BasePage } from "@e2e/pages/base.page";

export type TranscriptState = "turns" | "none" | "error" | "gone";

/** One live session (`app/(more)/agent-session.tsx`): its phase badge, the Stop action and the transcript. */
class AgentSessionPage extends BasePage {
    async transcriptState(timeout = 30_000): Promise<TranscriptState> {
        const ids: Array<[string, TranscriptState]> = [
            ["session-transcript", "turns"],
            ["transcript-none", "none"],
            ["transcript-error", "error"],
            ["session-gone", "gone"],
        ];
        let found: TranscriptState | null = null;
        await this.waitUntil(
            async () => {
                for (const [id, state] of ids) {
                    if (await this.isExisting(id)) {
                        found = state;
                        return true;
                    }
                }

                return false;
            },
            { timeout, message: "the session view never showed a transcript, an empty state or a gone state" }
        );
        return found ?? "error";
    }

    phaseShown(): Promise<boolean> {
        return this.isExisting("session-phase");
    }

    async turnIds(): Promise<string[]> {
        const turns = await $$('//*[starts-with(@name, "turn-")]');
        const ids: string[] = [];

        for (const turn of turns) {
            const name = await turn.getAttribute("name");

            if (name) {
                ids.push(name.slice("turn-".length));
            }
        }

        return ids;
    }

    stopShown(): Promise<boolean> {
        return this.isExisting("btn-stop-session");
    }

    async tapStop(): Promise<void> {
        await this.tap("btn-stop-session");
    }

    /** The confirmation's title and message, or null when no alert is open within `timeout`. */
    async confirmationText(timeout = 5_000): Promise<string | null> {
        try {
            await browser.waitUntil(async () => (await browser.getAlertText().catch(() => null)) !== null, { timeout });
            return await browser.getAlertText();
        } catch {
            return null;
        }
    }

    /** Taps the confirmation's Cancel button, so nothing on the Mac is stopped. */
    async cancelConfirmation(): Promise<void> {
        await browser.execute("mobile: alert", { action: "dismiss", buttonLabel: "Cancel" });
    }

    receiptShown(): Promise<boolean> {
        return this.isExisting("stop-receipt");
    }
}

export const agentSessionPage = new AgentSessionPage();
