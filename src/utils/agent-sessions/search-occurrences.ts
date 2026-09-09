/** Counts the legacy non-overlapping, ten-per-query-word score without retaining transcript bodies. */
export class HistoryOccurrenceCounter {
    private readonly terms: Array<{ word: string; count: number; tail: string }>;

    constructor(query: string) {
        this.terms = query
            ? query
                  .toLowerCase()
                  .split(/\s+/)
                  .map((word) => ({ word, count: 0, tail: "" }))
            : [];
    }

    append(text: string): void {
        const lower = text.toLowerCase();

        for (const term of this.terms) {
            if (term.count === 10) {
                continue;
            }

            if (term.word.length === 0) {
                term.count = 10;
                continue;
            }

            const chunk = term.tail + lower;
            let from = 0;
            let position = chunk.indexOf(term.word, from);

            while (position !== -1 && term.count < 10) {
                term.count++;
                from = position + term.word.length;
                position = chunk.indexOf(term.word, from);
            }

            term.tail = term.count === 10 ? "" : chunk.slice(Math.max(from, chunk.length - term.word.length + 1));
        }
    }

    get score(): number {
        return this.terms.reduce((total, term) => total + term.count, 0);
    }
}
