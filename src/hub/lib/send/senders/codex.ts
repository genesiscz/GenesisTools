import type { HarnessSender } from "../types";

/**
 * Codex: `now` steers the running turn through its `tools codex` worker (the answer-route ladder never types into a
 * Codex pane); `next-turn` is the shared app-server's thread queue (`codex queue`), which runs the message after the
 * current turn and answers `queued-daemon`; `later` saves it in the durable session queue. Esc ends the TUI's turn.
 */
export const sessionSender: HarnessSender = {
    timings: {
        now: {
            meaning: "steered into the running turn through the session's worker",
            send: (request, edges) => edges.deliverNow(request),
        },
        "next-turn": {
            meaning: "queued on the shared app-server; it runs after the current turn",
            send: (request, edges) => edges.codexQueue(request),
        },
        later: {
            meaning: "saved for this exact session until its consumer acknowledges it",
            send: (request, edges) => edges.enqueue(request),
        },
    },
    interrupt: { key: "escape" },
};
