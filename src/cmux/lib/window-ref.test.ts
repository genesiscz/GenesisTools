import { describe, expect, test } from "bun:test";
import { resolveWindowRef } from "@app/cmux/lib/window-ref";
import type { WindowEntry } from "@genesiscz/utils/cmux/lib/socket";

const windows: WindowEntry[] = [
    {
        ref: "window:2",
        id: "8AD47728-E4F9-4DF6-A040-8257EFA637A1",
        index: 0,
        visible: true,
        key: true,
        workspace_count: 2,
    },
    {
        ref: "window:3",
        id: "31B2B301-4EFC-4718-9EAD-40D74FAAA24F",
        index: 1,
        visible: true,
        key: false,
        workspace_count: 8,
    },
];

describe("resolveWindowRef", () => {
    test("accepts the ref, the index and the uuid cmux list-windows prints", () => {
        expect(resolveWindowRef("window:3", windows)).toBe("window:3");
        expect(resolveWindowRef("1", windows)).toBe("window:3");
        expect(resolveWindowRef("0", windows)).toBe("window:2");
        expect(resolveWindowRef("8ad47728-e4f9-4df6-a040-8257efa637a1", windows)).toBe("window:2");
        expect(resolveWindowRef(" 31B2B301-4EFC-4718-9EAD-40D74FAAA24F ", windows)).toBe("window:3");
    });

    test("an unknown window lists the accepted forms and the open windows", () => {
        expect(() => resolveWindowRef("window:9", windows)).toThrow(
            /No window matches --window window:9\. Pass a window ref, its index or its uuid[\s\S]*window:2 {2}index 0 {2}8AD47728[\s\S]*window:3 {2}index 1 {2}31B2B301/
        );
    });
});
