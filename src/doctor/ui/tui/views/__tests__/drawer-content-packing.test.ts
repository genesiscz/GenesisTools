import { describe, expect, it } from "bun:test";
import type { Action, Finding } from "@app/doctor/lib/types";
import { RGBA } from "@opentui/core";
import { viewForAnalyzer } from "../index";
import { toNativeContent, toRgba } from "../native-content";

// Regression guard: text_table packs cell chunks via Bun FFI and expects
// `fg`/`bg` to be RGBA instances (not hex strings). If the drawer ever
// feeds raw hex back into TextTableRenderable.content, Bun throws
// "Failed to parse String to BigInt" at BigInt(val) inside the pointer
// packer. We validate the RGBA conversion at the drawer boundary.

const killAction: Action = {
    id: "kill",
    label: "kill",
    confirm: "none",
    execute: async (_ctx, finding) => ({ findingId: finding.id, actionId: "kill", status: "ok" }),
};

const diskFinding: Finding = {
    id: "disk-trash",
    analyzerId: "disk-space",
    title: "~/.Trash - 123 MB",
    severity: "safe",
    reclaimableBytes: 123 * 1024 * 1024,
    actions: [killAction],
    metadata: { path: "/Users/x/.Trash" },
};

const memFinding: Finding = {
    id: "mem-rss-42",
    analyzerId: "memory",
    title: "PID 42",
    severity: "cautious",
    reclaimableBytes: 200 * 1024 * 1024,
    actions: [killAction],
    metadata: { pid: 42, comm: "chrome", rssBytes: 200 * 1024 * 1024, label: "Chrome" },
};

describe("drawer content packing", () => {
    it("toRgba converts hex strings to RGBA, passes through undefined", () => {
        expect(toRgba(undefined)).toBeUndefined();

        const rgba = toRgba("#7aa2f7");
        expect(rgba).toBeInstanceOf(RGBA);
        expect(rgba?.buffer).toBeInstanceOf(Float32Array);
        expect(rgba?.buffer.length).toBe(4);
    });

    it("toRgba caches instances so equal hex strings share an RGBA", () => {
        const a = toRgba("#9ece6a");
        const b = toRgba("#9ece6a");
        expect(a).toBe(b);
    });

    it("toNativeContent replaces every fg/bg hex string with an RGBA instance", () => {
        const view = viewForAnalyzer("disk-space");
        const result = view({ findings: [diskFinding], selected: new Set(), cursor: 0, viewportRows: 5 });
        const native = toNativeContent(result.actionable.rows) as unknown as Array<
            Array<Array<{ text: string; fg?: unknown; bg?: unknown }>>
        >;

        expect(native.length).toBeGreaterThan(0);

        for (const row of native) {
            for (const cell of row) {
                for (const chunk of cell) {
                    expect(typeof chunk.text).toBe("string");

                    if (chunk.fg !== undefined) {
                        expect(chunk.fg).toBeInstanceOf(RGBA);
                        expect((chunk.fg as RGBA).buffer).toBeInstanceOf(Float32Array);
                    }

                    if (chunk.bg !== undefined) {
                        expect(chunk.bg).toBeInstanceOf(RGBA);
                        expect((chunk.bg as RGBA).buffer).toBeInstanceOf(Float32Array);
                    }
                }
            }
        }
    });

    it("holds the invariant across every analyzer view", () => {
        const analyzerIds = [
            "disk-space",
            "memory",
            "processes",
            "dev-caches",
            "system-caches",
            "startup",
            "brew",
            "battery",
            "network",
            "security",
        ];

        for (const id of analyzerIds) {
            const view = viewForAnalyzer(id);
            const findings = id === "memory" ? [memFinding] : [diskFinding];
            const result = view({ findings, selected: new Set(), cursor: 0, viewportRows: 5 });
            const native = toNativeContent(result.actionable.rows) as unknown as Array<
                Array<Array<{ fg?: unknown; bg?: unknown }>>
            >;

            for (const row of native) {
                for (const cell of row) {
                    for (const chunk of cell) {
                        if (chunk.fg !== undefined) {
                            expect(chunk.fg).toBeInstanceOf(RGBA);
                        }
                        if (chunk.bg !== undefined) {
                            expect(chunk.bg).toBeInstanceOf(RGBA);
                        }
                    }
                }
            }
        }
    });
});
