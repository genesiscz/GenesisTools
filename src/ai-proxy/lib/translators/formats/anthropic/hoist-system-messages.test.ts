import { describe, expect, it } from "bun:test";
import { hoistSystemMessages } from "@app/ai-proxy/lib/translators/formats/anthropic/hoist-system-messages";

describe("hoistSystemMessages", () => {
    it("moves a system-role message into the top-level system array", () => {
        // Shape observed live: Claude Code -p sent messages with roles
        // ["user","system"]; grok's native /v1/messages 400s on it.
        const body = {
            system: [{ type: "text", text: "base prompt" }],
            messages: [
                { role: "user", content: "hi" },
                { role: "system", content: "output style: terse" },
            ],
        };

        const out = hoistSystemMessages(body);

        expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
        expect(out.system).toEqual([
            { type: "text", text: "base prompt" },
            { type: "text", text: "output style: terse" },
        ]);
    });

    it("converts a string system to an array when hoisting", () => {
        const out = hoistSystemMessages({
            system: "base",
            messages: [{ role: "system", content: [{ type: "text", text: "extra" }] }],
        });

        expect(out.system).toEqual([
            { type: "text", text: "base" },
            { type: "text", text: "extra" },
        ]);
        expect(out.messages).toEqual([]);
    });

    it("returns the same object untouched when no system-role message exists", () => {
        const body = { system: "s", messages: [{ role: "user", content: "hi" }] };

        expect(hoistSystemMessages(body)).toBe(body);
    });

    it("does not mutate its input", () => {
        const body = { messages: [{ role: "system", content: "x" }] };

        hoistSystemMessages(body);

        expect(body.messages).toHaveLength(1);
    });
});
