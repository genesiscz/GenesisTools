import { describe, expect, test } from "bun:test";
import { executeBuiltin } from "./builtins";
import type { ExecutionContext } from "./types";

const ctx: ExecutionContext = { vars: {}, steps: {}, env: {} };

describe("handleShell timeout cleanup", () => {
    test("the spawned process is confirmed exited before the timeout error propagates", async () => {
        const marker = `automate-shell-sleep-${Date.now()}`;

        try {
            await executeBuiltin(
                {
                    id: "timeout-test",
                    name: "timeout test",
                    action: "shell",
                    params: { command: `sleep 30 # ${marker}`, timeout: 1 },
                },
                ctx
            );
            throw new Error("expected timeout");
        } catch (err) {
            expect(String(err)).toContain("timed out");
        }

        await new Promise((r) => setTimeout(r, 200));
        const after = Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim();
        expect(after).toBe("");
    });
});
