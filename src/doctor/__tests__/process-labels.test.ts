import { describe, expect, it } from "bun:test";
import { labelForProcess } from "@app/doctor/lib/process-labels";

describe("labelForProcess", () => {
    it("labels macOS internals", () => {
        expect(labelForProcess({ comm: "kernel_task", command: "kernel_task" })).toBe("macOS kernel");
        expect(labelForProcess({ comm: "WindowServer", command: "WindowServer" })).toBe("macOS graphics");
        expect(labelForProcess({ comm: "mds_stores", command: "mds_stores" })).toBe("Spotlight index");
    });

    it("labels dev tooling", () => {
        expect(labelForProcess({ comm: "tsgo", command: "/path/lib/tsgo" })).toBe("TS compiler");
        expect(labelForProcess({ comm: "bun", command: "bun run" })).toBe("Bun runtime");
        expect(labelForProcess({ comm: "node", command: "node /path/server.js" })).toBe("Node.js runtime");
    });

    it("labels app helpers from Applications path", () => {
        expect(
            labelForProcess({
                comm: "Cursor Helper (Renderer)",
                command: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/...",
            })
        ).toBe("Cursor editor");
        expect(
            labelForProcess({
                comm: "GitKraken Helper (Renderer)",
                command: "/Applications/GitKraken.app/.../GitKraken Helper (Renderer)",
            })
        ).toBe("GitKraken app");
        expect(
            labelForProcess({
                comm: "Brave Browser",
                command: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            })
        ).toBe("Brave browser");
    });

    it("returns null for unknown processes", () => {
        expect(labelForProcess({ comm: "totally-unknown-xyz", command: "totally-unknown-xyz --foo" })).toBeNull();
    });

    it("labels our own tools", () => {
        expect(labelForProcess({ comm: "claude", command: "/usr/local/bin/claude" })).toBe("Claude Code");
        expect(labelForProcess({ comm: "tools", command: "tools doctor" })).toBe("GenesisTools CLI");
    });
});
