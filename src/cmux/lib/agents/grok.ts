import { grokLeaderSocket } from "@app/grok/lib/leader";
import type { CmuxAdapter, SessionLaunchExtras, TrustPrompt } from "../session-agents";

/** Grok joins one leader per account; the leader socket and the session id go into the record. */
function grokLaunchExtras({ account, sessionId }: { account: string; sessionId: string }): SessionLaunchExtras {
    const socket = grokLeaderSocket(account);
    return {
        args: ["--leader-socket", socket, "--session-id", sessionId],
        providers: { grok: { leader: { socket, sessionId } } },
    };
}

function stripGrokSuffix(title: string): string {
    return title.replace(/\s+-\s+grok(?:\s+·\s+[0-9a-f]{7,8})?\s*$/i, "").trim();
}

/** Grok's first-run dialog. Until it is answered, grok has not opened the session it was asked to resume. */
const GROK_TRUST_PROMPT: TrustPrompt = {
    screen: /Do you trust the contents of this directory\?[\s\S]*No, quit\s+n\b/,
    quitKey: "n",
};

/** Grok's cmux part: a leader per account at launch, and a trust prompt a restore may quit through. */
export const cmuxPart: CmuxAdapter = {
    crossMessages: false,
    launchExtras: grokLaunchExtras,
    stripTitle: stripGrokSuffix,
    trustPrompt: GROK_TRUST_PROMPT,
};
