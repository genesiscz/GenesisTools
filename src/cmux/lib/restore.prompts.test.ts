import { describe, expect, test } from "bun:test";
import { detectInteractivePrompt } from "@app/cmux/lib/restore";

describe("detectInteractivePrompt", () => {
    test("recognizes the cc-run account headroom gate", () => {
        const screen = "⚠ Fable weekly on \"work\" is spent.\n◆ Launch anyway? (No cancels so you can pick another account)\n● Yes / ○ No";
        expect(detectInteractivePrompt(screen)).toContain("account-headroom");
    });

    test("recognizes claude's resume-mode dialog", () => {
        const screen = "1. Resume from summary (recommended)\n2. Resume full session as-is\n3. Don't ask me again";
        expect(detectInteractivePrompt(screen)).toContain("resume-mode");
    });

    test("recognizes the session picker and warns about verification", () => {
        const screen = "Select session to resume: matching \"burn\"\n  NAME    BRANCH   AGE\n❯ one     develop  22m";
        expect(detectInteractivePrompt(screen)).toContain("verify the highlighted session");
    });

    test("returns undefined for a busy claude pane", () => {
        const screen = "✳ Cooking… (2m 3s · ↓ 1.2k tokens)\n  ⏵⏵ bypass permissions on";
        expect(detectInteractivePrompt(screen)).toBeUndefined();
    });
});
