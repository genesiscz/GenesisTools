export const LOG_LINE_JUMP_TOOLTIP = "Jump to line (freezes search)";
export const LOG_LINE_JUMP_CLEAR_TOOLTIP = "Clear line focus";
export const LOG_LINE_JUMP_HOVER_TOOLTIP = "Jump to line (freezes search while you read context)";

export function formatLogLineIndex(index: number): string {
    return `#${index}`;
}

export function scrollToLogLineIndex(container: HTMLElement | null, index: number): void {
    if (!container) {
        return;
    }

    const row = container.querySelector(`[data-log-index="${index}"]`);

    if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
}
