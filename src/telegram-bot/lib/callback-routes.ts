import { type ActDeps, type PressReceipt, press as pressToken, realActDeps } from "@app/question/lib/act/act";
import { DECISION_CALLBACK_PREFIX, pickLabel, redrawnToggleKeyboard } from "@app/question/lib/decisions/telegram";
import { rememberMessage, takeMessageAt } from "@genesiscz/utils/telegram-bot/lib/messages";
import type { CallbackHandler, CallbackPress, CallbackReply } from "./callbacks";

/** The line under the message and the toast for each closed outcome of an act. */
export function decisionPressReply(receipt: PressReceipt, original: string | undefined): CallbackReply {
    const letter = receipt.decision?.option ? pickLabel(receipt.decision.option) : "?";
    const { outcome } = receipt;

    if (outcome.kind === "staged") {
        return { toast: outcome.option ? `Ticked ${pickLabel(outcome.option)}` : "Nothing ticked" };
    }

    if (keepsKeyboard(receipt)) {
        return { toast: outcome.kind === "refused" ? outcome.detail : `${letter} may not be ticked; check the hub` };
    }

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
 * Whether the decision still waits on this keyboard after the press: a toggle (whatever became of it, but a closed or
 * re-posted decision), or a Send with nothing ticked. A letter of a single-choice decision always ends the keyboard.
 */
function keepsKeyboard(receipt: PressReceipt): boolean {
    const { outcome, tokenKind } = receipt;

    if (outcome.kind === "refused") {
        return outcome.code === "invalid" && (tokenKind === "toggle" || tokenKind === "send");
    }

    return tokenKind === "toggle";
}

/**
 * A decision button press: claims its message out of the memory (so the retraction that the answer's own write
 * triggers cannot race this edit), presses the token with the callback id as the idempotency key, and edits the
 * message with the outcome. A refusal drops the buttons too: the token can never succeed again. A toggle of a decision
 * that takes several letters gives the message back and redraws its keyboard with the staged letters ticked.
 */
export function decisionPressHandler(
    deps: {
        actDeps: () => Promise<ActDeps>;
        /** The clock of the token expiry and the message memory; tests pass the fixture's, so a date never decides. */
        now?: () => number;
    } = { actDeps: realActDeps }
): CallbackHandler {
    return async (press: CallbackPress, token: string) => {
        const at = deps.now?.();
        const clock = at === undefined ? {} : { now: at };
        const claimed =
            press.messageId === undefined
                ? null
                : await takeMessageAt({ chat: press.chatId, message: press.messageId, ...clock });
        let receipt: PressReceipt;
        let actDeps: ActDeps;

        try {
            actDeps = await deps.actDeps();
            receipt = await pressToken({ token, key: `telegram:${press.id}`, deps: actDeps, ...clock });
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

        if (keepsKeyboard(receipt)) {
            if (!claimed) {
                return { toast: reply.toast };
            }

            // The decision still waits: the retraction must find the message when it closes.
            await rememberMessage(claimed.noticeId, claimed.posted);
            const { text } = claimed.posted;
            const { outcome } = receipt;
            const buttons =
                outcome.kind === "staged" && text !== undefined
                    ? await redrawnToggleKeyboard({
                          token,
                          staged: outcome.option,
                          store: actDeps.store,
                          rows: actDeps.rows,
                      })
                    : null;

            return buttons && text !== undefined
                ? { toast: reply.toast, edit: { text, buttons } }
                : { toast: reply.toast };
        }

        // An unclaimed message (an earlier press took it, or the memory forgot it) keeps its text: without the claim
        // there is no original text, so an edit would replace the decision with a bare heading. Telegram's retry of a
        // delivered press and a refused later press both answer with the toast only.
        if (!claimed) {
            return { toast: reply.toast };
        }

        // The outcome edit is what drops the buttons; if it fails, the retraction must still find the message.
        return { ...reply, onEditFailed: () => rememberMessage(claimed.noticeId, claimed.posted) };
    };
}

/** Every button prefix the bot answers. A new kind of button is one entry here. */
export const CALLBACK_ROUTES = {
    [DECISION_CALLBACK_PREFIX]: decisionPressHandler(),
} satisfies Record<string, CallbackHandler>;
