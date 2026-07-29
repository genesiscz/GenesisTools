import { describe, expect, it } from "bun:test";
import type { TerminalDriverComponent, DriverMeta } from "@/features/terminals/registry";
import { getDriverMeta, listDrivers, registerDriver, resolveDriver } from "@/features/terminals/registry";

/**
 * The registry's registration/lookup logic, tested with fake driver metas so no WebView (RN-native)
 * is pulled into the bun test runtime. The real drivers register themselves via `registerDriver` in
 * their own modules (imported only on-device); here we prove the Map semantics the switcher relies
 * on: list, lookup by id, and a safe fallback for an unknown id.
 */

// A stand-in component value; the registry only stores it, never renders it here.
const fakeComponent = (() => null) as unknown as TerminalDriverComponent;

const ttyd: DriverMeta = { id: "webview-ttyd", label: "ttyd (WebView)", blurb: "test", component: fakeComponent };
const html: DriverMeta = { id: "webview-html", label: "xterm.js (WebView)", blurb: "test", component: fakeComponent };

describe("terminal driver registry", () => {
    it("registers and lists both webview drivers", () => {
        registerDriver(ttyd);
        registerDriver(html);

        const ids = listDrivers()
            .map((d) => d.id)
            .filter((id) => id === "webview-ttyd" || id === "webview-html")
            .sort();

        expect(ids).toEqual(["webview-html", "webview-ttyd"]);
    });

    it("looks up a registered driver by id", () => {
        registerDriver(ttyd);

        expect(getDriverMeta("webview-ttyd")?.label).toBe("ttyd (WebView)");
    });

    it("does NOT register the reserved native escape hatch", () => {
        registerDriver(ttyd);
        registerDriver(html);

        expect(getDriverMeta("native")).toBeUndefined();
    });

    it("resolveDriver falls back to a registered driver for an unknown id", () => {
        registerDriver(ttyd);

        // "native" is unregistered → fallback to the first registered driver, not undefined.
        expect(resolveDriver("native")).toBeDefined();
    });
});
