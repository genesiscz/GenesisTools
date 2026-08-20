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

const FOLDED_DETAILS_RE =
    /<details\b[^>]*>\s*<summary\b[^>]*>\s*(?:<strong>)?Thinking(?:<\/strong>)?\s*<\/summary>([\s\S]*?)(?:<\/details>|$)\s*/gi;

/**
 * Pulls the reasoning back out of a folded `<details>` wrapper this proxy wrote
 * into assistant `content`, so it can ride upstream as `reasoning_content`
 * instead of being deleted. Only the proxy's own marker matches: `<think>` tags
 * the model itself emitted are the model's output and stay untouched. The
 * predecessor (`stripCursorThinkingBlocks`) erased both wholesale, which removed
 * the model's reasoning from history every turn — the mechanism behind it
 * re-reading files it had already read and repeating announced work.
 */
export function extractFoldedThinking(content: string): { content: string; reasoning: string | null } {
    const reasoningParts: string[] = [];
    const stripped = content.replace(FOLDED_DETAILS_RE, (_match, inner: string) => {
        const trimmed = inner.trim();

        if (trimmed.length > 0) {
            reasoningParts.push(trimmed);
        }

        return "";
    });

    if (reasoningParts.length === 0) {
        return { content, reasoning: null };
    }

    return { content: stripped.replace(/^\r\n+/, ""), reasoning: reasoningParts.join("\n\n") };
}
