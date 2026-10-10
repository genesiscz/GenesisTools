import { type NativeInboxState, nativeInboxState } from "@genesiscz/utils/macos/native-inbox";
import { loadConfig } from "./config";
import { postNote } from "./inbox-guidance";

/**
 * The note every question post returns to the agent (CLI `tools question ask` and MCP question_post). It reads the
 * LIVE native inbox state, so an agent learns right after posting whether the widget is on screen. The text and its
 * precedence over the `tools question config --ask-via-question-tool` opt-in live in ./inbox-guidance.ts.
 */
export function agentNote(opts: { askViaQuestionTool?: boolean; state?: NativeInboxState } = {}): string {
    return postNote({
        state: opts.state ?? nativeInboxState(),
        askViaQuestionTool: opts.askViaQuestionTool ?? loadConfig().askViaQuestionTool === true,
    });
}
