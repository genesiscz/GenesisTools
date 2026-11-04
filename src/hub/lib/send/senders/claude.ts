import type { HarnessSender } from "../types";

/**
 * Claude Code: `now` is the answer-route ladder (an owned worker, its own peer socket, then the guarded cmux pane); a
 * busy session reads a peer message between tool calls. Claude has no channel that holds a message until its turn
 * ends, so `next-turn` is refused rather than faked; `later` saves it in the durable session queue. Esc ends a turn.
 */
export const sessionSender: HarnessSender = {
    timings: {
        now: {
            meaning: "into the running session; a busy session reads it between tool calls",
            send: (request, edges) => edges.deliverNow(request),
        },
        "next-turn": {
            refused:
                "Claude Code has no channel that holds a message until the turn ends: a message sent now is read between tool calls. Send it now, or later.",
        },
        later: {
            meaning: "saved for this exact session until its consumer acknowledges it",
            send: (request, edges) => edges.enqueue(request),
        },
    },
    interrupt: { key: "escape" },
};
