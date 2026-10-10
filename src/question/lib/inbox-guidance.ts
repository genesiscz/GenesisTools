import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import type { NativeInboxState } from "@genesiscz/utils/macos/native-inbox";

/**
 * Every sentence that tells an agent WHEN to use the native GenesisTools inbox, in one place.
 *
 * Precedence, decided here and nowhere else:
 * 1. The native inbox state (`nativeInboxState()`, @genesiscz/utils/macos/native-inbox) decides whether the inbox
 *    exists for agents and whether a chat ask is mandatory:
 *    - `none`: no native app. Agents are told nothing about the inbox; `inbox_send` is not even registered.
 *    - `installed`: an agent may post, and must ALSO ask the user directly in the chat, because nobody may see it.
 *    - `running`: the widget is on screen, so agents post decisions, messages and screenshots when they need the user.
 * 2. `askViaQuestionTool` (`tools question config --ask-via-question-tool`) decides one thing only: whether
 *    question_post REPLACES the agent's native question tool for ❓ DECISIONs. It applies while the widget runs, and
 *    on a Mac without the app (where question_post feeds the decision log and /qa). It never lifts the chat ask while
 *    the widget is not running.
 * 3. Always: every question is also written in the chat reply. The inbox and the decision log are copies.
 *
 * Consumers: `serverInstructions()` and the question_post / inbox_send descriptions (src/genesis-tools-mcp),
 * `agentNote()` after every post, `tools question message`, and the SessionStart hook
 * `plugins/genesis-tools/hooks/native-inbox-hint.ts`, whose copy of {@link inboxInstructions} a test pins to this one.
 */
export interface InboxGuidance {
    state: NativeInboxState;
    askViaQuestionTool: boolean;
}

const DECISION_DOOR = `a question_post item with type "decision" (CLI: \`${toolCommand("question ask", "--json", "-")}\`)`;
const MESSAGE_DOOR = `inbox_send with the screenshot paths in \`images\` (CLI: \`${toolCommand("question message")} "<text>" --image /abs/shot.png\`)`;

/** The INBOX paragraph: when to post and how. Empty without the native app. */
export function inboxInstructions(state: NativeInboxState): string {
    if (state === "running") {
        return (
            "INBOX: the user's GenesisTools widget is running on this Mac, and its inbox reaches the user even when " +
            "they are not watching this chat. Post there only when you need the user: a decision you cannot make " +
            `yourself, as ${DECISION_DOOR}; or a finished long task, a blocker, or a result they must see (attach ` +
            `the screenshot), as ${MESSAGE_DOOR}. Never post routine progress or anything you can decide yourself. ` +
            "Also write every question in your chat reply."
        );
    }

    if (state === "installed") {
        return (
            "INBOX: the GenesisTools app is installed on this Mac, but its widget is not running, so nobody may see " +
            `the inbox. You may still post a decision, as ${DECISION_DOOR}, or a message or screenshot, as ` +
            `${MESSAGE_DOOR}. But ALWAYS also ask the user directly in this chat, with your native question tool ` +
            "or in your reply."
        );
    }

    return "";
}

/** The ❓ DECISION sentence of the server instructions and the question_post description. */
export function decisionNudge({ state, askViaQuestionTool }: InboxGuidance): string {
    if (state === "installed") {
        return (
            "The GenesisTools widget is not running, so a post may go unseen: ask decisive questions with your " +
            "native question tool (for example AskUserQuestion) or in your reply, and post here only as a copy. "
        );
    }

    if (state === "running") {
        return askViaQuestionTool
            ? "Post every ❓ DECISION this way instead of your native question tool: the user answers it in the " +
                  "widget inbox. Also write it in your reply. "
            : "Ask decisive questions with your native question tool (for example AskUserQuestion) and in your " +
                  "reply, and also post each ❓ DECISION here so it reaches the user's widget inbox. ";
    }

    return askViaQuestionTool
        ? "Post every ❓ DECISION this way, and also write it in your reply: the log is a copy. "
        : "The user has NOT opted in to agents asking through question_post, so ask decisive questions with your " +
              "native question tool (for example AskUserQuestion) and in your reply. ";
}

const REPLY_COPY =
    "Also write every question and ❓ DECISION in your own chat reply, because the user reads your reply first.";

/** The note every question post returns to the agent: what happened to the post, and what the agent still owes. */
export function postNote({ state, askViaQuestionTool }: InboxGuidance): string {
    if (state === "installed") {
        return (
            "Saved to the inbox, but the GenesisTools widget is not running, so the user may not see it. Ask the " +
            "user directly in this chat now: your native question tool (for example AskUserQuestion) or your reply."
        );
    }

    if (state === "running") {
        return askViaQuestionTool
            ? `Posted to the user's widget inbox. ${REPLY_COPY}`
            : `Posted to the user's widget inbox. ${REPLY_COPY} Ask decisive questions with your native question ` +
                  "tool (for example AskUserQuestion) as usual.";
    }

    if (askViaQuestionTool) {
        return REPLY_COPY;
    }

    return (
        `The user has not opted in to agents asking through ${toolCommand("question")} (${toolCommand("question config")}). ` +
        "The post was saved, but ask decisive questions with your native question tool (for example " +
        `AskUserQuestion) and in your chat reply. ${REPLY_COPY}`
    );
}

/** What `inbox_send` and `tools question message` tell the agent after a message was stored. */
export function messageNote(state: NativeInboxState): string {
    if (state === "running") {
        return "Delivered to the user's widget inbox.";
    }

    if (state === "installed") {
        return "Saved to the inbox, but the GenesisTools widget is not running: also tell the user in this chat.";
    }

    return "Saved to the question log. This Mac has no native GenesisTools inbox, so tell the user in this chat.";
}

/** The inbox_send tool description (the tool exists only while the state is not `none`). */
export function inboxSendDescription(state: NativeInboxState): string {
    const when =
        state === "running"
            ? "The user's widget is running, so this reaches them even when they are not watching the chat."
            : "The widget is not running, so nobody may see it: ALSO tell the user in this chat.";

    return (
        "Send the user a message, optionally with screenshots, to their GenesisTools widget inbox. It lands as an " +
        "expandable card under this session. Use it only when you need the user's attention: a finished long " +
        "task, a blocker, or a result they must look at. Never for routine progress. Put local PNG/JPEG/WebP " +
        `paths in \`images\`; they are copied into durable storage. ${when} CLI: ` +
        `\`${toolCommand("question message")} "<text>" --image /abs/shot.png\`.`
    );
}
