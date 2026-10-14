import { describe, expect, test } from "bun:test";
import { identityOf, placeOf } from "./place";

describe("identityOf", () => {
    test("reads every id and ref of the caller and the focus at once, and the app facts", () => {
        const identity = identityOf({
            socket_path: "/tmp/cmux.sock",
            bundle_identifier: "com.example.cmux",
            caller: {
                window_id: "W-1",
                window_ref: "window:1",
                workspace_id: "WS-2",
                workspace_ref: "workspace:2",
                pane_id: "P-3",
                pane_ref: "pane:3",
                surface_id: "S-4",
                surface_ref: "surface:4",
                surface_type: "terminal",
            },
            focused: { workspace_id: "WS-9", workspace_ref: "workspace:9" },
        });

        expect(identity).toEqual({
            socketPath: "/tmp/cmux.sock",
            bundleId: "com.example.cmux",
            caller: {
                windowId: "W-1",
                windowRef: "window:1",
                workspaceId: "WS-2",
                workspaceRef: "workspace:2",
                paneId: "P-3",
                paneRef: "pane:3",
                surfaceId: "S-4",
                surfaceRef: "surface:4",
                surfaceType: "terminal",
            },
            focused: { workspaceId: "WS-9", workspaceRef: "workspace:9" },
        });
    });

    test("an answer without a field leaves it unset, and garbage reads as no place", () => {
        expect(placeOf({ surface_ref: "surface:4", surface_id: "" })).toEqual({ surfaceRef: "surface:4" });
        expect(identityOf("not json")).toEqual({ caller: {}, focused: {} });
        expect(placeOf(null)).toEqual({});
    });
});
