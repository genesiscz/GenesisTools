/** One bullet under a summary's action-item or decision heading. */
export interface SummaryPoint {
    kind: "action" | "decision";
    /** "(Martin Example) Call the vendor": the person in parentheses at the start, when there is one. */
    person?: string;
    text: string;
    /** The words a transcript range must share to cite this point (four letters or more, lower case). */
    keyWords: string[];
}

const KEY_WORD_MIN = 4;

/** Lower-case words of four letters or more: the words that make a sentence recognisable. */
export function keyWords(text: string): string[] {
    return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
        (word) => word.length >= KEY_WORD_MIN
    );
}

/**
 * The action items and decisions of a Markdown summary: the bullets under a heading whose text is one of
 * `actionHeadings` or `decisionHeadings` (any heading level, case-insensitive). Wispr writes an action item as
 * "- (Person Name) text (optional date)".
 */
export function summaryPoints(
    markdown: string,
    headings: { actionHeadings: string[]; decisionHeadings: string[] }
): SummaryPoint[] {
    const actions = new Set(headings.actionHeadings.map((heading) => heading.toLowerCase()));
    const decisions = new Set(headings.decisionHeadings.map((heading) => heading.toLowerCase()));
    const points: SummaryPoint[] = [];
    let kind: SummaryPoint["kind"] | undefined;

    for (const line of markdown.split("\n")) {
        const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);

        if (heading) {
            const name = heading[1]!.replace(/[*_:]/g, "").trim().toLowerCase();
            kind = actions.has(name) ? "action" : decisions.has(name) ? "decision" : undefined;
            continue;
        }

        const bullet = /^\s*[-*]\s+(.+)$/.exec(line);

        if (!kind || !bullet) {
            continue;
        }

        const owned = /^\(([^)]+)\)\s*(.+)$/.exec(bullet[1]!.trim());
        const text = (owned ? owned[2]! : bullet[1]!).trim();
        points.push({ kind, ...(owned ? { person: owned[1]!.trim() } : {}), text, keyWords: keyWords(text) });
    }

    return points;
}

/** A range cites a point when it holds at least three of the point's key words, or half of them. */
export function citesPoint(rangeWords: Set<string>, point: SummaryPoint): boolean {
    const shared = point.keyWords.filter((word) => rangeWords.has(word)).length;
    return shared >= 3 || (point.keyWords.length > 0 && shared / point.keyWords.length >= 0.5 && shared >= 2);
}
