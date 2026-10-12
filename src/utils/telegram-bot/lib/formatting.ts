// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape/control character matching
const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_TITLE_LENGTH = 256;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, "");
}

function clipForTelegram(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }

    return `${text.slice(0, max - 20)}\n... (truncated)`;
}

export function truncateForTelegram(text: string): string {
    return clipForTelegram(stripAnsi(text), MAX_MESSAGE_LENGTH);
}

export function escapeMarkdownV2(text: string): string {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * A notification as MarkdownV2: a bold title line, then the body. Telegram applies its 4096-character limit
 * after the escapes are parsed away, so the raw text is clipped BEFORE escaping; clipping the escaped text
 * would count every backslash and could cut an escape in half.
 */
export function formatTelegramNotification({ title, message }: { title?: string; message: string }): string {
    const head = title ? clipForTelegram(title, MAX_TITLE_LENGTH) : "";
    const body = escapeMarkdownV2(clipForTelegram(message, MAX_MESSAGE_LENGTH - (head ? head.length + 1 : 0)));
    return head ? `*${escapeMarkdownV2(head)}*\n${body}` : body;
}
