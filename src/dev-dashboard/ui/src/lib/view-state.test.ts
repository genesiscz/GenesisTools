import { beforeEach, describe, expect, test } from "bun:test";
import {
    canRemoveFromCmux,
    mergeStoredCmuxSurfaceSelection,
    pickStoredCmuxActivePaneId,
    pickStoredTtydActiveId,
    pickTtydActiveId,
    readCmuxViewState,
    ttydTabSearchHref,
    writeCmuxViewState,
    writeTtydActiveId,
} from "@/lib/view-state";

function mockStorage() {
    const store = new Map<string, string>();

    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, value);
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: () => null,
        length: 0,
    } as Storage;
}

describe("view-state", () => {
    beforeEach(() => {
        globalThis.localStorage = mockStorage();
        globalThis.sessionStorage = mockStorage();
    });

    test("canRemoveFromCmux requires surfaces", () => {
        expect(canRemoveFromCmux({ cmuxSurfaces: [] })).toBe(false);
        expect(
            canRemoveFromCmux({
                cmuxSurfaces: [{ workspaceId: "w1", surfaceId: "s1", title: "dev" }],
            })
        ).toBe(true);
    });

    test("persists ttyd per browser tab via sessionStorage", () => {
        writeTtydActiveId("ttyd-1");
        expect(pickStoredTtydActiveId(["ttyd-1", "ttyd-2"])).toBe("ttyd-1");
        expect(pickStoredTtydActiveId(["ttyd-2"])).toBeNull();
    });

    test("pickTtydActiveId prefers URL tab over sessionStorage", () => {
        writeTtydActiveId("ttyd-1");

        expect(
            pickTtydActiveId({
                sessionIds: ["ttyd-1", "ttyd-2"],
                urlTabId: "ttyd-2",
            })
        ).toBe("ttyd-2");

        expect(
            pickTtydActiveId({
                sessionIds: ["ttyd-1", "ttyd-2"],
            })
        ).toBe("ttyd-1");
    });

    test("ttydTabSearchHref encodes tab id", () => {
        expect(ttydTabSearchHref("ttyd/a")).toBe("/ttyd?tab=ttyd%2Fa");
    });

    test("persists cmux selections in localStorage", () => {
        writeCmuxViewState({
            activePaneId: "pane-2",
            surfaceByPaneId: { "pane-2": "surface-9" },
        });

        expect(readCmuxViewState().activePaneId).toBe("pane-2");
        expect(pickStoredCmuxActivePaneId(["pane-1", "pane-2"])).toBe("pane-2");
        expect(
            mergeStoredCmuxSurfaceSelection([
                {
                    id: "pane-2",
                    surfaces: [{ id: "surface-9" }, { id: "surface-10" }],
                },
            ])
        ).toEqual({ "pane-2": "surface-9" });
    });
});
