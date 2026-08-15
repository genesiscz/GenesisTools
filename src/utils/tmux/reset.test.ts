import { describe, expect, test } from "bun:test";
import { backupStamp, sanitize, selectResetTargets } from "@genesiscz/utils/tmux/reset";
import type { TmuxSessionSnapshot } from "@genesiscz/utils/tmux/snapshot";

function snap(name: string, attached = false): TmuxSessionSnapshot {
    return { name, cwd: "/tmp", attached, windows: [] };
}

describe("selectResetTargets", () => {
    test("rejects when both sessionId and matching are given", async () => {
        const result = await selectResetTargets({ sessionId: "foo", matching: "bar" }, async () => []);
        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error).toContain("not both");
        }
    });

    test("rejects when neither sessionId nor matching is given", async () => {
        const result = await selectResetTargets({}, async () => []);
        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error).toContain("<sessionId>");
        }
    });

    test("matching path captures by prefix and reports single=false", async () => {
        const captured = [snap("dev-1"), snap("dev-2", true)];
        const result = await selectResetTargets({ matching: "dev-" }, async (prefix) => {
            expect(prefix).toBe("dev-");
            return captured;
        });

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.targets.single).toBe(false);
            expect(result.targets.sessions).toHaveLength(2);
            expect(result.targets.label).toBe('prefix "dev-"');
            expect(result.targets.backupBase).toBe("reset-dev-");
        }
    });

    test("matching path errors when nothing matches", async () => {
        const result = await selectResetTargets({ matching: "ghost-" }, async () => []);
        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error).toContain("ghost-");
        }
    });

    test("sessionId path keeps only the exact match, dropping prefix siblings", async () => {
        const captured = [snap("api"), snap("api-worker"), snap("api-2")];
        const result = await selectResetTargets({ sessionId: "api" }, async () => captured);

        expect(result.ok).toBe(true);

        if (result.ok) {
            expect(result.targets.single).toBe(true);
            expect(result.targets.sessions).toHaveLength(1);
            expect(result.targets.sessions[0]?.name).toBe("api");
            expect(result.targets.label).toBe('session "api"');
        }
    });

    test("sessionId path errors when the exact session is absent", async () => {
        const captured = [snap("api-worker")];
        const result = await selectResetTargets({ sessionId: "api" }, async () => captured);

        expect(result.ok).toBe(false);

        if (!result.ok) {
            expect(result.error).toContain('"api"');
        }
    });
});

describe("helpers", () => {
    test("sanitize replaces unsafe runs with a single underscore", () => {
        expect(sanitize("dev/dashboard a:b")).toBe("dev_dashboard_a_b");
        expect(sanitize("clean-name_1.2")).toBe("clean-name_1.2");
    });

    test("backupStamp formats an injected date deterministically", () => {
        const stamp = backupStamp(new Date("2026-06-03T09:07:00"));
        expect(stamp).toBe("20260603-0907");
    });
});
