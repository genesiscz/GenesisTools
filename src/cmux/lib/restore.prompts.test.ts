import { describe, expect, test } from "bun:test";
import { detectInteractivePrompt, formatWaitingPanes } from "@app/cmux/lib/restore";
import { stripAnsi } from "@genesiscz/utils/string";

describe("detectInteractivePrompt", () => {
    test("recognizes the cc-run account headroom gate", () => {
        const screen =
            '⚠ Fable weekly on "work" is spent.\n◆ Launch anyway? (No cancels so you can pick another account)\n● Yes / ○ No';
        expect(detectInteractivePrompt(screen)).toContain("account-headroom");
    });

    test("recognizes claude's resume-mode dialog", () => {
        const screen = "1. Resume from summary (recommended)\n2. Resume full session as-is\n3. Don't ask me again";
        expect(detectInteractivePrompt(screen)).toContain("resume-mode");
    });

    test("recognizes the session picker and warns about verification", () => {
        const screen = 'Select session to resume: matching "burn"\n  NAME    BRANCH   AGE\n❯ one     develop  22m';
        expect(detectInteractivePrompt(screen)).toContain("verify the highlighted session");
    });

    test("returns undefined for a busy claude pane", () => {
        const screen = "✳ Cooking… (2m 3s · ↓ 1.2k tokens)\n  ⏵⏵ bypass permissions on";
        expect(detectInteractivePrompt(screen)).toBeUndefined();
    });
});

describe("formatWaitingPanes", () => {
    const waiting = [
        { workspaceRef: "ws-1", surfaceRef: "surf-1", prompt: "account-headroom gate" },
        { workspaceRef: "ws-2", surfaceRef: "surf-2", prompt: "resume-mode dialog" },
    ];

    test("one line per waiting pane, then the advice line", () => {
        const lines = formatWaitingPanes(waiting, "Rescue").map(stripAnsi);

        expect(lines).toEqual([
            "  ⚠ ws-1 surf-1 — account-headroom gate",
            "  ⚠ ws-2 surf-2 — resume-mode dialog",
            "  Rescue does not auto-confirm these; answer each pane yourself.",
        ]);
    });

    test("the actor is the ONLY difference between the two callers", () => {
        // Rescue and restore each kept their own copy of this block, one word
        // apart, so a fix to either never reached the other.
        const rescue = formatWaitingPanes(waiting, "Rescue").map(stripAnsi);
        const restore = formatWaitingPanes(waiting, "Restore").map(stripAnsi);

        expect(restore.slice(0, -1)).toEqual(rescue.slice(0, -1));
        expect(restore.at(-1)).toBe("  Restore does not auto-confirm these; answer each pane yourself.");
    });
});
