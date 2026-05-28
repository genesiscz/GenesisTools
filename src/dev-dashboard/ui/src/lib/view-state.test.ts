import { beforeEach, describe, expect, test } from "bun:test";
import {
    canRemoveFromCmux,
    mergeStoredCmuxSurfaceSelection,
    pickStoredCmuxActivePaneId,
    pickStoredTtydActiveId,
    readCmuxViewState,
    writeCmuxViewState,
    writeTtydActiveId,
} from "@/lib/view-state";

describe("view-state", () => {
    beforeEach(() => {
        const store = new Map<string, string>();

        globalThis.localStorage = {
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
    });

    test("canRemoveFromCmux requires surfaces", () => {
        expect(canRemoveFromCmux({ cmuxSurfaces: [] })).toBe(false);
        expect(
            canRemoveFromCmux({
                cmuxSurfaces: [{ workspaceId: "w1", surfaceId: "s1", title: "dev" }],
            })
        ).toBe(true);
    });

    test("persists ttyd and cmux selections", () => {
        writeTtydActiveId("ttyd-1");
        expect(pickStoredTtydActiveId(["ttyd-1", "ttyd-2"])).toBe("ttyd-1");
        expect(pickStoredTtydActiveId(["ttyd-2"])).toBeNull();

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
