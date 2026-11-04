import type { HarnessSender } from "../types";

/**
 * Grok: `now` is the answer-route ladder (an owned worker, the leader its TUI runs in, then the guarded cmux pane).
 * The TUI listens on no socket, and whether its leader holds a prompt until the turn ends was never measured, so
 * `next-turn` is refused; `later` saves it in the durable session queue. Esc ends the TUI's turn.
 */
export const sessionSender: HarnessSender = {
    timings: {
        now: {
            meaning: "into the running session through its worker or leader, else its cmux pane",
            send: (request, edges) => edges.deliverNow(request),
        },
        "next-turn": {
            refused: "Grok has no measured channel that holds a message until the turn ends. Send it now, or later.",
        },
        later: {
            meaning: "saved for this exact session until its consumer acknowledges it",
            send: (request, edges) => edges.enqueue(request),
        },
    },
    interrupt: { key: "escape" },
};
