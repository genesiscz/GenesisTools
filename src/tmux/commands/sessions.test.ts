import { describe, expect, test } from "bun:test";
import { formatTtydBranchForTest, printSessionHeaderParts } from "./sessions-format";

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
        expect(formatTtydBranchForTest([{ id: "a", port: 1, label: "bridge", lastCommand: "claude" }])).toBe(
            "ttyd :1 bridge claude"
        );
    });
});
