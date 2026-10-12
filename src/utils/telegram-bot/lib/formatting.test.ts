import { describe, expect, test } from "bun:test";
import { formatTelegramNotification } from "@genesiscz/utils/telegram-bot/lib/formatting";

/** What Telegram counts against its 4096 limit: the text after MarkdownV2 entities are parsed away. */
function parsedLength(markdownV2: string): number {
    return markdownV2.replace(/\\(.)/g, "$1").replace(/^\*(.*)\*\n/, "$1\n").length;
}

describe("formatTelegramNotification", () => {
    test("keeps a short notification whole: bold title, escaped body", () => {
        expect(formatTelegramNotification({ title: "shop-web · develop", message: "Done. 2 files." })).toBe(
            "*shop\\-web · develop*\nDone\\. 2 files\\."
        );
    });

    test("clips a long body before escaping, so the parsed text fits Telegram's 4096 limit", () => {
        const message = "a.b-c ".repeat(2000);
        const text = formatTelegramNotification({ title: "app · branch [action]", message });

        expect(parsedLength(text)).toBeLessThanOrEqual(4096);
        expect(text.startsWith("*app · branch \\[action\\]*\na\\.b\\-c ")).toBe(true);
        expect(text.endsWith("\\.\\.\\. \\(truncated\\)")).toBe(true);
    });

    test("never ends on half an escape when the cut lands next to a reserved character", () => {
        const text = formatTelegramNotification({ message: ".".repeat(5000) });

        expect(parsedLength(text)).toBeLessThanOrEqual(4096);
        expect(text.replace(/\\[\s\S]/g, "")).not.toContain("\\");
    });
});
