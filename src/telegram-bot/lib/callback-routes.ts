import { type ActDeps, type ActReceipt, act, realActDeps } from "@app/question/lib/act/act";
import { DECISION_CALLBACK_PREFIX } from "@app/question/lib/decisions/telegram";
import { rememberMessage, takeMessageAt } from "@genesiscz/utils/telegram-bot/lib/messages";
import type { CallbackHandler, CallbackPress, CallbackReply } from "./callbacks";

/** The line under the message and the toast for each closed outcome of an act. */
export function decisionPressReply(receipt: ActReceipt, original: string | undefined): CallbackReply {
    const letter = receipt.decision?.option ?? "?";
    const { outcome } = receipt;
    const detail = "detail" in outcome && outcome.detail ? ` (${outcome.detail})` : "";
    const line =
        outcome.kind === "delivered"
            ? `→ ${letter} sent to the agent${detail}`
            : outcome.kind === "queued"
              ? `→ ${letter} saved; it goes with the session's next prompt${detail}`
              : outcome.kind === "uncertain"
                ? `→ ${letter} may have arrived; nothing confirms it${detail}`
                : `Not sent: ${outcome.detail}`;
    const toast =
        outcome.kind === "delivered"
            ? `Sent ${letter}`
            : outcome.kind === "queued"
              ? `Saved ${letter} for the next prompt`
              : outcome.kind === "uncertain"
                ? `${letter} may have arrived`
                : "Not sent";
    const head = original ?? (receipt.decision ? `❓ DECISION ${receipt.decision.number}` : "❓ DECISION");

    return { toast, edit: { text: `${head}\n\n${line}` } };
}

/**
 * A decision letter press: claims its message out of the memory (so the retraction that the answer's own write
 * triggers cannot race this edit), answers through the act door with the callback id as the idempotency key, and
 * edits the message with the outcome. A refusal drops the buttons too: the token can never succeed again.
 */
export function decisionPressHandler(
    deps: { actDeps: () => Promise<ActDeps> } = { actDeps: realActDeps }
): CallbackHandler {
    return async (press: CallbackPress, token: string) => {
        const claimed =
            press.messageId === undefined
                ? null
                : await takeMessageAt({ chat: press.chatId, message: press.messageId });
        let receipt: ActReceipt;

        try {
            receipt = await act({ token, key: `telegram:${press.id}`, deps: await deps.actDeps() });
        } catch (err) {
            // Give the message back, so the retraction can still drop its buttons when the decision closes elsewhere.
            if (claimed) {
                await rememberMessage(claimed.noticeId, claimed.posted);
            }

            throw err;
        }

        const reply = decisionPressReply(receipt, claimed?.posted.text);

        if (
            claimed &&
            receipt.outcome.kind === "uncertain" &&
            receipt.outcome.detail === "this answer is still being sent"
        ) {
            // A retry of a press still in flight: the first press edits the message, so keep it remembered.
            await rememberMessage(claimed.noticeId, claimed.posted);
            return { toast: reply.toast };
        }

        // The outcome edit is what drops the buttons; if it fails, the retraction must still find the message.
        return claimed ? { ...reply, onEditFailed: () => rememberMessage(claimed.noticeId, claimed.posted) } : reply;
    };
}

/** Every button prefix the bot answers. A new kind of button is one entry here. */
export const CALLBACK_ROUTES = {
    [DECISION_CALLBACK_PREFIX]: decisionPressHandler(),
} satisfies Record<string, CallbackHandler>;
