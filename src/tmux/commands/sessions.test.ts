import { describe, expect, test } from "bun:test";
import { formatTtydBranch, printSessionHeaderParts } from "./sessions-format";

describe("tmux sessions ttyd formatting", () => {
    test("header parts include ttyd ports when bound", () => {
        const parts = printSessionHeaderParts("bridge", true, 1, [
            { id: "a", port: 60586, label: "bridge" },
            { id: "b", port: 60587, label: "bridge-2" },
        ]);
        expect(parts.ttyd).toBe(" · ttyd :60586 :60587");
        expect(parts.windows).toBe("1 window");
    });

    test("header parts omit ttyd when unbound", () => {
        expect(printSessionHeaderParts("solo", false, 2, undefined).ttyd).toBe("");
        expect(printSessionHeaderParts("solo", false, 2, []).ttyd).toBe("");
    });

    test("ttyd branch lists port + label", () => {
        expect(formatTtydBranch([{ id: "a", port: 1, label: "bridge", lastCommand: "claude" }])).toBe(
            "ttyd :1 bridge claude"
        );
    });

    test("ttyd branch applies the injected style to every segment", () => {
        const styled = formatTtydBranch([{ id: "a", port: 1, label: "bridge", lastCommand: "claude" }], {
            head: (v) => `<h>${v}</h>`,
            label: (v) => `<l>${v}</l>`,
            command: (v) => `<c>${v}</c>`,
            separator: (v) => `<s>${v}</s>`,
        });

        expect(styled).toBe("<h>ttyd</h> :1 <l>bridge</l> <c>claude</c>");
    });
});
