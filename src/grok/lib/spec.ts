import type { AgentToolSpec } from "@app/ai/commands/agent/spec";
import { createGrokAdapter } from "@genesiscz/utils/agent-sessions/grok-sessions";
import { grokDriver } from "./driver";
import { grokLauncher } from "./launcher";
import { sendToGrokLeader } from "./leader";
import { classifyGrokArgs, grokResumeIdFromArgs } from "./process-scan";

/** What `tools grok` is. Every shared verb comes from this object and nothing else. */
export const grokSpec: AgentToolSpec = {
    alias: "grok",
    provider: "grok-sub",
    description: "Open the grok TUI as an account, resume sessions, drive isolated headless grok workers",
    adapter: () => createGrokAdapter(),
    launcher: grokLauncher,
    worker: grokDriver,
    processScan: { classify: classifyGrokArgs, resumeIdFromArgs: grokResumeIdFromArgs },
    // The leader the TUI runs in takes the text as a prompt, with no keystrokes; the pane is the fallback.
    structuredSend: async ({ session, text }) => {
        const sent = await sendToGrokLeader({ sessionId: session, text });
        if (sent.kind === "delivered") {
            return {
                kind: "delivered",
                rung: "grok-leader",
                target: `Grok leader · session ${sent.sessionId}${sent.promptId ? ` · prompt ${sent.promptId}` : ""}`,
            };
        }

        return sent.kind === "unknown" ? { kind: "unknown", rung: "grok-leader", reason: sent.reason } : sent;
    },
    help: {
        // xAI reports one monthly billing credit rather than percentage windows.
        usage: "Grok monthly billing credit (interactive TUI)",
        login: "Log in to SuperGrok in the browser and store the grant as a grok-sub account",
    },
};
