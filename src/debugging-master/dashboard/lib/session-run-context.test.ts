import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardSession } from "@app/utils/log-viewer/log-source";
import { formatSessionHeaderParts } from "./session-run-context";

describe("formatSessionHeaderParts", () => {
    const base: DashboardSession = {
        source: "task",
        name: "metro",
        badge: "task",
        projectPath: "",
        createdAt: 0,
        lastActivityAt: 0,
        state: "active",
        stateLabel: "active",
    };

    it("collapses cwd and keeps command separate", () => {
        const parts = formatSessionHeaderParts({
            ...base,
            projectPath: join(homedir(), "Projects", "my-app"),
            command: "bun run dev",
        });

        expect(parts.cwd).toBe("~/Projects/my-app");
        expect(parts.command).toBe("bun run dev");
        expect(parts.title).toBe("[task] metro · ~/Projects/my-app · bun run dev");
    });

    it("does not treat command-only projectPath as cwd", () => {
        const parts = formatSessionHeaderParts({
            ...base,
            projectPath: "bun run dev",
            command: "bun run dev",
        });

        expect(parts.cwd).toBeUndefined();
        expect(parts.command).toBe("bun run dev");
    });
});
