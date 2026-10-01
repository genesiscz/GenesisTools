import { loadConfig } from "./config";

/**
 * The note every question post returns to the agent (CLI `tools question ask` and MCP question_post).
 * The inbox is a copy, so the question must also be in the agent's own reply; and without the opt-in
 * (`tools question config --ask-via-question-tool on`) the agent is told to ask with its native tools.
 */
export function agentNote(askViaQuestionTool = loadConfig().askViaQuestionTool === true): string {
    const copy =
        "The inbox holds a copy only: also write every question and ❓ DECISION in your own chat reply, " +
        "because the user reads your reply first.";

    if (askViaQuestionTool) {
        return copy;
    }

    return (
        "The user has not opted in to agents asking through tools question (tools question config). " +
        "The post was saved to the inbox, but ask decisive questions with your native question tool " +
        `(for example AskUserQuestion) and in your chat reply. ${copy}`
    );
}
