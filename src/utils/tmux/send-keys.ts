import { resolveTmuxBin } from "@genesiscz/utils/tmux/bin";
import { runTmux } from "@genesiscz/utils/tmux/sessions";

/** How long one `tmux send-keys` may take: a running server answers in milliseconds, a wedged one never. */
export const TMUX_SEND_KEYS_TIMEOUT_MS = 5_000;

export type TmuxSendKeysResult = { ok: true } | { ok: false; timedOut: boolean; detail: string };

/**
 * One bounded `tmux send-keys -t <target> <keys…>`. `keys` are the arguments after the target: `["-l", "--", text]`
 * types text literally, `["Enter"]` or `["C-c"]` press keys. The child dies at the deadline even when this process is
 * killed first, so a wedged tmux server never hangs the caller. A timed-out call may still have typed, so a caller
 * that sends more keys after it must stop.
 */
export async function tmuxSendKeys(
    target: string,
    keys: readonly string[],
    options: { timeoutMs?: number } = {}
): Promise<TmuxSendKeysResult> {
    const timeoutMs = options.timeoutMs ?? TMUX_SEND_KEYS_TIMEOUT_MS;
    const result = await runTmux([resolveTmuxBin(), "send-keys", "-t", target, ...keys], { timeoutMs });

    if (result.exitCode === 0) {
        return { ok: true };
    }

    // null is the parent's timeout; 124 is the child watchdog's exit at its deadline.
    const timedOut = result.exitCode === null || result.exitCode === 124;

    return {
        ok: false,
        timedOut,
        detail: timedOut
            ? `tmux send-keys to ${target} did not answer within ${timeoutMs / 1000} s`
            : `tmux send-keys to ${target} failed (${result.exitCode}): ${result.stderr?.trim() || "no detail"}`,
    };
}
