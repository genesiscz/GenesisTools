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

/**
 * The Claude args `tools claude run` passes on, or the usage error to print: a `--settings` of the caller's own and
 * `--cross-messages` cannot both be honoured. Returned, not thrown, so the command prints one line and exits 2.
 */
export function startPassthrough(
    crossMessages: boolean | undefined,
    passthrough: readonly string[]
): { args: string[] } | { error: string } {
    if (!crossMessages) {
        return { args: [...passthrough] };
    }

    try {
        return { args: withCrossMessages(passthrough) };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}
