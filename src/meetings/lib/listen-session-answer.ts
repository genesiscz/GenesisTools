import type { ListenAdapter, ListenAnswer, ListenOutcome, SessionNote } from "./listen-session";

export type AnswerPrint = (line: string, tone: "ok" | "dim") => void;

/** `listen --item Q12 --answer <text>`: an agent relaying the user, or a script. One answer, no audio, no prompts. */
export class GivenAnswerAdapter implements ListenAdapter {
    private given = false;

    constructor(
        private readonly answer: ListenAnswer,
        private readonly print: AnswerPrint
    ) {}

    async ask(): Promise<ListenOutcome> {
        if (this.given) {
            return "stop";
        }

        this.given = true;
        return this.answer;
    }

    async confirmLeave(): Promise<boolean> {
        return true;
    }

    note(note: SessionNote): void {
        if (note.kind !== "decided" || note.outcome === "skip") {
            return;
        }

        if (note.settled.length > 0) {
            this.print(`the same answer settled ${note.settled.length} more: ${note.settled.join(" ")}`, "dim");
        }

        this.print(`${note.label} answered: ${note.outcome.answer}`, "ok");
    }
}
