export interface HistoryRelevanceInput {
    query: string;
    summary?: string;
    customTitle?: string;
    firstUserMessage?: string;
    allText: string;
    /** Equivalent capped occurrence sum from a streaming source scan. */
    contentScore?: number;
    timestamp: Date;
    now?: Date;
}

export function calculateHistoryRelevance(options: HistoryRelevanceInput): number {
    if (!options.query) {
        return 0;
    }

    let score = 0;
    const queryWords = options.query.toLowerCase().split(/\s+/);
    const queryLower = options.query.toLowerCase();

    const titleText = (options.customTitle || options.summary || "").toLowerCase();
    if (titleText.includes(queryLower)) {
        score += 100;
    } else {
        for (const word of queryWords) {
            if (titleText.includes(word)) {
                score += 15;
            }
        }
    }

    if (options.firstUserMessage) {
        const firstMsgLower = options.firstUserMessage.toLowerCase();
        if (firstMsgLower.includes(queryLower)) {
            score += 50;
        } else {
            for (const word of queryWords) {
                if (firstMsgLower.includes(word)) {
                    score += 10;
                }
            }
        }
    }

    const allTextLower = options.allText.toLowerCase();
    for (const word of options.contentScore === undefined ? queryWords : []) {
        const wordLower = word.toLowerCase();
        let occurrences = 0;
        let pos = 0;
        // biome-ignore lint/suspicious/noAssignInExpressions: assignment preserves the established capped search loop
        while ((pos = allTextLower.indexOf(wordLower, pos)) !== -1 && occurrences < 10) {
            occurrences++;
            pos += wordLower.length;
        }
        score += occurrences;
    }

    score += options.contentScore ?? 0;

    const now = options.now?.getTime() ?? Date.now();
    const daysSinceConversation = (now - options.timestamp.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceConversation < 7) {
        score += Math.round(20 * (1 - daysSinceConversation / 7));
    }

    return score;
}
