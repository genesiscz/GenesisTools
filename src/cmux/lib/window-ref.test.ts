import { describe, expect, test } from "bun:test";
import { resolveWindowId } from "@app/cmux/lib/window-ref";
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

describe("resolveWindowId", () => {
    test("accepts the ref, the index and the uuid cmux list-windows prints", () => {
        const second = "31B2B301-4EFC-4718-9EAD-40D74FAAA24F";
        const first = "8AD47728-E4F9-4DF6-A040-8257EFA637A1";
        expect(resolveWindowId("window:3", windows)).toBe(second);
        expect(resolveWindowId("1", windows)).toBe(second);
        expect(resolveWindowId("0", windows)).toBe(first);
        expect(resolveWindowId("8ad47728-e4f9-4df6-a040-8257efa637a1", windows)).toBe(first);
        expect(resolveWindowId(" 31B2B301-4EFC-4718-9EAD-40D74FAAA24F ", windows)).toBe(second);
    });

    test("an unknown window lists the accepted forms and the open windows", () => {
        expect(() => resolveWindowId("window:9", windows)).toThrow(
            /No window matches --window window:9\. Pass a window ref, its index or its uuid[\s\S]*window:2 {2}index 0 {2}8AD47728[\s\S]*window:3 {2}index 1 {2}31B2B301/
        );
    });
});
