import { describe, expect, it } from "bun:test";
import { injectKey, injectText } from "@/features/terminals/inject";

/**
 * Driver A's key bar sends punctuation through `sendKey` whenever Ctrl is latched, so `injectKey`
 * has to survive a key that is not in its named-key table. It used to dereference the lookup
 * unguarded and throw inside the `onPress` handler.
 */
describe("injectKey", () => {
    it("builds a dispatch for every named key", () => {
        expect(injectKey("Escape")).toContain('"Escape"');
        expect(injectKey("ArrowUp")).toContain("38");
        expect(injectKey("PageDown")).toContain("34");
    });

    it("does not throw on a single character (Ctrl + punctuation from the key bar)", () => {
        for (const char of ["/", "-", "_", "|", "~", ":", ".", "*", "$", "&", "c"]) {
            expect(typeof injectKey(char, { ctrl: true })).toBe("string");
        }
    });

    it("carries the character and the ctrl modifier through", () => {
        const js = injectKey("c", { ctrl: true });
        expect(js).toContain('"c"');
        expect(js).toContain("ctrlKey:true");
    });

    it("passes the modifiers it was given", () => {
        expect(injectKey("Tab", { shift: true })).toContain("shiftKey:true");
        expect(injectKey("Tab")).toContain("shiftKey:false");
    });
});

describe("injectText", () => {
    it("goes through the shell's paste helper rather than a synthetic input event", () => {
        const js = injectText("echo hi");
        expect(js).toContain("__ddTtydPaste");
        expect(js).toContain('"echo hi"');
        expect(js).not.toContain("InputEvent");
    });

    it("encodes quotes and newlines so they cannot break out of the injected literal", () => {
        const js = injectText('a"b\nc');
        expect(js).toContain('\\"');
        expect(js).toContain("\\n");
        expect(js).not.toContain("\n");
    });
});
