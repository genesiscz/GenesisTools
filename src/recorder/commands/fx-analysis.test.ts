import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { clock, hidePrivateHint } from "./fx-analysis";

describe("the fx analysis commands' output", () => {
    // Review CLI-F6: the ISO slice dropped the hours, so a leak at 1:02:05 printed as 02:05.0.
    test("a time at or after an hour keeps its hours", () => {
        expect(clock(0)).toBe("00:00.0");
        expect(clock(65.2)).toBe("01:05.2");
        expect(clock(3599.9)).toBe("59:59.9");
        expect(clock(3725)).toBe("1:02:05.0");
        expect(clock(36_000)).toBe("10:00:00.0");
    });

    // Review CLI-F2: the hint dropped --names and --exclude-fixed, so the printed command left the names readable.
    test("the hide-them-all hint carries the names and exclude-fixed it listed with", () => {
        const op = (hint: string) => SafeJSON.parse(hint.match(/'(\{.*?\})'/)?.[1] ?? "{}", { strict: true });

        expect(op(hidePrivateHint("last", {}))).toEqual({ op: "hidePrivate" });
        expect(
            op(hidePrivateHint("last", { names: ["Alice Example", " ", "Bob Example"], excludeFixed: true }))
        ).toEqual({ op: "hidePrivate", names: ["Alice Example", "Bob Example"], excludeFixed: true });
        // The ids form names them too: the op finds the name hits only when it looks for the names.
        expect(hidePrivateHint("last", { names: ["Alice Example"] })).toContain('"names":["Alice Example"],"ids":[…]');
        // A quote in a name stays inside the shell's single quotes.
        expect(hidePrivateHint("last", { names: ["Ann O'Example"] })).toContain(`["Ann O'\\''Example"]`);
    });
});
