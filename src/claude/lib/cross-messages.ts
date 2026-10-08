import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Claude Code holds a cross-session message for approval when the receiving session bypasses
 * permission prompts and the sender attests no permission mode (a script never can: the attested mode
 * describes a sending SESSION). `crossSessionInbound: "accept"` delivers such messages straight away, so
 * `tools claude message` and other agents reach the session without a click. Opt-in per session: it
 * widens who can put text into that session to every process of this OS user.
 */
export const CROSS_MESSAGES_SETTINGS = { crossSessionInbound: "accept" } as const;

/** Claude args with the accept setting in front; refuses to merge with a caller's own `--settings`. */
export function withCrossMessages(passthrough: readonly string[]): string[] {
    if (passthrough.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
        throw new Error(
            '--cross-messages cannot be combined with your own --settings; add "crossSessionInbound": "accept" to that settings file instead'
        );
    }

    return ["--settings", SafeJSON.stringify(CROSS_MESSAGES_SETTINGS), ...passthrough];
}
