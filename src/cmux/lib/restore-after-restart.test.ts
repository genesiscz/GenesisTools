import { describe, expect, test } from "bun:test";
import type { Profile } from "@app/cmux/lib/types";
import { PROFILE_VERSION } from "@app/cmux/lib/types";
import { filterReplayByAgents, isMissingEnumFlag, parseAgentList, parseRestoreSource } from "./restore-after-restart";

describe("parseRestoreSource", () => {
    test("accepts previous, live, profile", () => {
        expect(parseRestoreSource("previous")).toBe("previous");
        expect(parseRestoreSource("live")).toBe("live");
        expect(parseRestoreSource("profile")).toBe("profile");
        expect(parseRestoreSource("nope")).toBeUndefined();
    });
});

describe("parseAgentList", () => {
    test("defaults to all three agents", () => {
        expect(parseAgentList(undefined)).toEqual(["claude", "grok", "codex"]);
    });

    test("parses a subset", () => {
        expect(parseAgentList("grok,codex")).toEqual(["grok", "codex"]);
    });

    test("rejects an unknown name instead of dropping it", () => {
        expect(() => parseAgentList("nope")).toThrow(/got "nope"/);
        expect(() => parseAgentList("grok,foo")).toThrow(/got "grok,foo"/);
    });
});

describe("isMissingEnumFlag", () => {
    test("treats a bare commander true as missing", () => {
        expect(isMissingEnumFlag(true)).toBe(true);
        expect(isMissingEnumFlag("")).toBe(true);
        expect(isMissingEnumFlag("grok")).toBe(false);
        expect(isMissingEnumFlag(undefined)).toBe(false);
    });
});

describe("filterReplayByAgents", () => {
    const profile: Profile = {
        version: PROFILE_VERSION,
        name: "restart",
        scope: "all",
        captured_at: "2026-09-03T15:42:00.000Z",
        cmux_version: "test",
        windows: [
            {
                ref: "window:1",
                title: "Window 1",
                container_frame: { width: 100, height: 100 },
                workspaces: [
                    {
                        ref: "workspace:1",
                        title: "ws",
                        selected: true,
                        panes: [
                            {
                                ref: "pane:1",
                                index: 0,
                                columns: 80,
                                rows: 24,
                                pixel_frame: { x: 0, y: 0, width: 80, height: 24 },
                                selected_surface_index: 0,
                                surfaces: [
                                    {
                                        type: "terminal",
                                        title: "PRs merged - grok",
                                        command: "grok -r 01a05cc5-0ecf-7d40-945e-977e45b3f935",
                                    },
                                    {
                                        type: "terminal",
                                        title: "✳ Continue",
                                        command: "claude --resume 6bdfb457-cee9-4202-8105-21be8a801757",
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    test("drops grok resume commands when grok is not selected", () => {
        const filtered = filterReplayByAgents(profile, ["claude"]);
        const surfaces = filtered.windows[0]?.workspaces[0]?.panes[0]?.surfaces ?? [];
        expect(surfaces[0] && surfaces[0].type === "terminal" ? surfaces[0].command : "missing").toBeUndefined();
        expect(surfaces[1] && surfaces[1].type === "terminal" ? surfaces[1].command : "missing").toContain("claude");
    });
});
