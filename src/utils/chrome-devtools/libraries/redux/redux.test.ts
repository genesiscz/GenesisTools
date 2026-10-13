import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { SafeJSON } from "@genesiscz/utils/json";
import { reduxStateSize } from "./in-page/state-size.ts";

function runSize(window: Record<string, unknown>, args: Record<string, unknown>) {
    return runInNewContext(`(${reduxStateSize.toString()})(args)`, { window, args, TextEncoder });
}

const bytes = (value: unknown): number => new TextEncoder().encode(SafeJSON.stringify(value, { strict: true })).length;

describe("reduxStateSize (in-page)", () => {
    test("survives toString() in a clean context", () => {
        const source = reduxStateSize.toString();
        expect(source).not.toMatch(/__name\(|__require|__toESM|import\(/);
        expect(typeof runInNewContext(`(${source})`, {})).toBe("function");
    });

    test("splits the state into slices to the given depth, largest first, and exports chosen paths", () => {
        const state = {
            orders: { list: [1, 2, 3, 4, 5, 6, 7, 8], selected: null, empty: {} },
            user: { name: "Test" },
            ready: true,
        };
        const window = { __store: { getState: () => state } };

        const result = runSize(window, { slot: "__store", exportPaths: ["orders.list", "user.missing"] });

        expect(result.error).toBeUndefined();
        expect(result.bytes).toBe(bytes(state));
        expect(result.slices[0]).toEqual({ path: "orders.list", bytes: bytes(state.orders.list) });
        expect(result.slices.map((slice: { path: string }) => slice.path).sort()).toEqual(
            ["orders.empty", "orders.list", "orders.selected", "ready", "user.name"].sort()
        );
        expect(result.exported).toEqual({ "orders.list": state.orders.list, "user.missing": null });
    });

    test("depth 1 keeps top-level slices, and a value that does not serialize reports -1", () => {
        const window = { __store: { getState: () => ({ big: { a: 1 }, odd: { n: BigInt(1) } }) } };

        const result = runSize(window, { slot: "__store", depth: 1 });

        expect(result.bytes).toBe(-1);
        expect(result.slices).toContainEqual({ path: "odd", bytes: -1 });
        expect(result.slices).toContainEqual({ path: "big", bytes: bytes({ a: 1 }) });
    });

    test("reports a missing store instead of throwing", () => {
        expect(runSize({}, { slot: "__store" }).error).toBe("window.__store holds no Redux store");
    });
});
