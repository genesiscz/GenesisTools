export const FOLDED_DETAILS_OPEN = "<details>\n<summary><strong>Thinking</strong></summary>\n\n";
export const FOLDED_DETAILS_CLOSE = "\n\n</details>\n\n\n";

export interface FoldedStreamState {
    open: boolean;
}

export function createFoldedStreamState(): FoldedStreamState {
    return { open: false };
}

export function foldedReasoningPrefix(state: FoldedStreamState): string {
    if (state.open) {
        return "";
    }

    state.open = true;
    return FOLDED_DETAILS_OPEN;
}

export function foldedAnswerPrefix(state: FoldedStreamState): string {
    if (!state.open) {
        return "";
    }

    state.open = false;
    return FOLDED_DETAILS_CLOSE;
}

export function closeFoldedDetailsContent(state: FoldedStreamState): string | null {
    if (!state.open) {
        return null;
    }

    state.open = false;
    return FOLDED_DETAILS_CLOSE;
}

export function wrapReasoningForFoldedJson(reasoning: string, answer: string | null): string {
    const body = `${FOLDED_DETAILS_OPEN}${reasoning}${FOLDED_DETAILS_CLOSE}`;

    if (answer) {
        return `${body}${answer}`;
    }

    return body.trimEnd();
}

const CURSOR_THINKING_BLOCK_RE =
    /(?:<(?:think|thinking)\b[^>]*>[\s\S]*?(?:<\/(?:think|thinking)>|$)|<details\b[^>]*>\s*<summary\b[^>]*>\s*(?:<strong>)?Thinking(?:<\/strong>)?\s*<\/summary>[\s\S]*?(?:<\/details>|$))\s*/gi;

export function stripCursorThinkingBlocks(content: string): string {
    return content.replace(CURSOR_THINKING_BLOCK_RE, "").replace(/^\r\n+/, "");
}
